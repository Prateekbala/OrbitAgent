import type { RemoteMcp } from '../developer/remote-mcp.js';
import { remoteTool } from '../developer/remote-mcp.js';
import type { ActionAuthorization } from './registry.js';
import { z } from 'zod';
import { digest } from '../lib/security.js';
import {
  scopedDatabase,
  dispatcherScope,
  workerScope,
  type Database,
  type Sql,
} from '@ao/database';
import { toolProposal } from '@ao/contracts';
import type { IdentitySecrets } from '../identity/secrets.js';
import type { ActionProvider, ProviderReceipt } from './provider.js';
import type { CodeExecutor } from './sandbox.js';
import { validateAuthorization, settleRun } from '../execution/gateway.js';
import type { InvocationRow, RunRow } from '../execution/types.js';
import { AppError } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { runIdentities } from '../execution/policy.js';
import type { NativeConnectorActions } from '../connections/native-actions.js';

interface ActionRow extends Record<string, unknown> {
  id: string;
  invocation_id: string;
  state: string;
  idempotency_key: string;
  capability_hash: string;
}
export class ToolActionWorker {
  private cursor = 0;
  private busy = false;
  private stopped = false;
  private active: Promise<void> | null = null;
  constructor(
    private db: Database,
    private secrets: IdentitySecrets,
    private provider: ActionProvider,
    private code: CodeExecutor,
    private onError: (code: string) => void = () => {},
    private native?: NativeConnectorActions,
    private remote?: RemoteMcp,
  ) {
    this.db = scopedDatabase(db);
  }
  start() {
    const timer = setInterval(() => {
      if (!this.busy && !this.stopped)
        this.active = this.tick().catch(() => this.onError('TOOL_WORKER_FAILED'));
    }, 1000);
    timer.unref();
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      await this.active;
    };
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const workspaces = await dispatcherScope(() =>
        this.db.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id'),
      );
      const jobs: { workspaceId: string; actionId: string }[] = [];
      for (let offset = 0; offset < workspaces.length && jobs.length < 4; offset++) {
        const w = workspaces[(this.cursor + offset) % workspaces.length]!;
        if (this.stopped) break;
        const actions = await workerScope(w.id, async () => {
          await this.db.query(
            "UPDATE tool_actions SET state='outcome_unknown',error_code='DISPATCH_INTERRUPTED' WHERE state='dispatched' AND updated_at<now()-interval '45 seconds'",
          );
          return this.db.query<ActionRow>(
            "SELECT * FROM tool_actions WHERE state='prepared' OR state='outcome_unknown' AND updated_at<now()-interval '60 seconds' ORDER BY created_at LIMIT 4",
          );
        });
        for (const a of actions.slice(0, 4 - jobs.length))
          jobs.push({ workspaceId: w.id, actionId: a.id });
      }
      this.cursor = workspaces.length ? (this.cursor + 1) % workspaces.length : 0;
      const outcomes = await Promise.allSettled(
        jobs.map((job) => this.process(job.workspaceId, job.actionId)),
      );
      for (const outcome of outcomes)
        if (outcome.status === 'rejected') this.onError('TOOL_ACTION_FAILED');
    } finally {
      this.busy = false;
    }
  }
  async process(workspaceId: string, actionId: string) {
    return workerScope(workspaceId, async () => {
      const job = await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
        const [ref] = await tx.query<ActionRow>(
          'SELECT * FROM tool_actions WHERE workspace_id=$1 AND id=$2',
          [workspaceId, actionId],
        );
        if (!ref) return;
        const [inv] = await tx.query<InvocationRow>(
          'SELECT * FROM tool_invocations WHERE workspace_id=$1 AND id=$2',
          [workspaceId, ref.invocation_id],
        );
        if (!inv) return;
        const [run] = await tx.query<RunRow>(
          'SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [workspaceId, inv.run_id],
        );
        if (!run) return;
        await tx.query('SELECT id FROM tool_invocations WHERE id=$1 FOR UPDATE', [inv.id]);
        const [a] = await tx.query<ActionRow>('SELECT * FROM tool_actions WHERE id=$1 FOR UPDATE', [
          ref.id,
        ]);
        if (!a || !['prepared', 'outcome_unknown'].includes(a.state)) return;
        const proposal = toolProposal.parse({ tool: inv.tool_name, parameters: inv.parameters });
        if (proposal.tool !== 'connection_action' && proposal.tool !== 'execute_code') return;
        const reconcile = a.state === 'outcome_unknown';
        let secret = '',
          endpoint = '';
        if (!reconcile) {
          try {
            if (run.status !== 'awaiting_approval' || inv.status !== 'executing')
              throw new AppError(409, 'ACTION_CANCELLED', 'The action was cancelled.');
            const authorization = await validateAuthorization(tx, run, inv, proposal);
            await validateCurrentApproval(tx, run, inv, authorization);
            if (!a.encrypted_capability)
              throw new AppError(
                409,
                'CAPABILITY_INVALID',
                'A verifiable execution capability is required.',
              );
            const raw = this.secrets.open(
              'tool-capability:' + workspaceId + ':' + inv.id,
              String(a.encrypted_capability),
            );
            const capability = z
              .object({
                workspaceId: z.uuid(),
                runId: z.uuid(),
                invocationId: z.uuid(),
                digest: z.string(),
                expiresAt: z.iso.datetime(),
                nonce: z.string(),
              })
              .strict()
              .parse(JSON.parse(raw));
            if (
              digest(raw) !== a.capability_hash ||
              capability.workspaceId !== workspaceId ||
              capability.runId !== run.id ||
              capability.invocationId !== inv.id ||
              capability.digest !== inv.action_digest ||
              Date.parse(capability.expiresAt) <= Date.now()
            )
              throw new AppError(
                409,
                'CAPABILITY_EXPIRED',
                'This execution capability is expired or does not match the action.',
              );
            if (
              new Date(String(a.capability_expires_at)).getTime() <= Date.now() ||
              new Date(inv.expires_at).getTime() <= Date.now() ||
              a.consumed_at
            )
              throw new AppError(
                409,
                'CAPABILITY_EXPIRED',
                'The single-use execution capability expired.',
              );
          } catch (error) {
            const code = error instanceof AppError ? error.code : 'AUTHORIZATION_FAILED';
            await tx.query("UPDATE tool_actions SET state='failed',error_code=$2 WHERE id=$1", [
              a.id,
              code,
            ]);
            await tx.query(
              "UPDATE tool_invocations SET status='failed',error_code=$2 WHERE id=$1 AND status='executing'",
              [inv.id, code],
            );
            await settleRun(tx, run);
            return;
          }
        }
        if (proposal.tool === 'connection_action') {
          if ((inv.authorization_snapshot as Record<string, unknown>)?.nativeProvider) {
            if (!this.native)
              throw new AppError(
                503,
                'NATIVE_WRITES_UNAVAILABLE',
                'Native connector execution is not configured.',
              );
          } else {
            const [connection] = await tx.query(
              'SELECT c.endpoint,c.protocol,s.encrypted_secret FROM tool_connections c JOIN tool_connection_secrets s ON s.workspace_id=c.workspace_id AND s.connection_id=c.id WHERE c.workspace_id=$1 AND c.id=$2',
              [workspaceId, proposal.parameters.connectionId],
            );
            if (!connection) return;
            endpoint = String(connection.endpoint);
            secret = this.secrets.open(
              'tool-connection:' + workspaceId + ':' + proposal.parameters.connectionId,
              String(connection.encrypted_secret),
            );
            if (connection.protocol === 'mcp')
              secret = z.object({ token: z.string() }).parse(JSON.parse(secret)).token;
          }
        } else if (reconcile) {
          return;
        }
        if (!reconcile)
          await tx.query(
            "UPDATE tool_actions SET state='dispatched',consumed_at=now() WHERE id=$1 AND capability_hash=$2 AND consumed_at IS NULL",
            [a.id, a.capability_hash],
          );
        else await tx.query("UPDATE tool_actions SET error_code='RECONCILING' WHERE id=$1", [a.id]);
        return { a, run, inv, proposal, reconcile, secret, endpoint };
      });
      if (!job) return;
      let receipt: ProviderReceipt = { status: 'unknown' },
        result: Record<string, unknown> | null = null;
      try {
        if (
          job.proposal.tool === 'connection_action' &&
          (job.inv.authorization_snapshot as Record<string, unknown>)?.nativeProvider
        ) {
          const proposal = job.proposal;
          receipt = await this.native!.execute({
            workspaceId,
            connectionId: proposal.parameters.connectionId,
            connectionVersion: Number(
              (job.inv.authorization_snapshot as Record<string, unknown>).connectionVersion,
            ),
            operation: proposal.parameters.operation,
            payload: proposal.parameters.payload,
            key: job.a.idempotency_key,
            reconcile: job.reconcile,
            guard: () =>
              this.db.transaction(async (tx) => {
                const [run] = await tx.query<RunRow>(
                  'SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2',
                  [workspaceId, job.run.id],
                );
                if (!run || run.status !== 'awaiting_approval')
                  throw new AppError(409, 'RUN_UNAVAILABLE', 'The run is unavailable.');
                const [current] = await tx.query(
                  "SELECT 1 FROM tool_invocations i JOIN tool_actions a ON a.workspace_id=i.workspace_id AND a.invocation_id=i.id WHERE i.workspace_id=$1 AND i.id=$2 AND i.status IN ('executing','outcome_unknown') AND a.state IN ('dispatched','outcome_unknown')",
                  [workspaceId, job.inv.id],
                );
                if (
                  !current ||
                  (!job.reconcile &&
                    new Date(String(job.a.capability_expires_at)).getTime() <= Date.now())
                )
                  throw new AppError(
                    409,
                    'ACTION_CANCELLED',
                    'The action is cancelled or its execution capability expired.',
                  );
                const authorization = await validateAuthorization(tx, run, job.inv, proposal);
                await validateCurrentApproval(tx, run, job.inv, authorization);
              }),
          });
        } else if (
          job.proposal.tool === 'connection_action' &&
          (job.inv.authorization_snapshot as Record<string, unknown>)?.remoteMcp
        ) {
          if (!job.reconcile && this.remote) {
            const snapshot = job.inv.authorization_snapshot as Record<string, unknown>,
              proposal = job.proposal;
            const [connection] = await this.db.query(
              'SELECT mcp_manifest FROM tool_connections WHERE workspace_id=$1 AND id=$2 AND version=$3 AND revoked_at IS NULL',
              [workspaceId, proposal.parameters.connectionId, snapshot.connectionVersion],
            );
            if (connection) {
              const tool = (connection.mcp_manifest as unknown[])
                .map((t) => remoteTool.parse(t))
                .find((t) => t.name === snapshot.remoteToolName);
              if (tool)
                receipt = await this.remote.call(
                  job.endpoint,
                  job.secret,
                  tool.name,
                  JSON.parse(proposal.parameters.payload),
                  job.a.idempotency_key,
                  () =>
                    this.db.transaction(async (tx) => {
                      const [run] = await tx.query<RunRow>(
                        'SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2',
                        [workspaceId, job.run.id],
                      );
                      const [action] = await tx.query(
                        "SELECT 1 FROM tool_actions WHERE workspace_id=$1 AND id=$2 AND state='dispatched' AND capability_expires_at>clock_timestamp()",
                        [workspaceId, job.a.id],
                      );
                      if (!run || run.status !== 'awaiting_approval' || !action)
                        throw new AppError(
                          409,
                          'ACTION_CANCELLED',
                          'The approved action is no longer active.',
                        );
                      const authorization = await validateAuthorization(tx, run, job.inv, proposal);
                      await validateCurrentApproval(tx, run, job.inv, authorization);
                    }),
                  tool,
                );
            }
          }
        } else if (job.proposal.tool === 'connection_action')
          receipt = await this.provider({
            endpoint: job.endpoint,
            secret: job.secret,
            key: job.a.idempotency_key,
            operation: job.proposal.parameters.operation,
            payload: job.proposal.parameters.payload,
            reconcile: job.reconcile,
          });
        else {
          const output = await this.code(job.proposal.parameters);
          result = output as unknown as Record<string, unknown>;
          receipt = {
            status: output.exitCode === 0 ? 'succeeded' : 'not_applied',
            receipt: 'sandbox:' + job.a.idempotency_key,
          };
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'SANDBOX_UNAVAILABLE')
          receipt = { status: 'not_applied', receipt: 'sandbox:not-configured' };
      }
      if (receipt.status !== 'unknown' && job.secret && receipt.receipt.includes(job.secret))
        receipt = { ...receipt, receipt: 'redacted:' + digest(receipt.receipt) };
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
        const [run] = await tx.query<RunRow>('SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE', [
          job.run.id,
        ]);
        if (!run) return;
        await tx.query('SELECT id FROM tool_invocations WHERE id=$1 FOR UPDATE', [job.inv.id]);
        const [current] = await tx.query<ActionRow>(
          'SELECT * FROM tool_actions WHERE id=$1 FOR UPDATE',
          [job.a.id],
        );
        if (!current || ['succeeded', 'failed'].includes(current.state)) return;
        const state =
          receipt.status === 'unknown'
            ? 'outcome_unknown'
            : receipt.status === 'succeeded'
              ? 'succeeded'
              : 'failed';
        let publish = run.status === 'awaiting_approval';
        try {
          await runIdentities(tx, run);
        } catch {
          publish = false;
        }
        await tx.query(
          'UPDATE tool_actions SET state=$2,result=$3,receipt=$4,error_code=$5 WHERE id=$1',
          [
            current.id,
            state,
            JSON.stringify(publish ? result : null),
            receipt.status === 'unknown' ? null : receipt.receipt,
            receipt.status === 'unknown' ? 'PROVIDER_OUTCOME_UNKNOWN' : null,
          ],
        );
        await tx.query(
          "UPDATE tool_invocations SET status=$2,result=$3,error_code=$4 WHERE id=$1 AND status IN ('executing','outcome_unknown')",
          [
            job.inv.id,
            state,
            JSON.stringify(
              publish
                ? (result ?? (receipt.status === 'unknown' ? null : { receipt: receipt.receipt }))
                : null,
            ),
            state === 'failed'
              ? 'PROVIDER_NOT_APPLIED'
              : state === 'outcome_unknown'
                ? 'PROVIDER_OUTCOME_UNKNOWN'
                : null,
          ],
        );
        if (publish) {
          const { agent } = await runIdentities(tx, run);
          await recordChange(tx, agent, 'tool.' + state, job.inv.id, run.conversation_id);
        }
        await settleRun(tx, run);
      });
    });
  }
}

async function validateCurrentApproval(
  tx: Sql,
  run: RunRow,
  inv: InvocationRow,
  authorization: ActionAuthorization,
) {
  const [approval] = await tx.query(
    'SELECT d.*,m.role,m.kind,m.status,m.access_type,m.permissions FROM approval_decisions d JOIN memberships m ON m.workspace_id=d.workspace_id AND m.id=d.approver_id WHERE d.workspace_id=$1 AND d.invocation_id=$2 FOR SHARE OF m',
    [run.workspace_id, inv.id],
  );
  const [authority] = approval
    ? await tx.query('SELECT * FROM public.member_account_authority($1,$2)', [
        run.workspace_id,
        approval.approver_id,
      ])
    : [];
  const [audience] = approval
    ? await tx.query('SELECT resource_visible_to($1,$2,$3,$4) allowed', [
        run.workspace_id,
        run.conversation_id,
        run.created_at,
        approval.approver_id,
      ])
    : [];
  if (
    !approval ||
    approval.decision !== 'approved' ||
    approval.action_digest !== inv.action_digest ||
    !authority?.verified ||
    Number(authority.auth_version) !== approval.approver_auth_version ||
    approval.kind !== 'human' ||
    approval.status !== 'active' ||
    approval.access_type !== 'member' ||
    !['owner', 'admin'].includes(String(approval.role)) ||
    (approval.permissions as Record<string, boolean>)['execution.manage'] === false ||
    !audience?.allowed ||
    (authorization.rule.approval === 'owner' && approval.role !== 'owner') ||
    (authorization.rule.independent && approval.approver_id === run.requester_id)
  )
    throw new AppError(409, 'APPROVAL_INVALID', 'Approval authority changed.');
}
