import { hasPermission } from '../identity/authorization.js';
import { getProject } from '../projects/queries.js';
import { validatePlacement, setTaskLabels } from '../projects/task-organization.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Database, Sql } from '@ao/database';
import type { taskInput, taskUpdate, taskTransition, Task } from '@ao/contracts';
import { taskMoves } from '@ao/contracts';
import { AppError } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { requireActiveMember, requireConversation, type Identity } from '../lib/policy.js';
import { recordChange } from '../lib/events.js';
import { getTask, managesTask } from './queries.js';
export async function taskActor(tx: Sql, p: Identity, graph = true): Promise<Identity> {
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
  if (graph) await tx.query('SELECT lock_task_graph($1)', [p.workspaceId]);
  const [member] = await tx.query<
    { role: Identity['role']; kind: Identity['kind'] } & Record<string, unknown>
  >(
    "SELECT role,kind FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",
    [p.workspaceId, p.membershipId],
  );
  if (!member) throw new AppError(403, 'FORBIDDEN', 'Active workspace membership is required.');
  return { ...p, role: member.role, kind: member.kind };
}
export function manageTask(p: Identity, task: Task) {
  if (!managesTask(p, task))
    throw new AppError(
      403,
      'FORBIDDEN',
      'Only the creator, assignee or a human administrator can manage this task.',
    );
}
function checkVersion(task: Task, version: number) {
  if (task.version !== version)
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'This task changed. Review the latest version before saving again.',
    );
}
async function assignee(
  tx: Sql,
  p: Identity,
  member: string | null,
  conversation: string | null,
  createdAt?: string | Date,
  taskId?: string,
) {
  if (!member) return;
  await requireActiveMember(tx, p, member);
  const [target] = await tx.query('SELECT access_type FROM memberships WHERE id=$1', [member]);
  if (!conversation && target?.access_type !== 'member')
    throw new AppError(
      400,
      'INVALID_ASSIGNEE',
      'Guests and service accounts require a shared conversation for task assignments.',
    );
  if (conversation) {
    const [eligible] = await tx.query(
      `SELECT id FROM conversations c WHERE c.workspace_id=$1 AND c.id=$2 AND resource_visible_to($1,$2,coalesce((SELECT created_at FROM tasks WHERE workspace_id=$1 AND id=$5::uuid),$4::timestamptz,transaction_timestamp()),$3) AND ((c.visibility='public' AND EXISTS(SELECT 1 FROM memberships WHERE id=$3 AND access_type='member')) OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$3))`,
      [p.workspaceId, conversation, member, createdAt ?? null, taskId ?? null],
    );
    if (!eligible)
      throw new AppError(
        400,
        'INVALID_ASSIGNEE',
        'The assignee must be able to access this task’s conversation.',
      );
  }
}
export class TaskService {
  constructor(private readonly db: Database) {}
  async details(p: Identity, id: string) {
    const task = await getTask(this.db, p, id);
    return {
      task,
      parent: task.parent_id ? await getTask(this.db, p, task.parent_id) : null,
      can_manage:
        hasPermission(p, 'tasks.write') &&
        (!p.platformCredentialId || p.credentialScopes?.includes('tasks.write') === true) &&
        managesTask(p, task),
    };
  }
  async create(p: Identity, input: z.infer<typeof taskInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const hash = digest(JSON.stringify(input));
      if (input.clientId) {
        const [previous] = await tx.query(
          'SELECT id,create_request_hash FROM tasks WHERE workspace_id=$1 AND created_by=$2 AND create_request_id=$3',
          [p.workspaceId, p.membershipId, input.clientId],
        );
        if (previous) {
          await getTask(tx, p, String(previous.id));
          if (previous.create_request_hash !== hash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This create identifier was used for different task details.',
            );
          return { id: previous.id, replayed: true };
        }
      }
      let conversation = input.conversationId ?? null;
      let projectId = input.projectId ?? null,
        milestoneId = input.milestoneId ?? null;
      if (input.parentId) {
        const parent = await getTask(tx, p, input.parentId, true);
        manageTask(p, parent);
        if (conversation && conversation !== parent.conversation_id)
          throw new AppError(
            409,
            'TASK_SCOPE_MISMATCH',
            'A subtask must retain its parent’s audience.',
          );
        conversation = parent.conversation_id;
        if (input.projectId === undefined) {
          projectId = parent.project_id;
          if (input.milestoneId === undefined) milestoneId = parent.milestone_id;
        }
      }
      if (projectId && !input.parentId && input.conversationId === undefined)
        conversation = (await getProject(tx, p, projectId, true)).conversation_id;
      if (conversation) await requireConversation(tx, p, conversation, true);
      await validatePlacement(tx, p, projectId, milestoneId, conversation);
      if (['guest', 'service'].includes(p.accessType ?? '') && !conversation)
        throw new AppError(
          403,
          'CONVERSATION_SCOPE_REQUIRED',
          'Restricted accounts must create tasks in a shared conversation.',
        );
      await assignee(tx, p, input.assigneeId ?? null, conversation);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO tasks(id,workspace_id,title,description,priority,assignee_id,created_by,conversation_id,parent_id,due_date,create_request_id,create_request_hash,project_id,milestone_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          id,
          p.workspaceId,
          input.title,
          input.description,
          input.priority,
          input.assigneeId ?? null,
          p.membershipId,
          conversation,
          input.parentId ?? null,
          input.dueDate ?? null,
          input.clientId ?? null,
          input.clientId ? hash : null,
          projectId,
          milestoneId,
        ],
      );
      await tx.query('SELECT assert_task_graph($1,$2)', [p.workspaceId, id]);
      await setTaskLabels(tx, p, id, input.labelIds ?? []);
      await recordChange(tx, p, 'task.created', id, conversation);
      return { id, replayed: false };
    });
  }
  async update(p: Identity, id: string, input: z.infer<typeof taskUpdate>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      return updateTask(tx, p, task, input);
    });
  }
  async transition(p: Identity, id: string, input: z.infer<typeof taskTransition>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      return transitionTask(tx, p, task, input);
    });
  }
  async dependency(p: Identity, id: string, target: string, version: number, remove = false) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      if (target === id) throw new AppError(409, 'TASK_CYCLE', 'A task cannot depend on itself.');
      const prerequisite = await getTask(tx, p, target, true);
      if (prerequisite.conversation_id !== task.conversation_id)
        throw new AppError(
          409,
          'TASK_SCOPE_MISMATCH',
          'Related tasks must share the same audience.',
        );
      const [present] = await tx.query(
        'SELECT task_id FROM task_dependencies WHERE workspace_id=$1 AND task_id=$2 AND depends_on_id=$3',
        [p.workspaceId, id, target],
      );
      if (Boolean(present) === !remove) return { ok: true, version: task.version, replayed: true };
      checkVersion(task, version);
      if (remove)
        await tx.query(
          'DELETE FROM task_dependencies WHERE workspace_id=$1 AND task_id=$2 AND depends_on_id=$3',
          [p.workspaceId, id, target],
        );
      else
        await tx.query(
          'INSERT INTO task_dependencies(workspace_id,task_id,depends_on_id,created_by) VALUES($1,$2,$3,$4)',
          [p.workspaceId, id, target, p.membershipId],
        );
      await tx.query('UPDATE tasks SET version=version+1 WHERE workspace_id=$1 AND id=$2', [
        p.workspaceId,
        id,
      ]);
      await tx.query('SELECT assert_task_graph($1,$2)', [p.workspaceId, id]);
      await recordChange(
        tx,
        p,
        remove ? 'task.dependency_removed' : 'task.dependency_added',
        id,
        task.conversation_id,
      );
      return { ok: true, version: task.version + 1, replayed: false };
    });
  }
}

export async function updateTask(
  tx: Sql,
  p: Identity,
  task: Task,
  input: z.infer<typeof taskUpdate>,
  validateGraph = true,
) {
  const id = task.id;
  checkVersion(task, input.version);
  if (input.parentId === id)
    throw new AppError(409, 'TASK_CYCLE', 'A task cannot be its own parent.');
  if (input.parentId && input.parentId !== task.parent_id) {
    const parent = await getTask(tx, p, input.parentId, true);
    manageTask(p, parent);
    if (parent.conversation_id !== task.conversation_id)
      throw new AppError(409, 'TASK_SCOPE_MISMATCH', 'Related tasks must share the same audience.');
  }
  if (input.assigneeId !== undefined && input.assigneeId !== task.assignee_id)
    await assignee(tx, p, input.assigneeId, task.conversation_id, task.created_at, task.id);
  const projectId = input.projectId === undefined ? task.project_id : input.projectId;
  const milestoneId =
    input.milestoneId === undefined
      ? projectId === task.project_id
        ? task.milestone_id
        : null
      : input.milestoneId;
  if (projectId !== task.project_id || milestoneId !== task.milestone_id)
    await validatePlacement(tx, p, projectId, milestoneId, task.conversation_id);
  const labels = input.labelIds ?? task.labels.map((label) => label.id).sort();
  const labelsChanged =
    JSON.stringify(labels) !== JSON.stringify(task.labels.map((label) => label.id).sort());
  const fields = {
    project_id: projectId,
    milestone_id: milestoneId,
    title: input.title ?? task.title,
    description: input.description ?? task.description,
    priority: input.priority ?? task.priority,
    assignee_id: input.assigneeId === undefined ? task.assignee_id : input.assigneeId,
    parent_id: input.parentId === undefined ? task.parent_id : input.parentId,
    due_date: input.dueDate === undefined ? task.due_date : input.dueDate,
  };
  if (task.start_date && fields.due_date && task.start_date > fields.due_date)
    throw new AppError(400, 'INVALID_DATES', 'The due date must follow the planned start date.');
  if (
    !labelsChanged &&
    Object.entries(fields).every(([key, value]) => task[key as keyof Task] === value)
  )
    return { task, replayed: true };
  await tx.query(
    'UPDATE tasks SET title=$3,description=$4,priority=$5,assignee_id=$6,parent_id=$7,due_date=$8,project_id=$9,milestone_id=$10,version=version+1 WHERE workspace_id=$1 AND id=$2',
    [
      p.workspaceId,
      id,
      fields.title,
      fields.description,
      fields.priority,
      fields.assignee_id,
      fields.parent_id,
      fields.due_date,
      fields.project_id,
      fields.milestone_id,
    ],
  );
  if (labelsChanged) await setTaskLabels(tx, p, id, labels);
  if (validateGraph) await tx.query('SELECT assert_task_graph($1,$2)', [p.workspaceId, id]);
  await recordChange(tx, p, 'task.updated', id, task.conversation_id);
  if (fields.assignee_id !== task.assignee_id)
    await recordChange(tx, p, 'task.assigned', id, task.conversation_id);
  return { task: await getTask(tx, p, id), replayed: false };
}
export async function transitionTask(
  tx: Sql,
  p: Identity,
  task: Task,
  input: z.infer<typeof taskTransition>,
  validateGraph = true,
) {
  const id = task.id;
  checkVersion(task, input.version);
  if (!taskMoves[task.state].includes(input.state))
    throw new AppError(409, 'INVALID_TRANSITION', 'This state change is not allowed.');
  if (input.state === 'completed' && (!input.evidence || p.kind !== 'human'))
    throw new AppError(
      400,
      'EVIDENCE_REQUIRED',
      'A person must supply verification evidence to complete this task.',
    );
  await tx.query('UPDATE tasks SET state=$3,version=version+1 WHERE workspace_id=$1 AND id=$2', [
    p.workspaceId,
    id,
    input.state,
  ]);
  if (validateGraph) await tx.query('SELECT assert_task_graph($1,$2)', [p.workspaceId, id]);
  await tx.query(
    'INSERT INTO task_transitions(id,workspace_id,task_id,actor_id,evidence,from_state,to_state,task_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      randomUUID(),
      p.workspaceId,
      id,
      p.membershipId,
      input.evidence,
      task.state,
      input.state,
      task.version + 1,
    ],
  );
  await recordChange(tx, p, 'task.transitioned', id, task.conversation_id);
  return { ok: true, version: task.version + 1 };
}
