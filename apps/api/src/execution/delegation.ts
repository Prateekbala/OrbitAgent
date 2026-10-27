import type { Sql } from '@ao/database';
import type { z } from 'zod';
import { delegationInput } from '@ao/contracts/agents';
import { AppError, notFound } from '../lib/errors.js';
import type { Identity } from '../lib/policy.js';
import { requireConversation } from '../lib/policy.js';
import { enqueueRun } from './runs.js';
import { executionPolicy, publicTrace, runConfiguration } from './controls.js';
import { runIdentities } from './policy.js';
import { digest } from '../lib/security.js';
import { hasPermission } from '../identity/authorization.js';
import { managesTask } from '../tasks/queries.js';
import type { RunRow } from './types.js';

export async function delegateRun(
  tx: Sql,
  p: Identity,
  parentId: string,
  input: z.infer<typeof delegationInput>,
) {
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
  const [parent] = await tx.query<RunRow>(
    'SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [p.workspaceId, parentId],
  );
  if (!parent) throw notFound();
  if (!['running', 'awaiting_approval', 'succeeded'].includes(parent.status))
    throw new AppError(
      409,
      'PARENT_STOPPED',
      'Delegation requires a live or successfully completed parent run.',
    );
  const { requester } = await runIdentities(tx, parent);
  if (
    p.kind !== 'human' ||
    (p.membershipId !== parent.requester_id && !['owner', 'admin'].includes(p.role))
  )
    throw new AppError(
      403,
      'FORBIDDEN',
      'The requester or an administrator must authorize delegation.',
    );
  await requireConversation(tx, p, parent.conversation_id);
  const policy = await executionPolicy(tx, p.workspaceId),
    configuration = runConfiguration(parent),
    root = parent.root_run_id ?? parent.id;
  const delegationHash = digest(JSON.stringify(input));
  const [existing] = await tx.query(
    'SELECT id FROM agent_runs WHERE workspace_id=$1 AND parent_run_id=$2 AND request_key=$3',
    [p.workspaceId, parent.id, input.requestKey],
  );
  if (existing) {
    const [hash] = await tx.query(
      'SELECT delegation_hash FROM agent_runs WHERE workspace_id=$1 AND id=$2',
      [p.workspaceId, existing.id],
    );
    if (hash?.delegation_hash !== delegationHash)
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This delegation key belongs to another request.',
      );
    return { id: String(existing.id), replayed: true };
  }
  if (Number(parent.delegation_depth ?? 0) >= Number(policy.max_delegation_depth))
    throw new AppError(409, 'DELEGATION_DEPTH', 'The delegation depth limit was reached.');
  const ancestry = await tx.query(
    'WITH RECURSIVE ancestors AS (SELECT id,parent_run_id,agent_id FROM agent_runs WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT r.id,r.parent_run_id,r.agent_id FROM agent_runs r JOIN ancestors a ON r.id=a.parent_run_id WHERE r.workspace_id=$1) SELECT agent_id FROM ancestors',
    [p.workspaceId, parent.id],
  );
  if (ancestry.some((row) => row.agent_id === input.agentId))
    throw new AppError(409, 'DELEGATION_LOOP', 'An agent cannot delegate back to an ancestor.');
  const [children] = await tx.query(
    'SELECT count(*)::int count,coalesce(sum(delegation_budget_micros),0)::text allocated FROM agent_runs WHERE workspace_id=$1 AND parent_run_id=$2',
    [p.workspaceId, parent.id],
  );
  if (Number(children?.count) >= Number(policy.max_delegation_children))
    throw new AppError(409, 'DELEGATION_LIMIT', 'The parent has reached its child limit.');
  const allowance = parent.parent_run_id
    ? Math.max(0, Number(parent.delegation_budget_micros) - configuration.limits.reservationMicros)
    : configuration.limits.reservationMicros;
  if (Number(children?.allocated) + input.budgetMicros > allowance)
    throw new AppError(
      409,
      'DELEGATION_BUDGET',
      'Child budgets exceed the parent’s delegation allowance.',
    );
  const deadline = new Date(input.deadline).getTime(),
    parentDeadline = parent.delegation_deadline
      ? new Date(parent.delegation_deadline).getTime()
      : Date.now() + 86400000;
  if (deadline <= Date.now() || deadline > parentDeadline || deadline > Date.now() + 86400000)
    throw new AppError(
      400,
      'DELEGATION_DEADLINE',
      'Choose a future deadline within one day and the parent deadline.',
    );
  if (input.ownerId === input.verifierId || input.verifierId === parent.requester_id)
    throw new AppError(
      400,
      'INDEPENDENT_VERIFIER',
      'The verifier must be independent of the owner and originating requester.',
    );
  for (const member of [input.ownerId, input.verifierId]) {
    const [row] = await tx.query(
      "SELECT id,permissions FROM memberships WHERE workspace_id=$1 AND id=$2 AND kind='human' AND status='active' AND access_type='member' FOR SHARE",
      [p.workspaceId, member],
    );
    if (
      !row ||
      (row.permissions as Record<string, unknown>)['execution.manage'] === false ||
      (row.permissions as Record<string, unknown>)['execution.read'] === false ||
      (row.permissions as Record<string, unknown>)['messages.read'] === false
    )
      throw new AppError(
        400,
        'INVALID_DELEGATION_OWNER',
        'Choose active human owners and verifiers with execution permission.',
      );
    await requireConversation(tx, { ...p, membershipId: member }, parent.conversation_id);
    const [visible] = await tx.query('SELECT resource_visible_to($1,$2,$3,$4) visible', [
      p.workspaceId,
      parent.conversation_id,
      parent.created_at,
      member,
    ]);
    if (!visible?.visible)
      throw new AppError(
        403,
        'DELEGATION_HISTORY',
        'Owners and verifiers must have access to the source run history.',
      );
  }
  const [target] = await tx.query(
    'SELECT membership_id FROM agents WHERE workspace_id=$1 AND id=$2',
    [p.workspaceId, input.agentId],
  );
  const [targetHistory] = target
    ? await tx.query('SELECT resource_visible_to($1,$2,$3,$4) visible', [
        p.workspaceId,
        parent.conversation_id,
        parent.created_at,
        target.membership_id,
      ])
    : [];
  if (!targetHistory?.visible)
    throw new AppError(
      403,
      'DELEGATION_HISTORY',
      'The target agent must have access to the source run history.',
    );
  const queued = await enqueueRun(tx, requester, {
    agentId: input.agentId,
    conversationId: parent.conversation_id,
    prompt: input.prompt,
    requestKey: input.requestKey,
  });
  if (queued.replayed)
    throw new AppError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'This request key already belongs to another run.',
    );
  const [child] = await tx.query<RunRow>(
    'SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [p.workspaceId, queued.id],
  );
  const childConfiguration = runConfiguration(child!);
  childConfiguration.tools = childConfiguration.tools.filter((tool) =>
    configuration.tools.includes(tool),
  );
  childConfiguration.skills = childConfiguration.skills.filter((skill) =>
    configuration.skills.includes(skill),
  );
  for (const limit of ['maxSeconds', 'maxInputTokens', 'maxOutputTokens', 'maxTools'] as const)
    childConfiguration.limits[limit] = Math.min(
      childConfiguration.limits[limit],
      configuration.limits[limit],
    );
  if (input.budgetMicros < childConfiguration.limits.reservationMicros)
    throw new AppError(
      409,
      'DELEGATION_BUDGET',
      'The child requires a larger spending reservation.',
    );
  await tx.query(
    "UPDATE agent_runs SET parent_run_id=$3,root_run_id=$4,delegation_depth=$5,owner_id=$6,verifier_id=$7,output_contract=$8,stop_condition=$9,delegation_deadline=$10,delegation_budget_micros=$11,verification_status='pending',configuration=$12,delegation_hash=$13 WHERE workspace_id=$1 AND id=$2",
    [
      p.workspaceId,
      queued.id,
      parent.id,
      root,
      Number(parent.delegation_depth ?? 0) + 1,
      input.ownerId,
      input.verifierId,
      input.outputContract,
      input.stopCondition,
      input.deadline,
      input.budgetMicros,
      JSON.stringify(childConfiguration),
      delegationHash,
    ],
  );
  if (input.taskId) {
    const [task] = await tx.query<
      {
        id: string;
        conversation_id: string | null;
        created_at: string | Date;
        created_by: string;
        assignee_id: string | null;
        is_collaborator: boolean;
      } & Record<string, unknown>
    >(
      "SELECT t.id,t.conversation_id,t.created_at,t.created_by,t.assignee_id,EXISTS(SELECT 1 FROM task_participants tp WHERE tp.workspace_id=t.workspace_id AND tp.task_id=t.id AND tp.membership_id=$3 AND tp.role='collaborator') is_collaborator FROM tasks t WHERE t.workspace_id=$1 AND t.id=$2",
      [p.workspaceId, input.taskId, requester.membershipId],
    );
    if (!task || task.conversation_id !== parent.conversation_id)
      throw new AppError(
        400,
        'DELEGATION_TASK_AUDIENCE',
        'The task must share the source conversation.',
      );
    if (
      !hasPermission(requester, 'tasks.read') ||
      !hasPermission(requester, 'tasks.write') ||
      !managesTask(requester, task)
    )
      throw new AppError(
        403,
        'TASK_PERMISSION_REQUIRED',
        'The original requester must be allowed to manage the linked task.',
      );
    const [taskHistory] = await tx.query(
      'SELECT resource_visible_to($1,$2,$3,$4) requester_visible,resource_visible_to($1,$2,$3,$5) agent_visible',
      [
        p.workspaceId,
        parent.conversation_id,
        task.created_at,
        requester.membershipId,
        target!.membership_id,
      ],
    );
    if (!taskHistory?.requester_visible || !taskHistory.agent_visible)
      throw new AppError(
        403,
        'DELEGATION_HISTORY',
        'Both the requester and target agent need the linked task’s history.',
      );
    await tx.query(
      'INSERT INTO task_runs(workspace_id,task_id,run_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [p.workspaceId, input.taskId, queued.id, p.membershipId],
    );
  }
  await publicTrace(
    tx,
    parent,
    'delegation',
    'Delegated work with a named owner, independent verifier, deadline and output contract.',
    queued.id,
  );
  return queued;
}
