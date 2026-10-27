import { fenceWorkflowAgents } from '../workflows/fencing.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import { id } from '@ao/contracts';
import {
  templateInput,
  templateRevision,
  templatePublish,
  workflowStart,
  triggerInput,
  workflowDecision,
  replayInput,
  workPage,
  revision,
} from '@ao/contracts/workflows';
import { authenticate } from './auth.js';
import { WorkflowService, getTemplate, workManager } from '../workflows/service.js';
import { taskActor } from '../tasks/service.js';
import { workVersion } from '../tasks/work.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
export function workflowRoutes(app: FastifyInstance, db: Database) {
  const service = new WorkflowService(db),
    param = (p: unknown) => id.parse((p as { id: string }).id);
  app.post('/v1/work-templates', async (req) =>
    service.create(await authenticate(db, req), templateInput.parse(req.body)),
  );
  app.post('/v1/work-templates/:id/revisions', async (req) =>
    service.revise(
      await authenticate(db, req),
      param(req.params),
      templateRevision.parse(req.body),
    ),
  );
  app.put('/v1/work-templates/:id/publication', async (req) =>
    service.publish(
      await authenticate(db, req),
      param(req.params),
      templatePublish.parse(req.body),
    ),
  );
  app.post('/v1/work-templates/:id/start', async (req) =>
    service.start(await authenticate(db, req), param(req.params), workflowStart.parse(req.body)),
  );
  app.post('/v1/workflow-triggers', async (req) =>
    service.trigger(await authenticate(db, req), triggerInput.parse(req.body)),
  );
  app.post('/v1/workflow-runs/:id/replay', async (req) => {
    const p = await authenticate(db, req),
      v = replayInput.parse(req.body);
    return service.replay(p, param(req.params), v.clientId, v.version);
  });
  for (const kind of [
    'work-templates',
    'workflow-runs',
    'workflow-triggers',
    'workflow-notices',
  ] as const)
    app.get('/v1/' + kind, async (req) => {
      const p = await authenticate(db, req),
        q = workPage.parse(req.query);
      const from =
        kind === 'work-templates'
          ? 'work_templates r'
          : kind === 'workflow-runs'
            ? 'workflow_runs r JOIN work_templates t ON t.workspace_id=r.workspace_id AND t.id=r.template_id'
            : kind === 'workflow-triggers'
              ? 'workflow_triggers r JOIN work_templates t ON t.workspace_id=r.workspace_id AND t.id=r.template_id'
              : 'workflow_notices r JOIN workflow_runs wr ON wr.workspace_id=r.workspace_id AND wr.id=r.run_id JOIN work_templates t ON t.workspace_id=wr.workspace_id AND t.id=wr.template_id';
      const rows = await db.query(
          `SELECT r.*${kind !== 'work-templates' ? ',t.name template_name' : ''} FROM ${from} WHERE r.workspace_id=$1 AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT $3`,
          [p.workspaceId, q.after ?? null, q.limit + 1],
        ),
        items = rows.slice(0, q.limit);
      return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
    });
  app.get('/v1/work-templates/:id', async (req) => {
    const p = await authenticate(db, req),
      template = await getTemplate(db, p, param(req.params));
    const q = z
        .object({ revision: z.coerce.number().int().min(1).max(2147483646).optional() })
        .strict()
        .parse(req.query),
      [v] = await db.query(
        'SELECT definition,created_at FROM work_template_versions WHERE workspace_id=$1 AND template_id=$2 AND revision=$3',
        [p.workspaceId, template.id, q.revision ?? template.latest_revision],
      );
    if (!v) throw notFound();
    return { ...template, ...v };
  });
  app.get('/v1/work-templates/:id/revisions', async (req) => {
    const p = await authenticate(db, req),
      template = await getTemplate(db, p, param(req.params)),
      q = z
        .object({
          before: z.coerce.number().int().min(1).max(2147483646).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .strict()
        .parse(req.query);
    const rows = await db.query(
      'SELECT revision,definition,created_by,created_at FROM work_template_versions WHERE workspace_id=$1 AND template_id=$2 AND ($3::integer IS NULL OR revision<$3) ORDER BY revision DESC LIMIT $4',
      [p.workspaceId, template.id, q.before ?? null, q.limit + 1],
    );
    return {
      items: rows.slice(0, q.limit),
      next_before: rows.length > q.limit ? rows[q.limit - 1]!.revision : null,
    };
  });
  app.get('/v1/workflow-runs/:id', async (req) => {
    const p = await authenticate(db, req),
      id = param(req.params),
      [run] = await db.query(
        'SELECT r.*,t.name template_name FROM workflow_runs r JOIN work_templates t ON t.workspace_id=r.workspace_id AND t.id=r.template_id WHERE r.workspace_id=$1 AND r.id=$2',
        [p.workspaceId, id],
      );
    if (!run) throw notFound();
    const steps = await db.query(
      `SELECT s.*,coalesce(step.value->>'title',CASE step.value->>'type' WHEN 'approval' THEN 'Human approval' WHEN 'transition_task' THEN 'Change task state' WHEN 'wait_for_task' THEN 'Wait for task' WHEN 'run_agent' THEN 'Agent execution' ELSE 'Workflow step' END) label FROM workflow_steps s JOIN workflow_runs r ON r.workspace_id=s.workspace_id AND r.id=s.run_id JOIN work_template_versions v ON v.workspace_id=r.workspace_id AND v.template_id=r.template_id AND v.revision=r.template_revision CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') WITH ORDINALITY step(value,ordinal) WHERE s.workspace_id=$1 AND s.run_id=$2 AND step.value->>'key'=s.step_key ORDER BY step.ordinal`,
      [p.workspaceId, id],
    );
    return { ...run, steps };
  });
  for (const action of ['decision', 'cancel'] as const)
    app.post(`/v1/workflow-runs/:id/${action}`, async (req) => {
      let p = await authenticate(db, req);
      const id = param(req.params),
        input =
          action === 'decision'
            ? workflowDecision.parse(req.body)
            : z.object({ version: revision }).strict().parse(req.body);
      return db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        p = await taskActor(tx, p);
        const [run] = await tx.query(
          'SELECT * FROM workflow_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [p.workspaceId, id],
        );
        if (!run) throw notFound();
        workManager(p, run.created_by);
        workVersion(Number(run.version), input.version);
        if (!['queued', 'running', 'waiting'].includes(String(run.status)))
          throw new AppError(409, 'WORKFLOW_CLOSED', 'This workflow is already closed.');
        if (action === 'cancel') {
          await fenceWorkflowAgents(tx, p.workspaceId, id);
          await tx.query(
            "UPDATE workflow_runs SET status='cancelled',version=version+1,finished_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, id],
          );
        } else {
          const [step] = await tx.query(
            "SELECT s.step_key FROM workflow_steps s JOIN work_template_versions v ON v.workspace_id=s.workspace_id AND v.template_id=$3 AND v.revision=$4 WHERE s.workspace_id=$1 AND s.run_id=$2 AND s.status='waiting' AND v.definition->'steps'->$5::integer->>'type'='approval' AND s.step_key=v.definition->'steps'->$5::integer->>'key'",
            [p.workspaceId, id, run.template_id, run.template_revision, run.next_step],
          );
          if (!step)
            throw new AppError(
              409,
              'APPROVAL_NOT_PENDING',
              'This workflow is not awaiting a human decision.',
            );
          const decision = workflowDecision.parse(input);
          await tx.query(
            "UPDATE workflow_steps SET decision_by=$4,decision_evidence=$5,output=jsonb_build_object('approved',$6::boolean) WHERE workspace_id=$1 AND run_id=$2 AND step_key=$3",
            [p.workspaceId, id, step.step_key, p.membershipId, decision.evidence, decision.approve],
          );
          await tx.query(
            "UPDATE workflow_runs SET status='running',available_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, id],
          );
        }
        await recordChange(tx, p, 'workflow.updated', id, run.conversation_id as string | null);
        return { ok: true };
      });
    });
  app.patch('/v1/workflow-triggers/:id', async (req) => {
    let p = await authenticate(db, req);
    const id = param(req.params),
      v = z.object({ version: revision, enabled: z.boolean() }).strict().parse(req.body);
    return db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const [row] = await tx.query(
        'SELECT * FROM workflow_triggers WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [p.workspaceId, id],
      );
      if (!row) throw notFound();
      workManager(p, row.created_by);
      workVersion(Number(row.version), v.version);
      await tx.query(
        'UPDATE workflow_triggers SET enabled=$3,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, v.enabled],
      );
      return { ok: true };
    });
  });
}
