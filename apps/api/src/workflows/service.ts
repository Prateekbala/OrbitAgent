import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import {
  templateDefinition,
  type templateInput,
  type templateRevision,
  type templatePublish,
  type workflowStart,
  type triggerInput,
  type WorkflowDefinition,
} from '@ao/contracts/workflows';
import type { z } from 'zod';
import type { Identity } from '../lib/policy.js';
import { requireConversation } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { recordChange } from '../lib/events.js';
import { taskActor } from '../tasks/service.js';
import { getTask } from '../tasks/queries.js';
import { getProject } from '../projects/queries.js';
import { workVersion } from '../tasks/work.js';
export function workManager(p: Identity, owner: unknown) {
  if (
    p.kind !== 'human' ||
    p.accessType === 'guest' ||
    p.accessType === 'service' ||
    (owner !== p.membershipId && !['owner', 'admin'].includes(p.role))
  )
    throw new AppError(
      403,
      'FORBIDDEN',
      'The owner or a human administrator must manage this workflow.',
    );
}
export async function getTemplate(tx: Sql, p: Identity, id: string, lock = false) {
  const [row] = await tx.query(
    'SELECT * FROM work_templates WHERE workspace_id=$1 AND id=$2' + (lock ? ' FOR UPDATE' : ''),
    [p.workspaceId, id],
  );
  if (!row) throw notFound();
  return row;
}
export async function validateDefinition(
  tx: Sql,
  p: Identity,
  definition: WorkflowDefinition,
  kind: string,
  conversation: string | null,
) {
  if (kind === 'task' && definition.steps.some((s) => s.type !== 'create_task'))
    throw new AppError(400, 'INVALID_TEMPLATE', 'Task templates contain create-task steps only.');
  const references = new Set<string>();
  for (const step of definition.steps) {
    const member = step.type === 'create_task' ? step.assigneeId : null;
    if (member) references.add(member);
    if (step.type === 'run_agent') {
      if (!conversation)
        throw new AppError(
          400,
          'CONVERSATION_REQUIRED',
          'Agent workflows require a conversation audience.',
        );
      const [agent] = await tx.query(
        "SELECT a.id FROM agents a JOIN memberships m ON m.id=a.membership_id AND m.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND a.id=$2 AND a.status='active' AND resource_visible_to($1,$3,clock_timestamp(),m.id)",
        [p.workspaceId, step.agentId, conversation],
      );
      if (!agent)
        throw new AppError(
          400,
          'INVALID_AGENT',
          'Choose an active agent in the workflow audience.',
        );
    }
    if (step.type === 'create_task' && step.businessCalendarId) {
      const [calendar] = await tx.query(
        'SELECT id FROM business_calendars WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, step.businessCalendarId],
      );
      if (!calendar) throw notFound();
    }
  }
  if (definition.escalationMemberId) references.add(definition.escalationMemberId);
  for (const member of references) {
    const [row] = await tx.query(
      "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND resource_visible_to($1,$3,clock_timestamp(),id)",
      [p.workspaceId, member, conversation],
    );
    if (!row)
      throw new AppError(
        400,
        'INVALID_WORKFLOW_MEMBER',
        'A referenced member cannot read this workflow.',
      );
  }
}
export async function workAuthority(tx: Sql, p: Identity) {
  const [account] = await tx.query('SELECT * FROM member_account_authority($1,$2)', [
    p.workspaceId,
    p.membershipId,
  ]);
  const [policy] = await tx.query('SELECT workspace_policy_version($1) version', [p.workspaceId]);
  return { auth: Number(account?.auth_version ?? 0), policy: Number(policy?.version ?? 0) };
}
export async function admitWorkflow(
  tx: Sql,
  p: Identity,
  template: Record<string, unknown>,
  input: z.infer<typeof workflowStart>,
  extra: { triggerId?: string; eventId?: string; replayOf?: string; hash?: string } = {},
) {
  const hash = extra.hash ?? digest(JSON.stringify({ template: template.id, ...input }));
  const [old] = await tx.query(
    'SELECT id,request_hash FROM workflow_runs WHERE workspace_id=$1 AND created_by=$2 AND client_id=$3',
    [p.workspaceId, p.membershipId, input.clientId],
  );
  if (old) {
    if (old.request_hash !== hash)
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This workflow key was used with different inputs.',
      );
    return { id: String(old.id), replayed: true };
  }
  if (template.archived || template.published_revision !== input.revision)
    throw new AppError(
      409,
      'TEMPLATE_NOT_PUBLISHED',
      'Start the current published revision of an active template.',
    );
  const [revision] = await tx.query(
    'SELECT definition FROM work_template_versions WHERE workspace_id=$1 AND template_id=$2 AND revision=$3',
    [p.workspaceId, template.id, input.revision],
  );
  if (!revision) throw notFound();
  const definition = templateDefinition.parse(revision.definition);
  await validateDefinition(
    tx,
    p,
    definition,
    String(template.kind),
    template.conversation_id as string | null,
  );
  if (input.sourceTaskId) {
    const task = await getTask(tx, p, input.sourceTaskId, true);
    if (task.conversation_id !== template.conversation_id)
      throw new AppError(
        400,
        'WORKFLOW_SCOPE_MISMATCH',
        'The source task and template must share an audience.',
      );
  }
  if (definition.steps.some((s) => 'target' in s && s.target === 'source') && !input.sourceTaskId)
    throw new AppError(400, 'SOURCE_TASK_REQUIRED', 'Choose the source task for this workflow.');
  if (input.projectId) {
    const project = await getProject(tx, p, input.projectId, true);
    if (project.conversation_id !== template.conversation_id)
      throw new AppError(
        400,
        'WORKFLOW_SCOPE_MISMATCH',
        'The project and template must share an audience.',
      );
  }
  const [open] = await tx.query(
    "SELECT count(*)::int count FROM workflow_runs WHERE workspace_id=$1 AND status IN ('queued','running','waiting')",
    [p.workspaceId],
  );
  if (Number(open!.count) >= 100)
    throw new AppError(429, 'WORKFLOW_LIMIT', 'This workspace has 100 active workflows.');
  const authority = await workAuthority(tx, p),
    id = randomUUID();
  await tx.query(
    "INSERT INTO workflow_runs(id,workspace_id,template_id,template_revision,conversation_id,source_task_id,project_id,created_by,client_id,request_hash,auth_version,policy_version,trigger_id,event_id,replay_of,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,clock_timestamp()+$16::integer*interval '1 minute')",
    [
      id,
      p.workspaceId,
      template.id,
      input.revision,
      template.conversation_id,
      input.sourceTaskId ?? null,
      input.projectId ?? null,
      p.membershipId,
      input.clientId,
      hash,
      authority.auth,
      authority.policy,
      extra.triggerId ?? null,
      extra.eventId ?? null,
      extra.replayOf ?? null,
      definition.timeoutMinutes,
    ],
  );
  await recordChange(tx, p, 'workflow.queued', id, template.conversation_id as string | null);
  return { id, replayed: false };
}
export class WorkflowService {
  constructor(private readonly db: Database) {}
  private async actor(tx: Sql, p: Identity) {
    await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
    p = await taskActor(tx, p);
    workManager(p, p.membershipId);
    return p;
  }
  async create(p: Identity, input: z.infer<typeof templateInput>) {
    return this.db.transaction(async (tx) => {
      p = await this.actor(tx, p);
      const hash = digest(JSON.stringify(input)),
        [old] = await tx.query(
          'SELECT id,request_hash FROM work_templates WHERE workspace_id=$1 AND created_by=$2 AND client_id=$3',
          [p.workspaceId, p.membershipId, input.clientId],
        );
      if (old) {
        if (old.request_hash !== hash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This template key was already used.');
        return { id: old.id };
      }
      if (input.conversationId) await requireConversation(tx, p, input.conversationId, true);
      await validateDefinition(tx, p, input.definition, input.kind, input.conversationId ?? null);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO work_templates(id,workspace_id,conversation_id,name,kind,created_by,client_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          p.workspaceId,
          input.conversationId ?? null,
          input.name,
          input.kind,
          p.membershipId,
          input.clientId,
          hash,
        ],
      );
      await tx.query(
        'INSERT INTO work_template_versions(workspace_id,template_id,revision,definition,created_by) VALUES($1,$2,1,$3::jsonb,$4)',
        [p.workspaceId, id, JSON.stringify(input.definition), p.membershipId],
      );
      await recordChange(tx, p, 'template.created', id, input.conversationId ?? null);
      return { id };
    });
  }
  async revise(p: Identity, id: string, input: z.infer<typeof templateRevision>) {
    return this.db.transaction(async (tx) => {
      p = await this.actor(tx, p);
      const row = await getTemplate(tx, p, id, true);
      workManager(p, row.created_by);
      workVersion(Number(row.version), input.version);
      await validateDefinition(
        tx,
        p,
        input.definition,
        String(row.kind),
        row.conversation_id as string | null,
      );
      const revision = Number(row.latest_revision) + 1;
      await tx.query(
        'INSERT INTO work_template_versions(workspace_id,template_id,revision,definition,created_by) VALUES($1,$2,$3,$4::jsonb,$5)',
        [p.workspaceId, id, revision, JSON.stringify(input.definition), p.membershipId],
      );
      await tx.query(
        'UPDATE work_templates SET name=$3,latest_revision=$4,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, input.name, revision],
      );
      await recordChange(tx, p, 'template.revised', id, row.conversation_id as string | null);
      return { revision };
    });
  }
  async publish(p: Identity, id: string, input: z.infer<typeof templatePublish>) {
    return this.db.transaction(async (tx) => {
      p = await this.actor(tx, p);
      const row = await getTemplate(tx, p, id, true);
      workManager(p, row.created_by);
      workVersion(Number(row.version), input.version);
      const [v] = await tx.query(
        'SELECT definition FROM work_template_versions WHERE workspace_id=$1 AND template_id=$2 AND revision=$3',
        [p.workspaceId, id, input.revision],
      );
      if (!v) throw notFound();
      await validateDefinition(
        tx,
        p,
        templateDefinition.parse(v.definition),
        String(row.kind),
        row.conversation_id as string | null,
      );
      await tx.query(
        'UPDATE work_templates SET published_revision=$3,archived=$4,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, input.revision, input.archived],
      );
      await recordChange(tx, p, 'template.published', id, row.conversation_id as string | null);
      return { ok: true };
    });
  }
  async start(p: Identity, id: string, input: z.infer<typeof workflowStart>) {
    return this.db.transaction(async (tx) => {
      p = await this.actor(tx, p);
      return admitWorkflow(tx, p, await getTemplate(tx, p, id, true), input);
    });
  }
  async trigger(p: Identity, input: z.infer<typeof triggerInput>) {
    return this.db.transaction(async (tx) => {
      p = await this.actor(tx, p);
      const template = await getTemplate(tx, p, input.templateId, true);
      workManager(p, template.created_by);
      if (template.published_revision !== input.revision || template.archived)
        throw new AppError(409, 'TEMPLATE_NOT_PUBLISHED', 'Publish the selected revision first.');
      if (input.projectId) {
        const project = await getProject(tx, p, input.projectId);
        if (project.conversation_id !== template.conversation_id)
          throw new AppError(
            400,
            'WORKFLOW_SCOPE_MISMATCH',
            'The project and workflow must share an audience.',
          );
      }
      const hash = digest(JSON.stringify(input)),
        [old] = await tx.query(
          'SELECT id,request_hash FROM workflow_triggers WHERE workspace_id=$1 AND created_by=$2 AND client_id=$3',
          [p.workspaceId, p.membershipId, input.clientId],
        );
      if (old) {
        if (old.request_hash !== hash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This trigger key was already used.');
        return { id: old.id };
      }
      const id = randomUUID();
      await tx.query(
        'INSERT INTO workflow_triggers(id,workspace_id,template_id,template_revision,event_type,state,project_id,enabled,created_by,client_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          id,
          p.workspaceId,
          input.templateId,
          input.revision,
          input.event,
          input.state ?? null,
          input.projectId ?? null,
          input.enabled,
          p.membershipId,
          input.clientId,
          hash,
        ],
      );
      await recordChange(
        tx,
        p,
        'workflow.trigger_created',
        id,
        template.conversation_id as string | null,
      );
      return { id };
    });
  }
  async replay(p: Identity, id: string, clientId: string, version: number) {
    return this.db.transaction(async (tx) => {
      p = await this.actor(tx, p);
      const [run] = await tx.query(
        'SELECT * FROM workflow_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [p.workspaceId, id],
      );
      if (!run) throw notFound();
      workManager(p, run.created_by);
      workVersion(Number(run.version), version);
      if (!['failed', 'cancelled'].includes(String(run.status)))
        throw new AppError(
          409,
          'REPLAY_NOT_ALLOWED',
          'Only failed or cancelled workflows can be replayed.',
        );
      const [uncertain] = await tx.query(
        "SELECT s.step_key FROM workflow_steps s JOIN agent_runs r ON r.workspace_id=s.workspace_id AND r.id=nullif(s.output->>'runId','')::uuid WHERE s.workspace_id=$1 AND s.run_id=$2 AND (r.status NOT IN ('succeeded','failed','cancelled') OR EXISTS(SELECT 1 FROM execution_reservations reserve WHERE reserve.workspace_id=r.workspace_id AND reserve.run_id=r.id AND reserve.state='reserved'))",
        [p.workspaceId, id],
      );
      if (uncertain)
        throw new AppError(
          409,
          'OUTCOME_UNRESOLVED',
          'Resolve the previous agent run before replaying this workflow.',
        );
      const template = await getTemplate(tx, p, String(run.template_id), true);
      const result = await admitWorkflow(
        tx,
        p,
        { ...template, published_revision: run.template_revision },
        {
          clientId,
          revision: Number(run.template_revision),
          ...(run.source_task_id ? { sourceTaskId: String(run.source_task_id) } : {}),
          ...(run.project_id ? { projectId: String(run.project_id) } : {}),
        },
        { replayOf: id },
      );
      if (!result.replayed) {
        await tx.query(
          "INSERT INTO workflow_steps(workspace_id,run_id,step_key,status,output,attempts) SELECT workspace_id,$3,step_key,status,output,attempts FROM workflow_steps WHERE workspace_id=$1 AND run_id=$2 AND status='succeeded'",
          [p.workspaceId, id, result.id],
        );
      }
      return result;
    });
  }
}
