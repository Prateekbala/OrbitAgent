import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { identityScope, type Database } from '@ao/database';
import { z } from 'zod';
import {
  id,
  accessInput,
  offboardInput,
  serviceAccountInput,
  permissionOverrides,
} from '@ao/contracts';
import { authenticate } from './auth.js';
import { requireAdmin } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest, token } from '../lib/security.js';
import { recordChange } from '../lib/events.js';
import { offboardWorkspace } from '../identity/offboarding.js';
import { revokeMemberMachines } from '../identity/machine-credentials.js';
export function memberAccessRoutes(app: FastifyInstance, db: Database) {
  async function owner(actor: Awaited<ReturnType<typeof authenticate>>) {
    requireAdmin(actor);
    if (actor.role !== 'owner')
      throw new AppError(
        403,
        'OWNER_REQUIRED',
        'A workspace owner must manage access policies and service accounts.',
      );
  }
  app.put('/v1/members/:id/access', async (req) => {
    const actor = await authenticate(db, req);
    await owner(actor);
    const target = id.parse((req.params as { id: string }).id),
      input = accessInput.parse(req.body);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [actor.workspaceId]);
      const [currentActor] = await tx.query(
        "SELECT id FROM memberships WHERE id=$1 AND role='owner' AND status='active' FOR SHARE",
        [actor.membershipId],
      );
      if (!currentActor) throw new AppError(403, 'OWNER_REQUIRED', 'Your owner access changed.');
      const [member] = await tx.query('SELECT * FROM memberships WHERE workspace_id=$1 AND id=$2', [
        actor.workspaceId,
        target,
      ]);
      if (!member) throw notFound();
      if (member.kind !== 'human' || member.role !== 'member')
        throw new AppError(
          409,
          'FULL_MEMBER_REQUIRED',
          'Only human members can be converted to guests or assigned overrides.',
        );
      if (member.version !== input.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'Refresh team membership.');
      for (const conversation of [...new Set(input.conversationIds)].sort()) {
        const [row] = await tx.query(
          "SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2 AND kind<>'direct' FOR SHARE",
          [conversation, actor.workspaceId],
        );
        if (!row) throw notFound();
      }
      if (input.accessType === 'guest' && !input.conversationIds.length)
        throw new AppError(
          400,
          'GUEST_SCOPE_REQUIRED',
          'Share at least one conversation with a guest.',
        );
      if (input.accessType === 'guest') {
        const [owned] = await tx.query(
          'SELECT id FROM projects WHERE workspace_id=$1 AND owner_id=$2',
          [actor.workspaceId, target],
        );
        const [workspaceTask] = await tx.query(
          'SELECT id FROM tasks WHERE workspace_id=$1 AND assignee_id=$2 AND conversation_id IS NULL',
          [actor.workspaceId, target],
        );
        if (owned || workspaceTask)
          throw new AppError(
            409,
            'TRANSFER_WORK_REQUIRED',
            'Transfer project ownership and unscoped task assignments before converting this member to a guest.',
          );
        await tx.query(
          'DELETE FROM conversation_members WHERE workspace_id=$1 AND membership_id=$2 AND NOT(conversation_id=ANY($3::uuid[]))',
          [actor.workspaceId, target, input.conversationIds],
        );
      }
      for (const conversation of input.conversationIds)
        await tx.query(
          'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [actor.workspaceId, conversation, target],
        );
      await tx.query('DELETE FROM sessions WHERE workspace_id=$1 AND membership_id=$2', [
        actor.workspaceId,
        target,
      ]);
      const runs = await tx.query(
        "SELECT id FROM agent_runs WHERE workspace_id=$1 AND requester_id=$2 AND status IN ('queued','running','awaiting_approval','outcome_unknown') ORDER BY id FOR UPDATE",
        [actor.workspaceId, target],
      );
      for (const run of runs) {
        await tx.query(
          "UPDATE agent_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [run.id],
        );
        await tx.query(
          "UPDATE tool_invocations SET status='cancelled' WHERE run_id=$1 AND status IN ('pending','approved')",
          [run.id],
        );
      }
      if (input.accessType === 'guest' || input.permissions['agents.manage'] === false)
        await revokeMemberMachines(tx, actor.workspaceId, target);
      await tx.query(
        'UPDATE memberships SET access_type=$3,permissions=$4,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [actor.workspaceId, target, input.accessType, input.permissions],
      );
      await recordChange(tx, actor, 'member.access_updated', target);
    });
    return { ok: true };
  });
  app.post('/v1/members/:id/offboard', async (req) => {
    const actor = await authenticate(db, req);
    requireAdmin(actor);
    const target = id.parse((req.params as { id: string }).id),
      input = offboardInput.parse(req.body);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [actor.workspaceId]);
      const [current] = await tx.query(
        "SELECT role FROM memberships WHERE id=$1 AND status='active'",
        [actor.membershipId],
      );
      const [member] = await tx.query('SELECT * FROM memberships WHERE workspace_id=$1 AND id=$2', [
        actor.workspaceId,
        target,
      ]);
      if (!member) throw notFound();
      if (
        !current ||
        !['owner', 'admin'].includes(String(current.role)) ||
        (current.role !== 'owner' && member.role !== 'member')
      )
        throw new AppError(
          403,
          'OWNER_REQUIRED',
          'An owner must offboard administrators and owners.',
        );
      if (member.version !== input.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'Refresh the member before offboarding.');
      await offboardWorkspace(tx, actor.workspaceId, target, input.successorId);
      await recordChange(tx, actor, 'member.offboarded', target);
    });
    return { ok: true };
  });
  app.post('/v1/workspaces/transfer-ownership', async (req) => {
    const actor = await authenticate(db, req);
    await owner(actor);
    const input = z.object({ membershipId: id }).strict().parse(req.body);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [actor.workspaceId]);
      const [current] = await tx.query(
        "SELECT id FROM memberships WHERE id=$1 AND role='owner' AND status='active'",
        [actor.membershipId],
      );
      if (!current) throw new AppError(403, 'OWNER_REQUIRED', 'Your owner access changed.');
      if (input.membershipId === actor.membershipId)
        throw new AppError(400, 'INVALID_SUCCESSOR', 'Choose another member.');
      const [next] = await tx.query(
        "SELECT id FROM memberships WHERE id=$1 AND workspace_id=$2 AND kind='human' AND access_type='member' AND status='active' FOR SHARE",
        [input.membershipId, actor.workspaceId],
      );
      if (!next) throw notFound();
      await tx.query(
        "UPDATE memberships SET role=CASE WHEN id=$2 THEN 'owner' ELSE 'admin' END,version=version+1 WHERE workspace_id=$1 AND id IN ($2,$3)",
        [actor.workspaceId, input.membershipId, actor.membershipId],
      );
      await recordChange(tx, actor, 'workspace.ownership_transferred', input.membershipId);
    });
    return { ok: true };
  });
  app.get('/v1/service-accounts', async (req) => {
    const actor = await authenticate(db, req);
    await owner(actor);
    return identityScope(() =>
      db.query(
        'SELECT c.id,c.membership_id,m.name,m.permissions,m.status,c.label,c.created_at,c.expires_at,c.revoked_at,c.last_used_at FROM service_credentials c JOIN memberships m ON m.id=c.membership_id WHERE c.workspace_id=$1 ORDER BY c.created_at DESC LIMIT 200',
        [actor.workspaceId],
      ),
    );
  });
  app.post('/v1/service-accounts', async (req, reply) => {
    const actor = await authenticate(db, req);
    await owner(actor);
    const input = serviceAccountInput.parse(req.body),
      member = randomUUID(),
      credential = randomUUID(),
      value = token();
    const scopes = permissionOverrides.parse(
      Object.fromEntries(input.permissions.map((p) => [p, true])),
    );
    if (input.permissions.some((p) => p.endsWith('.manage')))
      throw new AppError(
        400,
        'SERVICE_PERMISSION_RESTRICTED',
        'Service accounts cannot administer people, agents, execution, or workspace security.',
      );
    await identityScope(
      () =>
        db.transaction(async (tx) => {
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [actor.workspaceId]);
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [actor.workspaceId]);
          const [current] = await tx.query(
            "SELECT id FROM memberships WHERE id=$1 AND role='owner' AND status='active' FOR SHARE",
            [actor.membershipId],
          );
          if (!current) throw new AppError(403, 'OWNER_REQUIRED', 'Your owner access changed.');
          await tx.query(
            "INSERT INTO memberships(id,workspace_id,name,kind,role,access_type,permissions) VALUES($1,$2,$3,'agent','member','service',$4)",
            [member, actor.workspaceId, input.name, scopes],
          );
          await tx.query(
            'INSERT INTO service_credentials(id,workspace_id,membership_id,token_hash,label,expires_at,created_by) VALUES($1,$2,$3,$4,$5,now()+$6::interval,$7)',
            [
              credential,
              actor.workspaceId,
              member,
              digest(value),
              input.name,
              `${input.expiresInDays} days`,
              actor.membershipId,
            ],
          );
          await tx.query('SET LOCAL ROLE ao_runtime');
          for (const conversation of input.conversationIds) {
            const [row] = await tx.query(
              'SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR SHARE',
              [actor.workspaceId, conversation],
            );
            if (!row) throw notFound();
            await tx.query(
              'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
              [actor.workspaceId, conversation, member],
            );
          }
          await recordChange(tx, actor, 'service_account.created', member);
        }),
      actor.workspaceId,
    );
    return reply.code(201).send({ id: credential, membershipId: member, token: value });
  });
  app.delete('/v1/service-accounts/:id', async (req) => {
    const actor = await authenticate(db, req);
    await owner(actor);
    const credential = id.parse((req.params as { id: string }).id);
    await identityScope(
      () =>
        db.transaction(async (tx) => {
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [actor.workspaceId]);
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [actor.workspaceId]);
          const [current] = await tx.query(
            "SELECT id FROM memberships WHERE id=$1 AND role='owner' AND status='active' FOR SHARE",
            [actor.membershipId],
          );
          if (!current) throw new AppError(403, 'OWNER_REQUIRED', 'Your owner access changed.');
          const [row] = await tx.query(
            'UPDATE service_credentials SET revoked_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING membership_id',
            [actor.workspaceId, credential],
          );
          if (!row) throw notFound();
          await tx.query(
            "UPDATE memberships SET status='suspended',version=version+1 WHERE id=$1",
            [row.membership_id],
          );
          await recordChange(tx, actor, 'service_account.revoked', String(row.membership_id));
        }),
      actor.workspaceId,
    );
    return { ok: true };
  });
}
