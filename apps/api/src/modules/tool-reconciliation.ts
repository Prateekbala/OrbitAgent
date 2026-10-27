import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { authenticate } from './auth.js';
import { lockAdministrator } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { settleRun } from '../execution/gateway.js';
import type { RunRow } from '../execution/types.js';
export function toolReconciliationRoutes(app: FastifyInstance, db: Database) {
  app.post('/v1/execution/actions/:id/reconcile', async (req) => {
    const p = await authenticate(db, req),
      invocationId = z.uuid().parse((req.params as { id: string }).id),
      input = z
        .object({
          outcome: z.enum(['succeeded', 'not_applied']),
          receipt: z.string().trim().min(5).max(500),
          evidence: z.string().trim().min(20).max(2000),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const role = await lockAdministrator(tx, p, 'execution.manage');
      if (role !== 'owner')
        throw new AppError(
          403,
          'OWNER_REQUIRED',
          'A workspace owner must attest an uncertain external result.',
        );
      const [inv] = await tx.query(
        'SELECT run_id FROM tool_invocations WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, invocationId],
      );
      if (!inv) throw notFound();
      const [run] = await tx.query<RunRow>(
        'SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [p.workspaceId, inv.run_id],
      );
      if (!run) throw notFound();
      await tx.query('SELECT id FROM tool_invocations WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
        p.workspaceId,
        invocationId,
      ]);
      const [action] = await tx.query(
        'SELECT id,state FROM tool_actions WHERE workspace_id=$1 AND invocation_id=$2 FOR UPDATE',
        [p.workspaceId, invocationId],
      );
      if (!action) throw notFound();
      if (action.state !== 'outcome_unknown')
        throw new AppError(
          409,
          'ACTION_NOT_UNCERTAIN',
          'Only an uncertain action may be reconciled by an operator.',
        );
      const state = input.outcome === 'succeeded' ? 'succeeded' : 'failed',
        receipt = 'manual:' + input.receipt;
      await tx.query('UPDATE tool_actions SET state=$2,receipt=$3,error_code=$4 WHERE id=$1', [
        action.id,
        state,
        receipt,
        state === 'failed' ? 'OPERATOR_CONFIRMED_NOT_APPLIED' : null,
      ]);
      await tx.query(
        'INSERT INTO tool_action_events(workspace_id,action_id,state,actor_id,receipt) VALUES($1,$2,$3,$4,$5)',
        [p.workspaceId, action.id, 'operator_evidence', p.membershipId, input.evidence],
      );
      await tx.query(
        "UPDATE tool_invocations SET status=$3,result=$4,error_code=$5 WHERE workspace_id=$1 AND id=$2 AND status IN ('executing','outcome_unknown')",
        [
          p.workspaceId,
          invocationId,
          state,
          JSON.stringify({ receipt }),
          state === 'failed' ? 'OPERATOR_CONFIRMED_NOT_APPLIED' : null,
        ],
      );
      await recordChange(tx, p, 'tool.action_reconciled', invocationId, run.conversation_id);
      await settleRun(tx, run);
      return { ok: true };
    });
  });
}
