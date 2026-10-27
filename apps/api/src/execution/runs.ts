import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import { runInput } from '@ao/contracts';
import { requireConversation, type Identity } from '../lib/policy.js';
import { publishRunResult } from './results.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { recordChange } from '../lib/events.js';
import { runIdentities } from './policy.js';
import type { RunRow, HostedRuntime } from './types.js';
import { checkpoint, executionPolicy, reserveSpending, settleSpending } from './controls.js';
import { agentConfiguration } from '@ao/contracts/agents';
export async function enqueueRun(
  tx: Sql,
  identity: Identity,
  input: ReturnType<typeof runInput.parse>,
) {
  if (identity.kind !== 'human')
    throw new AppError(403, 'HUMAN_REQUIRED', 'Only a person can initiate a hosted run.');
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [identity.workspaceId]);
  const requestHash = digest(
    JSON.stringify({
      agentId: input.agentId,
      conversationId: input.conversationId,
      prompt: input.prompt,
    }),
  );
  const [existing] = await tx.query<RunRow>(
    'SELECT * FROM agent_runs WHERE workspace_id=$1 AND requester_id=$2 AND request_key=$3',
    [identity.workspaceId, identity.membershipId, input.requestKey],
  );
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This request key belongs to a different run.',
      );
    return { id: existing.id, replayed: true };
  }
  const [agent] = await tx.query(
    'SELECT a.instructions,a.revision,v.configuration FROM agents a JOIN agent_revisions v ON v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision WHERE a.workspace_id=$1 AND a.id=$2',
    [identity.workspaceId, input.agentId],
  );
  if (!agent) throw notFound();
  const configuration = agentConfiguration.parse(agent.configuration);
  if (
    configuration.activation === 'disabled' ||
    (configuration.conversationIds.length &&
      !configuration.conversationIds.includes(input.conversationId))
  )
    throw new AppError(409, 'AGENT_INACTIVE', 'The agent is not activated for this conversation.');
  const policy = await executionPolicy(tx, identity.workspaceId);
  const [authority] = await tx.query('SELECT * FROM public.member_account_authority($1,$2)', [
    identity.workspaceId,
    identity.membershipId,
  ]);
  const run: RunRow = {
    id: randomUUID(),
    workspace_id: identity.workspaceId,
    agent_id: input.agentId,
    requester_id: identity.membershipId,
    requester_auth_version: Number(authority?.auth_version ?? 0),
    conversation_id: input.conversationId,
    instructions: String(agent.instructions),
    prompt: input.prompt,
    status: 'queued',
    session_id: null,
    lease_token: null,
    dispatch_started: false,
    configuration,
    agent_revision: Number(agent.revision),
  };
  await runIdentities(tx, run);
  const [count] = await tx.query('SELECT open_runs count FROM execution_totals($1)', [
    identity.workspaceId,
  ]);
  if (Number(count?.count) >= Number(policy.max_open_runs))
    throw new AppError(429, 'RUN_LIMIT', 'This workspace has reached its open run limit.');
  await tx.query(
    'INSERT INTO agent_runs(id,workspace_id,agent_id,requester_id,conversation_id,request_key,request_hash,prompt,instructions,requester_auth_version,agent_revision,configuration,policy_version,requester_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,workspace_policy_version($2))',
    [
      run.id,
      run.workspace_id,
      run.agent_id,
      run.requester_id,
      run.conversation_id,
      input.requestKey,
      requestHash,
      input.prompt,
      run.instructions,
      run.requester_auth_version,
      run.agent_revision,
      JSON.stringify(configuration),
      policy.version,
    ],
  );
  await tx.query(
    "UPDATE agent_runs SET automation_occurrence_id=nullif(current_setting('ao.automation_occurrence_id',true),'')::uuid WHERE workspace_id=$1 AND id=$2",
    [run.workspace_id, run.id],
  );
  if (identity.platformCredentialId)
    await tx.query(
      'UPDATE agent_runs SET platform_credential_id=$3 WHERE workspace_id=$1 AND id=$2',
      [run.workspace_id, run.id, identity.platformCredentialId],
    );
  await reserveSpending(
    tx,
    identity.workspaceId,
    run.id,
    configuration.limits.reservationMicros,
    policy,
  );
  await recordChange(tx, identity, 'run.queued', run.id, run.conversation_id);
  return { id: run.id, replayed: false };
}
export async function cancelRun(
  db: Database,
  runtime: HostedRuntime,
  identity: Identity,
  runId: string,
) {
  const session = await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [identity.workspaceId]);
    const [run] = await tx.query<RunRow>(
      'SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [identity.workspaceId, runId],
    );
    if (!run) throw notFound();
    if (
      identity.kind !== 'human' ||
      (run.requester_id !== identity.membershipId &&
        run.owner_id !== identity.membershipId &&
        !['owner', 'admin'].includes(identity.role))
    )
      throw new AppError(
        403,
        'FORBIDDEN',
        'Only the requester or an administrator can cancel a run.',
      );
    await requireConversation(tx, identity, run.conversation_id);
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return null;
    await tx.query(
      "UPDATE agent_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
      [run.id],
    );
    await tx.query(
      "UPDATE tool_invocations SET status='cancelled' WHERE run_id=$1 AND status IN ('pending','approved')",
      [run.id],
    );
    await recordChange(tx, identity, 'run.cancelled', run.id, run.conversation_id);
    return run.session_id;
  });
  if (session) {
    try {
      await runtime.cancel(session);
    } catch {}
  }
  return { ok: true };
}

export async function reconcileRun(
  db: Database,
  runtime: HostedRuntime,
  identity: Identity,
  runId: string,
) {
  const [run] = await db.query<RunRow>('SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2', [
    identity.workspaceId,
    runId,
  ]);
  if (!run) throw notFound();
  if (
    identity.kind !== 'human' ||
    (run.requester_id !== identity.membershipId && !['owner', 'admin'].includes(identity.role))
  )
    throw new AppError(
      403,
      'FORBIDDEN',
      'Only the requester or an administrator can reconcile a run.',
    );
  await requireConversation(db, identity, run.conversation_id);
  if (run.status !== 'outcome_unknown' || !run.session_id)
    throw new AppError(
      409,
      'NOT_RECONCILABLE',
      'No uncertain hosted session is available for this run.',
    );
  if (!runtime.configured)
    throw new AppError(503, 'RUNTIME_UNAVAILABLE', 'Hosted execution is not configured.');
  const recovered = runtime.recoverDetailed
    ? await runtime.recoverDetailed(run.session_id, AbortSignal.timeout(10000))
    : null;
  const result = runtime.recoverDetailed
    ? recovered?.output
    : await runtime.recover(run.session_id, AbortSignal.timeout(10000));
  if (!result)
    throw new AppError(
      409,
      'NO_SETTLED_RESULT',
      'The hosted session has no settled result. No model request has been repeated.',
    );
  await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [identity.workspaceId]);
    const [current] = await tx.query<RunRow>('SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE', [
      runId,
    ]);
    if (!current || current.status !== 'outcome_unknown' || current.session_id !== run.session_id)
      throw new AppError(409, 'RUN_CHANGED', 'The run changed while checking its session.');
    await publishRunResult(tx, current, result);
    await settleSpending(tx, current, recovered?.usage);
    await checkpoint(
      tx,
      current,
      'recovered',
      'A settled remote result was recovered without resending input.',
    );
    await recordChange(tx, identity, 'run.reconciled', runId, run.conversation_id);
  });
  return { ok: true };
}
