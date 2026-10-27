import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import type { z } from 'zod';
import type {
  artifactInput,
  criterionInput,
  criterionReview,
  sourceInput,
  taskParticipantInput,
  taskRunInput,
  taskPlanInput,
} from '@ao/contracts/workflows';
import { taskActor, manageTask } from './service.js';
import { getTask } from './queries.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { digest } from '../lib/security.js';
import type { Identity } from '../lib/policy.js';
import { hasPermission } from '../identity/authorization.js';
import { enqueueRun } from '../execution/runs.js';
export function workVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'This record changed. Refresh and review the latest version.',
    );
}
async function eligibleForTask(
  tx: Sql,
  p: Identity,
  task: { conversation_id: string | null; created_at: string },
  member: string,
) {
  const [eligible] = await tx.query(
    "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND resource_visible_to($1,$3,$4::timestamptz,id)",
    [p.workspaceId, member, task.conversation_id, task.created_at],
  );
  if (!eligible)
    throw new AppError(
      400,
      'PARTICIPANT_ACCESS_REQUIRED',
      'Choose an active member who can read this task.',
    );
}
export class TaskWorkService {
  constructor(
    private readonly db: Database,
    private readonly runtimeConfigured = false,
  ) {}
  async details(p: Identity, id: string) {
    await getTask(this.db, p, id);
    const [participants, criteria] = await Promise.all([
      this.db.query(
        'SELECT tp.membership_id,m.name,tp.role FROM task_participants tp JOIN memberships m ON m.workspace_id=tp.workspace_id AND m.id=tp.membership_id WHERE tp.workspace_id=$1 AND tp.task_id=$2 ORDER BY m.name,m.id',
        [p.workspaceId, id],
      ),
      this.db.query(
        'SELECT c.id,c.text,c.required,c.accepted,c.evidence,c.artifact_id,m.name reviewer_name FROM task_criteria c LEFT JOIN memberships m ON m.workspace_id=c.workspace_id AND m.id=c.reviewed_by WHERE c.workspace_id=$1 AND c.task_id=$2 ORDER BY c.created_at,c.id',
        [p.workspaceId, id],
      ),
    ]);
    return { participants, criteria };
  }
  async participant(p: Identity, id: string, input: z.infer<typeof taskParticipantInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      if (!(input.role === 'watcher' && input.membershipId === p.membershipId)) manageTask(p, task);
      workVersion(task.version, input.version);
      if (input.remove)
        await tx.query(
          'DELETE FROM task_participants WHERE workspace_id=$1 AND task_id=$2 AND membership_id=$3',
          [p.workspaceId, id, input.membershipId],
        );
      else {
        await eligibleForTask(tx, p, task, input.membershipId);
        const [count] = await tx.query(
          'SELECT count(*)::int count FROM task_participants WHERE workspace_id=$1 AND task_id=$2',
          [p.workspaceId, id],
        );
        if (Number(count!.count) >= 100)
          throw new AppError(409, 'PARTICIPANT_LIMIT', 'A task supports up to 100 participants.');
        await tx.query(
          "INSERT INTO task_participants(workspace_id,task_id,membership_id,role,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,task_id,membership_id) DO UPDATE SET role=CASE WHEN task_participants.role='collaborator' AND $3=$5 AND $4='watcher' THEN task_participants.role ELSE EXCLUDED.role END",
          [p.workspaceId, id, input.membershipId, input.role, p.membershipId],
        );
      }
      await this.changed(tx, p, id, task.conversation_id, 'task.participants_updated');
      return { ok: true };
    });
  }
  async criterion(p: Identity, id: string, input: z.infer<typeof criterionInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      workVersion(task.version, input.version);
      if (['completed', 'cancelled'].includes(task.state))
        throw new AppError(
          409,
          'TASK_CLOSED',
          'Acceptance criteria cannot be added to closed work.',
        );
      const [count] = await tx.query(
        'SELECT count(*)::int count FROM task_criteria WHERE workspace_id=$1 AND task_id=$2',
        [p.workspaceId, id],
      );
      if (Number(count!.count) >= 50)
        throw new AppError(409, 'CRITERIA_LIMIT', 'A task supports up to 50 criteria.');
      const criterion = randomUUID();
      await tx.query(
        'INSERT INTO task_criteria(id,workspace_id,task_id,text,required) VALUES($1,$2,$3,$4,$5)',
        [criterion, p.workspaceId, id, input.text, input.required],
      );
      await this.changed(tx, p, id, task.conversation_id, 'task.criteria_updated');
      return { id: criterion };
    });
  }
  async review(p: Identity, id: string, criterion: string, input: z.infer<typeof criterionReview>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      workVersion(task.version, input.version);
      if (p.kind !== 'human')
        throw new AppError(403, 'HUMAN_REQUIRED', 'A person must verify acceptance criteria.');
      if (['completed', 'cancelled'].includes(task.state))
        throw new AppError(409, 'TASK_CLOSED', 'Closed task verification is immutable.');
      const [row] = await tx.query(
        'SELECT id FROM task_criteria WHERE workspace_id=$1 AND task_id=$2 AND id=$3 FOR UPDATE',
        [p.workspaceId, id, criterion],
      );
      if (!row) throw notFound();
      if (input.artifactId) {
        const [artifact] = await tx.query(
          'SELECT id FROM task_artifacts WHERE workspace_id=$1 AND task_id=$2 AND id=$3',
          [p.workspaceId, id, input.artifactId],
        );
        if (!artifact) throw notFound();
      }
      await tx.query(
        'UPDATE task_criteria SET accepted=$4,evidence=$5,reviewed_by=$6,artifact_id=$7 WHERE workspace_id=$1 AND task_id=$2 AND id=$3',
        [
          p.workspaceId,
          id,
          criterion,
          input.accepted,
          input.evidence,
          p.membershipId,
          input.artifactId,
        ],
      );
      await tx.query(
        'INSERT INTO task_criterion_reviews(id,workspace_id,task_id,criterion_id,reviewed_by,accepted,evidence,artifact_id,task_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          p.workspaceId,
          id,
          criterion,
          p.membershipId,
          input.accepted,
          input.evidence,
          input.artifactId,
          task.version + 1,
        ],
      );
      await this.changed(tx, p, id, task.conversation_id, 'task.criteria_updated');
      return { ok: true };
    });
  }
  async artifact(p: Identity, id: string, input: z.infer<typeof artifactInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      const hash = digest(JSON.stringify(input));
      const [old] = await tx.query(
        'SELECT id,request_hash FROM task_artifacts WHERE workspace_id=$1 AND task_id=$2 AND created_by=$3 AND client_id=$4',
        [p.workspaceId, id, p.membershipId, input.clientId],
      );
      if (old) {
        if (old.request_hash !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This artifact key was used with different details.',
          );
        return { id: old.id, replayed: true };
      }
      if (input.fileId) {
        const [file] = await tx.query(
          'SELECT file_id FROM task_attachments WHERE workspace_id=$1 AND task_id=$2 AND file_id=$3 AND removed_at IS NULL',
          [p.workspaceId, id, input.fileId],
        );
        if (!file)
          throw new AppError(
            400,
            'INVALID_ARTIFACT_FILE',
            'Choose an active attachment on this task.',
          );
      }
      const artifact = randomUUID();
      await tx.query(
        'INSERT INTO task_artifacts(id,workspace_id,task_id,created_by,client_id,request_hash,kind,title,url,file_id,details,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          artifact,
          p.workspaceId,
          id,
          p.membershipId,
          input.clientId,
          hash,
          input.kind,
          input.title,
          input.url ?? null,
          input.fileId ?? null,
          input.details,
          input.outcome,
        ],
      );
      await this.changed(tx, p, id, task.conversation_id, 'task.artifact_added');
      return { id: artifact, replayed: false };
    });
  }
  async source(p: Identity, id: string, input: z.infer<typeof sourceInput>) {
    if (!hasPermission(p, 'messages.read'))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Message access is required to link a discussion.',
      );
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      const [message] = await tx.query(
        'SELECT conversation_id FROM messages WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',
        [p.workspaceId, input.messageId],
      );
      if (!message || message.conversation_id !== task.conversation_id)
        throw new AppError(
          400,
          'SOURCE_AUDIENCE_MISMATCH',
          'The source must be a visible message in this task’s conversation.',
        );
      await tx.query(
        'INSERT INTO task_sources(id,workspace_id,task_id,message_id,kind,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,task_id,message_id) DO NOTHING',
        [randomUUID(), p.workspaceId, id, input.messageId, input.kind, p.membershipId],
      );
      await this.changed(tx, p, id, task.conversation_id, 'task.source_linked');
      return { ok: true };
    });
  }
  async run(p: Identity, id: string, input: z.infer<typeof taskRunInput>) {
    if (input.action === 'start' && !this.runtimeConfigured)
      throw new AppError(
        503,
        'RUNTIME_NOT_CONFIGURED',
        'The operator must configure hosted agent execution.',
      );
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      if (p.kind !== 'human' || !hasPermission(p, 'execution.manage'))
        throw new AppError(403, 'PERMISSION_DENIED', 'Hosted execution permission is required.');
      if (!task.conversation_id)
        throw new AppError(
          400,
          'CONVERSATION_REQUIRED',
          'Run agents from a conversation-scoped task.',
        );
      if (input.action === 'start') {
        const [agent] = await tx.query(
          'SELECT a.id FROM agents a WHERE a.workspace_id=$1 AND a.id=$2 AND resource_visible_to($1,$3,$4::timestamptz,a.membership_id)',
          [p.workspaceId, input.agentId, task.conversation_id, task.created_at],
        );
        if (!agent)
          throw new AppError(
            400,
            'AGENT_SOURCE_ACCESS_REQUIRED',
            'The agent cannot access this task’s history.',
          );
      }
      const run =
        input.action === 'link'
          ? { id: input.runId }
          : await enqueueRun(tx, p, {
              agentId: input.agentId,
              conversationId: task.conversation_id,
              prompt: input.prompt,
              requestKey: input.clientId,
            });
      const [row] = await tx.query(
        'SELECT conversation_id,requester_id FROM agent_runs WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, run.id],
      );
      if (
        !row ||
        row.conversation_id !== task.conversation_id ||
        (row.requester_id !== p.membershipId && !['owner', 'admin'].includes(p.role))
      )
        throw new AppError(
          400,
          'RUN_AUDIENCE_MISMATCH',
          'Choose an authorized run in this task’s conversation.',
        );
      await tx.query(
        'INSERT INTO task_runs(workspace_id,task_id,run_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [p.workspaceId, id, run.id, p.membershipId],
      );
      await recordChange(tx, p, 'task.run_linked', id, task.conversation_id);
      return run;
    });
  }
  async plan(p: Identity, id: string, input: z.infer<typeof taskPlanInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      workVersion(task.version, input.version);
      if (input.startDate && task.due_date && input.startDate > task.due_date)
        throw new AppError(400, 'INVALID_DATES', 'The start date must precede the due date.');
      await tx.query(
        'UPDATE tasks SET start_date=$3,estimate=$4,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, input.startDate, input.estimate],
      );
      await recordChange(tx, p, 'task.updated', id, task.conversation_id);
      return { ok: true };
    });
  }
  private async changed(
    tx: Sql,
    p: Identity,
    id: string,
    conversation: string | null,
    type: string,
  ) {
    await tx.query('UPDATE tasks SET version=version+1 WHERE workspace_id=$1 AND id=$2', [
      p.workspaceId,
      id,
    ]);
    await recordChange(tx, p, type, id, conversation);
  }
}
