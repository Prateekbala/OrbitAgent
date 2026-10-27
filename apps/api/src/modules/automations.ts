import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  automationCreate,
  automationRevision,
  automationControl,
  automationReplay,
  automationTransfer,
  automationDefinition,
} from '@ao/contracts/automations';
import {
  AutomationService,
  automation,
  automationManager,
  stopOccurrences,
  validateAutomation,
} from '../automations/service.js';
import { authenticate } from './auth.js';
import { AppError, notFound } from '../lib/errors.js';
import { taskActor } from '../tasks/service.js';
import { workAuthority } from '../workflows/service.js';
import { recordChange } from '../lib/events.js';
const page = z
  .object({
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export function automationRoutes(app: FastifyInstance, db: Database) {
  const service = new AutomationService(db),
    param = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.post('/v1/automations', async (req) =>
    service.create(await authenticate(db, req), automationCreate.parse(req.body)),
  );
  app.get('/v1/automations', async (req) => {
    const p = await authenticate(db, req),
      q = page.parse(req.query);
    const rows = await db.query(
      'SELECT id,name,owner_id,conversation_id,revision,version,status,next_at,transfer_to,created_at FROM automations WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
      [p.workspaceId, q.after ?? null, q.limit + 1],
    );
    return {
      items: rows.slice(0, q.limit),
      next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
  app.get('/v1/automations/:id', async (req) =>
    service.detail(await authenticate(db, req), param(req.params)),
  );
  app.post('/v1/automations/:id/revisions', async (req) =>
    service.revise(
      await authenticate(db, req),
      param(req.params),
      automationRevision.parse(req.body),
    ),
  );
  app.post('/v1/automations/:id/control', async (req) => {
    const p = await authenticate(db, req),
      v = automationControl.parse(req.body);
    return service.control(p, param(req.params), v.version, v.action);
  });
  for (const kind of ['history', 'revisions'] as const)
    app.get(`/v1/automations/:id/${kind}`, async (req) => {
      const p = await authenticate(db, req),
        id = param(req.params);
      await automation(db, p, id);
      if (kind === 'revisions') {
        const q = z
          .object({
            before: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(25),
          })
          .strict()
          .parse(req.query);
        const rows = await db.query(
          'SELECT revision,definition,created_by,created_at FROM automation_versions WHERE workspace_id=$1 AND automation_id=$2 AND ($3::int IS NULL OR revision<$3) ORDER BY revision DESC LIMIT $4',
          [p.workspaceId, id, q.before ?? null, q.limit + 1],
        );
        return {
          items: rows.slice(0, q.limit),
          next_before: rows.length > q.limit ? rows[q.limit - 1]!.revision : null,
        };
      }
      const q = page.parse(req.query),
        rows = await db.query(
          `SELECT o.*,r.result->>'suppressionReason' suppression_reason FROM automation_occurrences o LEFT JOIN agent_runs r ON r.workspace_id=o.workspace_id AND r.id=o.agent_run_id WHERE o.workspace_id=$1 AND o.automation_id=$2 AND ($3::uuid IS NULL OR (o.created_at,o.id)<(SELECT c.created_at,c.id FROM automation_occurrences c WHERE c.workspace_id=$1 AND c.id=$3)) ORDER BY o.created_at DESC,o.id DESC LIMIT $4`,
          [p.workspaceId, id, q.after ?? null, q.limit + 1],
        );
      return {
        items: rows.slice(0, q.limit),
        next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      };
    });
  app.post('/v1/automation-occurrences/:id/replay', async (req) => {
    let p = await authenticate(db, req);
    const id = param(req.params),
      input = automationReplay.parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      p = await taskActor(tx, p, false);
      const [o] = await tx.query(
        'SELECT * FROM automation_occurrences WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [p.workspaceId, id],
      );
      if (!o) throw notFound();
      const a = await automation(tx, p, String(o.automation_id), true);
      automationManager(p, a.owner_id);
      if (
        a.status !== 'active' ||
        !['failed', 'skipped', 'cancelled', 'succeeded'].includes(String(o.status))
      )
        throw new AppError(
          409,
          'REPLAY_NOT_ALLOWED',
          'Review an active automation and a terminal, reconciled occurrence before replay.',
        );
      const [uncertain] = await tx.query(
        "SELECT r.id FROM agent_runs r WHERE r.workspace_id=$1 AND (r.automation_occurrence_id=$4 OR r.id=$2 OR r.id IN (SELECT nullif(s.output->>'runId','')::uuid FROM workflow_steps s WHERE s.workspace_id=$1 AND s.run_id=$3)) AND (r.status='outcome_unknown' OR (r.dispatch_started AND EXISTS(SELECT 1 FROM execution_reservations e WHERE e.workspace_id=r.workspace_id AND e.run_id=r.id AND e.state='reserved')) OR EXISTS(SELECT 1 FROM tool_actions a JOIN tool_invocations i ON i.workspace_id=a.workspace_id AND i.id=a.invocation_id WHERE i.workspace_id=r.workspace_id AND i.run_id=r.id AND a.state IN ('dispatched','outcome_unknown'))) LIMIT 1",
        [p.workspaceId, o.agent_run_id, o.workflow_run_id, o.id],
      );
      if (uncertain)
        throw new AppError(
          409,
          'OUTCOME_UNRESOLVED',
          'Reconcile external execution before replaying.',
        );
      const key = 'replay:' + input.clientId,
        [old] = await tx.query(
          'SELECT id,replay_of,replay_reason FROM automation_occurrences WHERE workspace_id=$1 AND automation_id=$2 AND occurrence_key=$3',
          [p.workspaceId, a.id, key],
        );
      if (old) {
        if (old.replay_of !== id || old.replay_reason !== input.reason)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This replay key was used for another request.',
          );
        return { id: old.id, replayed: true };
      }
      const next = randomUUID();
      await tx.query(
        'INSERT INTO automation_occurrences(id,workspace_id,automation_id,revision,occurrence_key,scheduled_at,replay_of,replay_reason,created_by) VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6,$7,$8)',
        [next, p.workspaceId, a.id, a.revision, key, id, input.reason, p.membershipId],
      );
      await recordChange(
        tx,
        p,
        'automation.replayed',
        String(a.id),
        String(a.conversation_id),
        String(a.owner_id),
      );
      return { id: next, replayed: false };
    });
  });
  app.post('/v1/automations/:id/transfer', async (req) => {
    let p = await authenticate(db, req);
    const id = param(req.params),
      input = automationTransfer.parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      p = await taskActor(tx, p, false);
      const a = await automation(tx, p, id, true);
      automationManager(p, a.owner_id);
      service.version(a, input.version);
      const [target] = await tx.query(
        "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND kind='human' AND access_type='member' AND status='active' AND resource_visible_to($1,$3,now(),id) AND coalesce((permissions->>'execution.manage')::boolean,true)",
        [p.workspaceId, input.membershipId, a.conversation_id],
      );
      if (!target || input.membershipId === a.owner_id)
        throw new AppError(
          400,
          'INVALID_OWNER',
          'Choose another member with conversation and execution access.',
        );
      await stopOccurrences(tx, p.workspaceId, id, 'ownership_transfer');
      await tx.query(
        "UPDATE automations SET status='paused',next_at=NULL,transfer_to=$3,transfer_version=revision,version=version+1 WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id, input.membershipId],
      );
      await recordChange(
        tx,
        p,
        'automation.transfer_requested',
        id,
        String(a.conversation_id),
        input.membershipId,
      );
      return { version: input.version + 1 };
    });
  });
  app.post('/v1/automations/:id/transfer/accept', async (req) => {
    let p = await authenticate(db, req);
    const id = param(req.params),
      input = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      p = await taskActor(tx, p, false);
      automationManager(p);
      const a = await automation(tx, p, id, true);
      service.version(a, input.version);
      if (a.transfer_to !== p.membershipId || a.transfer_version !== a.revision)
        throw new AppError(
          409,
          'TRANSFER_CHANGED',
          'This ownership offer changed or belongs to another member.',
        );
      await validateAutomation(tx, p, automationDefinition.parse(a.definition));
      const authority = await workAuthority(tx, p);
      await tx.query(
        'UPDATE automations SET owner_id=$3,owner_auth_version=$4,policy_version=$5,transfer_to=NULL,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, p.membershipId, authority.auth, authority.policy],
      );
      await recordChange(
        tx,
        p,
        'automation.transferred',
        id,
        String(a.conversation_id),
        p.membershipId,
      );
      return { version: input.version + 1 };
    });
  });
}
