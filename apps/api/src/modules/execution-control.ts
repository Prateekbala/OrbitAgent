import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database, Sql } from '@ao/database';
import { id } from '@ao/contracts';
import { delegationInput, executionPolicyInput } from '@ao/contracts/agents';
import { authenticate } from './auth.js';
import type { HostedRuntime, RunRow } from '../execution/types.js';
import {
  executionPolicy,
  checkpoint,
  publicTrace,
  runConfiguration,
} from '../execution/controls.js';
import { delegateRun } from '../execution/delegation.js';
import { enqueueRun } from '../execution/runs.js';
import { runIdentities, requireRunContext } from '../execution/policy.js';
import {
  lockAdministrator,
  requireAdmin,
  requireConversation,
  type Identity,
} from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { coordinationState, escalateDelegation } from '../execution/coordination.js';
import { hasPermission } from '../identity/authorization.js';

const pathId = (params: unknown) => id.parse((params as { id: string }).id);
async function visibleRun(tx: Sql, p: Identity, runId: string, lock = false) {
  const [run] = await tx.query<RunRow>(
    `SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
    [p.workspaceId, runId],
  );
  if (!run) throw notFound();
  await requireConversation(tx, p, run.conversation_id);
  return run;
}
function managesRun(p: Identity, run: RunRow) {
  if (
    p.kind !== 'human' ||
    (p.membershipId !== run.requester_id && !['owner', 'admin'].includes(p.role))
  )
    throw new AppError(
      403,
      'FORBIDDEN',
      'Only the requester or an administrator can control this run.',
    );
}
export function executionControlRoutes(app: FastifyInstance, db: Database, runtime: HostedRuntime) {
  app.get('/v1/execution/policy', async (req) => {
    const p = await authenticate(db, req);
    requireAdmin(p);
    return db.transaction(async (tx) => {
      const policy = await executionPolicy(tx, p.workspaceId);
      const [usage] = await tx.query(
        'SELECT reserved_micros::text,spent_micros::text FROM execution_totals($1)',
        [p.workspaceId],
      );
      return { ...policy, ...usage };
    });
  });
  app.put('/v1/execution/policy', async (req) => {
    const p = await authenticate(db, req),
      input = executionPolicyInput.parse(req.body);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'execution.manage');
      await executionPolicy(tx, p.workspaceId);
      const [updated] = await tx.query(
        'UPDATE execution_policies SET version=version+1,budget_micros=$3,max_open_runs=$4,max_concurrent_runs=$5,max_agent_concurrent=$6,max_requester_concurrent=$7,max_delegation_depth=$8,max_delegation_children=$9 WHERE workspace_id=$1 AND version=$2 RETURNING *',
        [
          p.workspaceId,
          input.version,
          input.budgetMicros,
          input.maxOpenRuns,
          input.maxConcurrentRuns,
          input.maxAgentConcurrent,
          input.maxRequesterConcurrent,
          input.maxDelegationDepth,
          input.maxDelegationChildren,
        ],
      );
      if (!updated)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Execution policy changed. Refresh before saving.',
        );
      await recordChange(tx, p, 'execution.policy_changed', p.workspaceId);
      return updated;
    });
  });
  app.get('/v1/runs/:id/detail', async (req) => {
    const p = await authenticate(db, req),
      run = await visibleRun(db, p, pathId(req.params));
    const [spending] = await db.query(
      'SELECT amount_micros,state,actual_micros,input_tokens,output_tokens,receipt,settled_at FROM execution_reservations WHERE workspace_id=$1 AND run_id=$2',
      [p.workspaceId, run.id],
    );
    const tasks = hasPermission(p, 'tasks.read')
      ? await db.query(
          'SELECT t.id,t.title,t.state,t.version FROM task_runs link JOIN tasks t ON t.workspace_id=link.workspace_id AND t.id=link.task_id WHERE link.workspace_id=$1 AND link.run_id=$2 ORDER BY link.created_at LIMIT 100',
          [p.workspaceId, run.id],
        )
      : [];
    const children = await db.query(
      'SELECT id,status,verification_status,owner_id,verifier_id,delegation_deadline,output_contract,stop_condition,delegation_budget_micros FROM agent_runs WHERE workspace_id=$1 AND parent_run_id=$2 ORDER BY created_at LIMIT 100',
      [p.workspaceId, run.id],
    );
    const checkpoints = await db.query(
      'SELECT ordinal,kind,summary,created_at FROM run_checkpoints WHERE workspace_id=$1 AND run_id=$2 ORDER BY ordinal DESC LIMIT 50',
      [p.workspaceId, run.id],
    );
    return {
      coordination_status: await coordinationState(db, p.workspaceId, run.id),
      id: run.id,
      status: run.status,
      configuration: run.configuration,
      agent_revision: run.agent_revision,
      parent_run_id: run.parent_run_id,
      resumed_from: run.resumed_from,
      owner_id: run.owner_id,
      verifier_id: run.verifier_id,
      verification_status: run.verification_status,
      verification_evidence: run.verification_evidence,
      output_contract: run.output_contract,
      stop_condition: run.stop_condition,
      delegation_deadline: run.delegation_deadline,
      spending: spending ?? null,
      tasks,
      children,
      checkpoints,
    };
  });
  app.get('/v1/runs/:id/traces', async (req) => {
    const p = await authenticate(db, req),
      run = await visibleRun(db, p, pathId(req.params)),
      q = z.object({ after: z.string().regex(/^\d+$/).default('0') }).parse(req.query);
    const rows = await db.query(
      'SELECT id::text,kind,summary,resource_id,created_at FROM run_traces WHERE workspace_id=$1 AND run_id=$2 AND id>$3 ORDER BY id LIMIT 101',
      [p.workspaceId, run.id, q.after],
    );
    return { items: rows.slice(0, 100), next: rows.length > 100 ? rows[99]!.id : null };
  });
  app.get('/v1/runs/:id/export', async (req, reply) => {
    const p = await authenticate(db, req),
      run = await visibleRun(db, p, pathId(req.params));
    const traces = await db.query(
      'SELECT id::text,kind,summary,resource_id,created_at FROM run_traces WHERE workspace_id=$1 AND run_id=$2 ORDER BY id LIMIT 10001',
      [p.workspaceId, run.id],
    );
    if (traces.length > 10000)
      throw new AppError(413, 'EXPORT_LIMIT', 'Use paginated traces for this run.');
    const actions = await db.query(
      'SELECT tool_name,status,parameters,result,error_code,action_digest FROM tool_invocations WHERE workspace_id=$1 AND run_id=$2 ORDER BY ordinal',
      [p.workspaceId, run.id],
    );
    const artifacts = hasPermission(p, 'tasks.read')
      ? await db.query(
          'SELECT DISTINCT a.id,a.kind,a.title,a.url,a.details,a.file_id,a.created_at FROM task_runs l JOIN task_artifacts a ON a.workspace_id=l.workspace_id AND a.task_id=l.task_id WHERE l.workspace_id=$1 AND l.run_id=$2 ORDER BY a.created_at LIMIT 1001',
          [p.workspaceId, run.id],
        )
      : [];
    if (artifacts.length > 1000)
      throw new AppError(413, 'EXPORT_LIMIT', 'Use task artifact pagination for this run.');
    return reply.header('content-disposition', `attachment; filename="run-${run.id}.json"`).send({
      schemaVersion: 1,
      run: {
        id: run.id,
        status: run.status,
        agentRevision: run.agent_revision,
        prompt: run.prompt,
        result: run.result,
        createdAt: run.created_at,
      },
      traces,
      actions,
      artifacts,
    });
  });
  app.post('/v1/runs/:id/resume', async (req) => {
    const p = await authenticate(db, req);
    if (!runtime.configured || !runtime.capabilities?.resumeObservation || !runtime.observe)
      throw new AppError(
        409,
        'RECOVERY_NOT_QUALIFIED',
        'This deployment has not qualified durable observation recovery.',
      );
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const run = await visibleRun(tx, p, pathId(req.params), true);
      managesRun(p, run);
      if (run.status !== 'outcome_unknown' || !run.session_id)
        throw new AppError(
          409,
          'NOT_RESUMABLE',
          'Only uncertain dispatched sessions can resume observation.',
        );
      await runIdentities(tx, run);
      await requireRunContext(tx, run);
      const config = runConfiguration(run);
      if (run.delegation_deadline && new Date(run.delegation_deadline).getTime() <= Date.now())
        throw new AppError(409, 'DEADLINE_EXPIRED', 'The delegation deadline has expired.');
      await tx.query(
        "UPDATE agent_runs SET status='queued',lease_token=NULL,lease_expires_at=NULL,deadline_at=least(now()+$3*interval '1 second',coalesce(delegation_deadline,'infinity'::timestamptz)),error_code=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, run.id, config.limits.maxSeconds],
      );
      await checkpoint(
        tx,
        run,
        'recovered',
        'Resume observation requested; no new model input will be sent.',
      );
      await recordChange(tx, p, 'run.resumed', run.id, run.conversation_id);
      return { ok: true };
    });
  });
  app.post('/v1/runs/:id/restart', async (req) => {
    const p = await authenticate(db, req),
      input = z.object({ requestKey: z.uuid() }).strict().parse(req.body);
    if (!runtime.configured)
      throw new AppError(503, 'RUNTIME_UNAVAILABLE', 'Hosted execution is not configured.');
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const run = await visibleRun(tx, p, pathId(req.params), true);
      managesRun(p, run);
      if (!['failed', 'cancelled'].includes(run.status) || run.parent_run_id)
        throw new AppError(
          409,
          'RESTART_NOT_ALLOWED',
          'Restart requires a stopped root run with a known spending outcome.',
        );
      const [reserved] = await tx.query(
        "SELECT run_id FROM execution_reservations WHERE workspace_id=$1 AND run_id=$2 AND state='reserved'",
        [p.workspaceId, run.id],
      );
      if (reserved)
        throw new AppError(
          409,
          'RECONCILIATION_REQUIRED',
          'Reconcile the provider outcome and reservation before restarting.',
        );
      const created = await enqueueRun(tx, p, {
        agentId: run.agent_id,
        conversationId: run.conversation_id,
        prompt: run.prompt,
        requestKey: input.requestKey,
      });
      await tx.query('UPDATE agent_runs SET resumed_from=$3 WHERE workspace_id=$1 AND id=$2', [
        p.workspaceId,
        created.id,
        run.id,
      ]);
      return created;
    });
  });
  app.post('/v1/runs/:id/spending', async (req) => {
    const p = await authenticate(db, req),
      input = z
        .object({
          actualMicros: z.number().int().min(0).max(1000000000),
          receipt: z.string().trim().min(10).max(2000),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'execution.manage');
      const run = await visibleRun(tx, p, pathId(req.params), true);
      if (!['outcome_unknown', 'failed', 'cancelled'].includes(run.status))
        throw new AppError(
          409,
          'RUN_ACTIVE',
          'Only stopped or uncertain runs require manual reconciliation.',
        );
      const [row] = await tx.query(
        "UPDATE execution_reservations SET state='settled',actual_micros=$3,receipt=$4,settled_by=$5,settled_at=now() WHERE workspace_id=$1 AND run_id=$2 AND state='reserved' RETURNING run_id",
        [p.workspaceId, run.id, input.actualMicros, input.receipt, p.membershipId],
      );
      if (!row)
        throw new AppError(409, 'ALREADY_RECONCILED', 'This reservation is already settled.');
      await publicTrace(
        tx,
        run,
        'spending',
        'An administrator reconciled spending against provider evidence.',
      );
      await recordChange(tx, p, 'run.spending_reconciled', run.id, run.conversation_id);
      return { ok: true };
    });
  });
  app.post('/v1/runs/:id/delegations', async (req) => {
    const p = await authenticate(db, req),
      input = delegationInput.parse(req.body);
    return db.transaction((tx) => delegateRun(tx, p, pathId(req.params), input));
  });
  app.post('/v1/runs/:id/verification', async (req) => {
    const p = await authenticate(db, req),
      input = z
        .object({
          decision: z.enum(['accepted', 'rejected']),
          evidence: z.string().trim().min(10).max(4000),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const run = await visibleRun(tx, p, pathId(req.params), true);
      if (
        p.kind !== 'human' ||
        !hasPermission(p, 'execution.read') ||
        !hasPermission(p, 'messages.read') ||
        p.membershipId !== run.verifier_id ||
        p.membershipId === run.owner_id ||
        p.membershipId === run.requester_id
      )
        throw new AppError(
          403,
          'INDEPENDENT_VERIFIER',
          'Only the independent named verifier can accept this result.',
        );
      if (
        run.status !== 'succeeded' ||
        !['pending', 'escalated'].includes(String(run.verification_status))
      )
        throw new AppError(
          409,
          'VERIFICATION_UNAVAILABLE',
          'Verification requires an unreviewed successful child run.',
        );
      await tx.query(
        'UPDATE agent_runs SET verification_status=$3,verification_evidence=$4,verified_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, run.id, input.decision, input.evidence],
      );
      await publicTrace(tx, run, 'verification', `Independent verification ${input.decision}.`);
      if (input.decision === 'rejected') await escalateDelegation(tx, run);
      await recordChange(tx, p, 'run.verified', run.id, run.conversation_id);
      return { ok: true };
    });
  });
}
