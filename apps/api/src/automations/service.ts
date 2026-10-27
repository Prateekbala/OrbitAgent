import type { Permission } from '@ao/contracts';
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import type { z } from 'zod';
import {
  automationCreate,
  automationDefinition,
  automationRevision,
  type AutomationDefinition,
} from '@ao/contracts/automations';
import { AppError, notFound } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { requireConversation, type Identity } from '../lib/policy.js';
import { hasPermission } from '../identity/authorization.js';
import { taskActor } from '../tasks/service.js';
import {
  getTemplate,
  validateDefinition,
  workAuthority,
  workManager,
} from '../workflows/service.js';
import { templateDefinition } from '@ao/contracts/workflows';
import { fenceWorkflowAgents } from '../workflows/fencing.js';
import { nextOccurrence, upcoming } from './schedule.js';
import { recordChange } from '../lib/events.js';
export function automationManager(p: Identity, owner: unknown = p.membershipId) {
  workManager(p, owner);
  if (
    p.credentialId ||
    (p.platformCredentialId && !p.credentialScopes?.includes('automations.write')) ||
    !hasPermission(p, 'execution.manage')
  )
    throw new AppError(
      403,
      'HUMAN_REQUIRED',
      'A person with execution permission must manage automation authority.',
    );
}
export async function automation(tx: Sql, p: Identity, id: string, lock = false) {
  const [row] = await tx.query(
    'SELECT a.*,v.definition,v.authority_snapshot FROM automations a JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.automation_id=a.id AND v.revision=a.revision WHERE a.workspace_id=$1 AND a.id=$2' +
      (lock ? ' FOR UPDATE OF a' : ''),
    [p.workspaceId, id],
  );
  if (!row) throw notFound();
  return row;
}
export function automationPermissions(d: AutomationDefinition): Permission[] {
  return [
    'execution.manage',
    'execution.read',
    'messages.read',
    ...(d.action.kind === 'workflow' ? (['tasks.read', 'tasks.write'] as const) : []),
  ];
}
export async function validateAutomation(tx: Sql, p: Identity, d: AutomationDefinition) {
  const agentRevisions: Record<string, number> = {};
  if (!automationPermissions(d).every((permission) => hasPermission(p, permission)))
    throw new AppError(
      403,
      'PERMISSION_DENIED',
      'The automation requires current execution and source permissions.',
    );
  await requireConversation(tx, p, d.conversationId, true);
  const [channel] = await tx.query(
    'SELECT archived_at FROM conversations WHERE workspace_id=$1 AND id=$2',
    [p.workspaceId, d.conversationId],
  );
  if (channel?.archived_at)
    throw new AppError(409, 'CHANNEL_ARCHIVED', 'Restore the destination channel first.');
  if (d.trigger.kind === 'schedule') nextOccurrence(d.trigger, new Date());
  if (d.escalationMemberId) {
    const [target] = await tx.query(
      "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND kind='human' AND access_type='member' AND coalesce((permissions->>'execution.read')::boolean,true) AND resource_visible_to($1,$3,now(),id)",
      [p.workspaceId, d.escalationMemberId, d.conversationId],
    );
    if (!target)
      throw new AppError(
        400,
        'INVALID_ESCALATION',
        'Choose a member with access to this conversation.',
      );
  }
  if (d.action.kind === 'agent') {
    const [agent] = await tx.query(
      "SELECT a.id FROM agents a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id JOIN agent_revisions v ON v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision WHERE a.workspace_id=$1 AND a.id=$2 AND a.revision=$3 AND a.status='active' AND a.runtime='managed' AND m.status='active' AND resource_visible_to($1,$4,now(),m.id) AND v.configuration->>'activation'<>'disabled' AND (jsonb_array_length(v.configuration->'conversationIds')=0 OR v.configuration->'conversationIds' ? $4::text)",
      [p.workspaceId, d.action.agentId, d.action.agentRevision, d.conversationId],
    );
    if (agent) agentRevisions[d.action.agentId] = d.action.agentRevision;
    if (!agent)
      throw new AppError(
        409,
        'AGENT_AUTHORITY_CHANGED',
        'Choose an active managed agent revision with access to the destination.',
      );
  } else {
    const template = await getTemplate(tx, p, d.action.templateId);
    if (
      template.archived ||
      template.published_revision !== d.action.revision ||
      template.conversation_id !== d.conversationId
    )
      throw new AppError(
        400,
        'TEMPLATE_SCOPE_MISMATCH',
        'Choose a published template in this conversation.',
      );
    const [v] = await tx.query(
      'SELECT definition FROM work_template_versions WHERE workspace_id=$1 AND template_id=$2 AND revision=$3',
      [p.workspaceId, template.id, d.action.revision],
    );
    await validateDefinition(
      tx,
      p,
      templateDefinition.parse(v!.definition),
      String(template.kind),
      d.conversationId,
    );
    const steps = templateDefinition.parse(v!.definition).steps;
    for (const step of steps)
      if (step.type === 'run_agent') {
        const [agent] = await tx.query(
          'SELECT revision FROM agents WHERE workspace_id=$1 AND id=$2 FOR SHARE',
          [p.workspaceId, step.agentId],
        );
        if (!agent) throw notFound();
        agentRevisions[step.agentId] = Number(agent.revision);
      }
  }
  return { agentRevisions };
}
export async function stopOccurrences(
  tx: Sql,
  workspace: string,
  id: string,
  reason: string,
  occurrenceId?: string,
) {
  const rows = await tx.query(
    "SELECT * FROM automation_occurrences WHERE workspace_id=$1 AND automation_id=$2 AND status IN ('queued','running') AND ($3::uuid IS NULL OR id=$3) ORDER BY id FOR UPDATE",
    [workspace, id, occurrenceId ?? null],
  );
  for (const row of rows) {
    if (row.workflow_run_id) {
      await fenceWorkflowAgents(tx, workspace, String(row.workflow_run_id));
      await tx.query(
        "UPDATE workflow_runs SET status='cancelled',version=version+1,finished_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running','waiting')",
        [workspace, row.workflow_run_id],
      );
    }
    if (row.agent_run_id) {
      await tx.query(
        "UPDATE agent_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running','awaiting_approval')",
        [workspace, row.agent_run_id],
      );
      await tx.query(
        "UPDATE tool_invocations SET status='cancelled' WHERE workspace_id=$1 AND run_id=$2 AND status IN ('pending','approved')",
        [workspace, row.agent_run_id],
      );
    }
  }
  await tx.query(
    "UPDATE automation_occurrences SET status='cancelled',reason=$3,finished_at=clock_timestamp() WHERE workspace_id=$1 AND automation_id=$2 AND status IN ('queued','running') AND ($4::uuid IS NULL OR id=$4)",
    [workspace, id, reason, occurrenceId ?? null],
  );
}
export class AutomationService {
  constructor(private readonly db: Database) {}
  create(p: Identity, input: z.infer<typeof automationCreate>) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      p = await taskActor(tx, p, false);
      automationManager(p);
      const hash = digest(JSON.stringify(input));
      const [old] = await tx.query(
        'SELECT id,request_hash FROM automations WHERE workspace_id=$1 AND owner_id=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (old) {
        if (old.request_hash !== hash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This automation key was already used.');
        return { id: old.id, replayed: true };
      }
      const snapshot = await validateAutomation(tx, p, input.definition);
      const authority = await workAuthority(tx, p),
        id = randomUUID();
      const [count] = await tx.query(
        'SELECT count(*)::int count FROM automations WHERE workspace_id=$1',
        [p.workspaceId],
      );
      if (Number(count?.count) >= 1000)
        throw new AppError(
          429,
          'AUTOMATION_LIMIT',
          'This workspace has reached its automation limit.',
        );
      await tx.query(
        'INSERT INTO automations(id,workspace_id,owner_id,name,conversation_id,owner_auth_version,policy_version,client_id,request_hash,event_cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT coalesce(max(id),0) FROM outbox_events WHERE workspace_id=$2))',
        [
          id,
          p.workspaceId,
          p.membershipId,
          input.name,
          input.definition.conversationId,
          authority.auth,
          authority.policy,
          input.clientId,
          hash,
        ],
      );
      await tx.query(
        'UPDATE automations SET escalation_member_id=$3 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, input.definition.escalationMemberId ?? null],
      );
      await tx.query(
        'INSERT INTO automation_versions(workspace_id,automation_id,revision,definition,created_by,authority_snapshot) VALUES($1,$2,1,$3,$4,$5)',
        [
          p.workspaceId,
          id,
          JSON.stringify(input.definition),
          p.membershipId,
          JSON.stringify(snapshot),
        ],
      );
      await recordChange(
        tx,
        p,
        'automation.created',
        id,
        input.definition.conversationId,
        p.membershipId,
      );
      return { id, replayed: false };
    });
  }
  revise(p: Identity, id: string, input: z.infer<typeof automationRevision>) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      p = await taskActor(tx, p, false);
      const row = await automation(tx, p, id, true);
      automationManager(p, row.owner_id);
      this.version(row, input.version);
      const snapshot = await validateAutomation(tx, p, input.definition);
      await stopOccurrences(tx, p.workspaceId, id, 'definition_revised');
      await tx.query(
        'UPDATE automations SET escalation_member_id=$3 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, input.definition.escalationMemberId ?? null],
      );
      await tx.query(
        'INSERT INTO automation_versions(workspace_id,automation_id,revision,definition,created_by,authority_snapshot) VALUES($1,$2,$3,$4,$5,$6)',
        [
          p.workspaceId,
          id,
          Number(row.revision) + 1,
          JSON.stringify(input.definition),
          p.membershipId,
          JSON.stringify(snapshot),
        ],
      );
      await tx.query(
        "UPDATE automations SET name=$3,conversation_id=$4,revision=revision+1,version=version+1,status='paused',next_at=NULL,transfer_to=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id, input.name, input.definition.conversationId],
      );
      await recordChange(
        tx,
        p,
        'automation.revised',
        id,
        input.definition.conversationId,
        String(row.owner_id),
      );
      return { revision: Number(row.revision) + 1, version: input.version + 1 };
    });
  }
  control(p: Identity, id: string, version: number, action: 'pause' | 'resume' | 'archive') {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      p = await taskActor(tx, p, false);
      const row = await automation(tx, p, id, true);
      automationManager(p, row.owner_id);
      this.version(row, version);
      if (row.status === 'archived' && action === 'resume')
        throw new AppError(
          409,
          'AUTOMATION_ARCHIVED',
          'Create a reviewed revision before resuming an archived automation.',
        );
      const d = automationDefinition.parse(row.definition);
      if (action === 'resume' && (p.platformCredentialId || p.membershipId !== row.owner_id))
        throw new AppError(
          403,
          'OWNER_REQUIRED',
          'The owner must review and resume this automation.',
        );
      if (action === 'resume') {
        const snapshot = await validateAutomation(tx, p, d);
        const [same] = await tx.query('SELECT $1::jsonb=$2::jsonb same', [
          JSON.stringify(snapshot),
          JSON.stringify(row.authority_snapshot),
        ]);
        if (!same?.same)
          throw new AppError(
            409,
            'AGENT_AUTHORITY_CHANGED',
            'Save a reviewed revision after a workflow agent changes.',
          );
      } else await stopOccurrences(tx, p.workspaceId, id, action);
      const authority = await workAuthority(tx, p);
      await tx.query(
        "UPDATE automations SET status=$3,version=version+1,next_at=$4,owner_auth_version=CASE WHEN $3='active' THEN $5 ELSE owner_auth_version END,policy_version=CASE WHEN $3='active' THEN $6 ELSE policy_version END,event_cursor=CASE WHEN $3='active' THEN (SELECT coalesce(max(id),0) FROM outbox_events WHERE workspace_id=$1) ELSE event_cursor END,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
        [
          p.workspaceId,
          id,
          action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'archived',
          action === 'resume' && d.trigger.kind === 'schedule'
            ? nextOccurrence(d.trigger, new Date())
            : null,
          authority.auth,
          authority.policy,
        ],
      );
      await recordChange(tx, p, 'automation.' + action, id, d.conversationId, String(row.owner_id));
      return { version: version + 1 };
    });
  }
  async detail(p: Identity, id: string) {
    const row = await automation(this.db, p, id),
      d = automationDefinition.parse(row.definition);
    const [report] = await this.db.query(
      "SELECT count(DISTINCT o.id)::int occurrences,count(DISTINCT o.id) FILTER(WHERE o.status='failed')::int failures,count(r.id) FILTER(WHERE (r.result->>'suppressed')::boolean)::int suppressed,coalesce(sum(CASE e.state WHEN 'reserved' THEN e.amount_micros WHEN 'settled' THEN e.actual_micros ELSE 0 END),0)::text spent_or_reserved_micros FROM automation_occurrences o LEFT JOIN agent_runs r ON r.workspace_id=o.workspace_id AND r.automation_occurrence_id=o.id LEFT JOIN execution_reservations e ON e.workspace_id=r.workspace_id AND e.run_id=r.id WHERE o.workspace_id=$1 AND o.automation_id=$2",
      [p.workspaceId, id],
    );
    return {
      id: row.id,
      name: row.name,
      owner_id: row.owner_id,
      conversation_id: row.conversation_id,
      revision: row.revision,
      version: row.version,
      status: row.status,
      next_at: row.next_at,
      transfer_to: row.transfer_to,
      created_at: row.created_at,
      updated_at: row.updated_at,
      definition: d,
      report,
      upcoming:
        row.status === 'active' && d.trigger.kind === 'schedule'
          ? upcoming(d.trigger, new Date())
          : [],
    };
  }
  version(row: Record<string, unknown>, version: number) {
    if (Number(row.version) !== version)
      throw new AppError(409, 'VERSION_CONFLICT', 'This automation changed. Reload before saving.');
  }
}
