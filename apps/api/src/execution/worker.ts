import type { IdentitySecrets } from '../identity/secrets.js';
import { randomUUID } from 'node:crypto';
import { scopedDatabase, dispatcherScope, workerScope, type Database } from '@ao/database';
import { agentOutput } from '@ao/contracts';
import { effectiveInstructions } from './skills.js';
import { escalateDelegation } from './coordination.js';
import { AppError } from '../lib/errors.js';
import { ToolGateway, settleRun } from './gateway.js';
import { runIdentities, requireRunContext } from './policy.js';
import { enqueueRun } from './runs.js';
import { publishRunResult } from './results.js';
import type { HostedRuntime, RunRow, RuntimeOutcome } from './types.js';
import {
  checkpoint,
  executionPolicy,
  qualifyConfiguration,
  runConfiguration,
  settleSpending,
} from './controls.js';
export class ExecutionWorker {
  private busy = false;
  private cursor = 0;
  private stopped = false;
  private controllers = new Set<AbortController>();
  private pending = new Set<Promise<void>>();
  private active: Promise<void> | null = null;
  constructor(
    private readonly db: Database,
    private readonly runtime: HostedRuntime,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly toolSecrets?: IdentitySecrets,
  ) {
    this.db = scopedDatabase(db);
  }
  start(intervalMs = 1000) {
    const timer = setInterval(() => {
      if (!this.busy) this.active = this.tick(false).catch(this.onError);
    }, intervalMs);
    timer.unref();
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      for (const controller of this.controllers) controller.abort();
      await this.active;
      await Promise.allSettled(this.pending);
    };
  }
  async tick(wait = true) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const workspaces = await dispatcherScope(() =>
        this.db.query<{ id: string }>(
          'SELECT workspace_id id FROM execution_policies WHERE needs_work ORDER BY last_dispatched_at NULLS FIRST,workspace_id LIMIT 100',
        ),
      );
      const offset = this.cursor++ % Math.max(workspaces.length, 1);
      const ordered = [...workspaces.slice(offset), ...workspaces.slice(0, offset)];
      const admitted: Promise<void>[] = [];
      for (const workspace of ordered) {
        if (this.stopped) break;
        const job = await workerScope(workspace.id, () => this.tickWorkspace(workspace.id));
        if (job) {
          const active = workerScope(workspace.id, () => this.perform(job)).catch(this.onError);
          this.pending.add(active);
          void active.then(
            () => this.pending.delete(active),
            () => this.pending.delete(active),
          );
          admitted.push(active);
        }
      }
      if (wait) await Promise.all(admitted);
    } finally {
      this.busy = false;
    }
  }
  private async tickWorkspace(workspaceId: string) {
    await this.db.query(
      'UPDATE execution_policies SET last_dispatched_at=now() WHERE workspace_id=$1',
      [workspaceId],
    );
    await this.db.query(
      "UPDATE agent_runs SET status=CASE WHEN dispatch_started THEN 'outcome_unknown' ELSE 'queued' END,error_code=CASE WHEN dispatch_started THEN 'LEASE_EXPIRED' ELSE NULL END,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE status='running' AND lease_expires_at<now()",
    );
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const stopped = await tx.query<RunRow>(
        "SELECT r.* FROM agent_runs r WHERE r.parent_run_id IS NOT NULL AND r.status IN ('queued','running','awaiting_approval') AND (r.delegation_deadline<=now() OR EXISTS(SELECT 1 FROM agent_runs parent WHERE parent.id=r.parent_run_id AND (parent.status IN ('cancelled','failed','outcome_unknown') OR parent.verification_status IN ('rejected','escalated')))) ORDER BY r.id FOR UPDATE",
      );
      for (const run of stopped) {
        await escalateDelegation(tx, run);
        await tx.query(
          "UPDATE agent_runs SET status='cancelled',verification_status='escalated',error_code='DELEGATION_STOPPED',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [run.id],
        );
        await tx.query(
          "UPDATE tool_invocations SET status='cancelled' WHERE run_id=$1 AND status IN ('pending','approved')",
          [run.id],
        );
        await tx.query(
          "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id,audience_membership_id) VALUES($1,'run.escalated',$2,$3,$4)",
          [run.workspace_id, run.id, run.conversation_id, run.owner_id],
        );
      }
      const overdue = await tx.query<RunRow>(
        "UPDATE agent_runs SET verification_status='escalated',updated_at=now() WHERE parent_run_id IS NOT NULL AND verification_status='pending' AND (status IN ('failed','cancelled','outcome_unknown') OR delegation_deadline<=now()) RETURNING *",
      );
      for (const run of overdue) {
        await escalateDelegation(tx, run);
        await tx.query(
          "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id,audience_membership_id) VALUES($1,'run.escalated',$2,$3,$4)",
          [run.workspace_id, run.id, run.conversation_id, run.owner_id],
        );
      }
    });
    await this.db.transaction(async (tx) => {
      const runs = await tx.query<RunRow>(
        "SELECT * FROM agent_runs WHERE status='awaiting_approval' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20",
      );
      for (const run of runs) {
        await tx.query(
          "UPDATE tool_invocations SET status='expired' WHERE run_id=$1 AND status IN ('pending','approved') AND expires_at<=now()",
          [run.id],
        );
        await settleRun(tx, run);
      }
    });
    const gateway = new ToolGateway(this.db, this.toolSecrets);
    for (const action of await this.db.query<{ id: string }>(
      "SELECT id FROM tool_invocations WHERE status='approved' ORDER BY created_at LIMIT 10",
    )) {
      try {
        await gateway.execute(action.id);
      } catch (error) {
        await this.db.transaction(async (tx) => {
          const [ref] = await tx.query('SELECT run_id FROM tool_invocations WHERE id=$1', [
            action.id,
          ]);
          if (!ref) return;
          const [run] = await tx.query<RunRow>('SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE', [
            ref.run_id,
          ]);
          await tx.query(
            "UPDATE tool_invocations SET status='failed',error_code=$1 WHERE id=$2 AND status='approved'",
            [error instanceof AppError ? error.code : 'TOOL_FAILED', action.id],
          );
          if (run) await settleRun(tx, run);
        });
        this.onError(error);
      }
    }
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      await tx.query(
        "UPDATE execution_policies p SET needs_work=EXISTS(SELECT 1 FROM agent_runs r WHERE r.workspace_id=p.workspace_id AND (r.status IN ('queued','running','awaiting_approval','outcome_unknown') OR r.parent_run_id IS NOT NULL AND r.verification_status='pending')) OR EXISTS(SELECT 1 FROM agent_inbox i JOIN agents a ON a.workspace_id=i.workspace_id AND a.id=i.agent_id WHERE i.workspace_id=p.workspace_id AND i.state='pending' AND i.expires_at>now() AND a.runtime='managed' AND a.status='active')",
      );
    });
    if (!this.runtime.configured || this.pending.size >= 4) return null;
    await this.queueMentions();
    return this.db.transaction(async (tx) => {
      const [workspace] = await tx.query('SELECT workspace_id FROM execution_policies LIMIT 1');
      if (!workspace) return null;
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace.workspace_id]);
      const policy = await executionPolicy(tx, String(workspace.workspace_id));
      const [count] = await tx.query(
        "SELECT count(*)::int count FROM agent_runs WHERE status IN ('running','outcome_unknown')",
      );
      if (Number(count?.count) >= Number(policy.max_concurrent_runs)) return null;
      const [row] = await tx.query<RunRow>(
        `SELECT r.* FROM agent_runs r WHERE r.status='queued'
        AND (SELECT count(*) FROM agent_runs running WHERE running.status IN ('running','outcome_unknown') AND running.agent_id=r.agent_id)<$1
        AND (SELECT count(*) FROM agent_runs running WHERE running.status IN ('running','outcome_unknown') AND running.requester_id=r.requester_id)<$2
        ORDER BY (SELECT max(last.started_at) FROM agent_runs last WHERE last.requester_id=r.requester_id) ASC NULLS FIRST,r.created_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
        [policy.max_agent_concurrent, policy.max_requester_concurrent],
      );
      if (!row) return null;
      const configuration = runConfiguration(row);
      try {
        qualifyConfiguration(this.runtime, configuration);
      } catch (error) {
        await tx.query(
          "UPDATE agent_runs SET status='failed',error_code=$2,updated_at=now() WHERE id=$1",
          [row.id, error instanceof AppError ? error.code : 'RUNTIME_NOT_QUALIFIED'],
        );
        return null;
      }
      const lease = randomUUID();
      const [claimed] = await tx.query<RunRow>(
        "UPDATE agent_runs SET status='running',lease_token=$2,lease_expires_at=now()+interval '45 seconds',started_at=coalesce(started_at,now()),deadline_at=least(coalesce(deadline_at,now()+$3*interval '1 second'),coalesce(delegation_deadline,'infinity'::timestamptz)),updated_at=now() WHERE id=$1 RETURNING *",
        [row.id, lease, configuration.limits.maxSeconds],
      );
      return claimed ?? null;
    });
  }
  private async queueMentions() {
    const inbox = await this.db.query(
      `SELECT i.id,i.workspace_id,i.agent_id,m.body,m.conversation_id,m.author_id,r.name,r.role FROM agent_inbox i JOIN agents a ON a.id=i.agent_id JOIN messages m ON m.id=i.message_id JOIN memberships r ON r.id=m.author_id WHERE i.state='pending' AND r.status='active' AND a.runtime='managed' AND a.status='active' AND EXISTS(SELECT 1 FROM agent_revisions v WHERE v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision AND v.configuration->>'activation'='mentions' AND (jsonb_array_length(v.configuration->'conversationIds')=0 OR v.configuration->'conversationIds' ? m.conversation_id::text)) AND m.deleted_at IS NULL AND i.expires_at>now() AND message_visible_to(m.workspace_id,m.conversation_id,m.sequence,m.thread_id,a.membership_id) ORDER BY i.created_at LIMIT 10`,
    );
    for (const entry of inbox) {
      try {
        await this.db.transaction(async (tx) => {
          const queued = await enqueueRun(
            tx,
            {
              workspaceId: String(entry.workspace_id),
              membershipId: String(entry.author_id),
              name: String(entry.name),
              role: entry.role as 'owner' | 'admin' | 'member',
              kind: 'human',
            },
            {
              agentId: String(entry.agent_id),
              conversationId: String(entry.conversation_id),
              prompt: String(entry.body),
              requestKey: String(entry.id),
            },
          );
          await tx.query(
            "UPDATE agent_inbox SET state='accepted',run_id=$2 WHERE id=$1 AND state='pending'",
            [entry.id, queued.id],
          );
        });
      } catch (error) {
        this.onError(error);
      }
    }
  }
  private async perform(run: RunRow) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const remaining = Math.max(
      1,
      new Date(String(run.deadline_at ?? new Date(Date.now() + 300000))).getTime() - Date.now(),
    );
    const deadline = setTimeout(() => controller.abort(), remaining);
    let outcome: RuntimeOutcome | null = null;
    const monitor = setInterval(() => {
      void this.db
        .query(
          "UPDATE agent_runs r SET lease_expires_at=least(r.deadline_at,now()+interval '45 seconds') FROM agents a WHERE r.id=$1 AND r.lease_token=$2 AND r.status='running' AND r.deadline_at>now() AND a.id=r.agent_id AND a.status='active' AND a.revision=r.agent_revision RETURNING r.id",
          [run.id, run.lease_token],
        )
        .then(([row]) => {
          if (!row) controller.abort();
        })
        .catch((error) => {
          controller.abort();
          this.onError(error);
        });
    }, 10000);
    let sessionId: string | null = null;
    let runtime = this.runtime;
    try {
      runtime = (await this.runtime.forRun?.(run.workspace_id, run.id)) ?? this.runtime;
      qualifyConfiguration(runtime, runConfiguration(run));
      const context = await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [run.workspace_id]);
        const [current] = await tx.query(
          'SELECT status,lease_token FROM agent_runs WHERE id=$1 FOR UPDATE',
          [run.id],
        );
        if (current?.status !== 'running' || current.lease_token !== run.lease_token)
          throw new AppError(409, 'RUN_CANCELLED', 'The run was fenced before dispatch.');
        const { requester, agent } = await runIdentities(tx, run);
        if (run.dispatch_started) await requireRunContext(tx, run);
        else {
          const [authority] = await tx.query(
            'SELECT epoch FROM retrieval_authority WHERE workspace_id=$1',
            [run.workspace_id],
          );
          run.retrieval_epoch = authority?.epoch;
          await tx.query('UPDATE agent_runs SET retrieval_epoch=$2 WHERE id=$1', [
            run.id,
            authority?.epoch,
          ]);
        }
        const rows = await tx.query(
          'SELECT m.body,a.name FROM messages m JOIN memberships a ON a.id=m.author_id WHERE m.workspace_id=$1 AND m.conversation_id=$2 AND m.deleted_at IS NULL AND message_visible_to(m.workspace_id,m.conversation_id,m.sequence,m.thread_id,$3) AND message_visible_to(m.workspace_id,m.conversation_id,m.sequence,m.thread_id,$4) ORDER BY m.sequence DESC LIMIT 20',
          [run.workspace_id, run.conversation_id, requester.membershipId, agent.membershipId],
        );
        const context = JSON.stringify(
          rows.reverse().map((row) => ({ ...row, body: String(row.body).slice(0, 2000) })),
        );
        await checkpoint(tx, run, 'prepared', 'Source authority checked; bounded input prepared.');
        return context;
      });
      sessionId =
        run.dispatch_started && run.session_id
          ? run.session_id
          : await runtime.createSession(controller.signal);
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [run.workspace_id]);
        await requireRunContext(tx, run);
        const rows = await tx.query(
          "UPDATE agent_runs SET session_id=$1,dispatch_started=true WHERE id=$2 AND status='running' AND lease_token=$3 RETURNING id",
          [sessionId, run.id, run.lease_token],
        );
        if (!rows.length) throw new AppError(409, 'RUN_CANCELLED', 'The run was cancelled.');
        await tx.query('UPDATE agents SET last_seen_at=now() WHERE workspace_id=$1 AND id=$2', [
          run.workspace_id,
          run.agent_id,
        ]);
        await checkpoint(
          tx,
          run,
          'dispatched',
          run.dispatch_started
            ? 'Resuming observation of the existing hosted session.'
            : 'The hosted request was fenced before dispatch.',
        );
      });
      const request = {
        runId: run.id,
        prompt: run.prompt,
        instructions: effectiveInstructions(runConfiguration(run), {
          contract: typeof run.output_contract === 'string' ? run.output_contract : undefined,
          stop: typeof run.stop_condition === 'string' ? run.stop_condition : undefined,
        }),
        context,
        configuration: runConfiguration(run),
      };
      if (run.dispatch_started) {
        if (!runtime.observe || !runtime.capabilities?.resumeObservation)
          throw new AppError(
            409,
            'RECOVERY_NOT_QUALIFIED',
            'The existing session cannot be redispatched.',
          );
        outcome = await runtime.observe(sessionId, controller.signal);
      } else
        outcome = runtime.generateDetailed
          ? await runtime.generateDetailed(sessionId, request, controller.signal)
          : { output: await runtime.generate(sessionId, request, controller.signal) };
      const output = agentOutput.parse(outcome.output);
      const limits = runConfiguration(run).limits;
      if (
        outcome.usage &&
        (outcome.usage.inputTokens > limits.maxInputTokens ||
          outcome.usage.outputTokens > limits.maxOutputTokens)
      )
        throw new AppError(
          409,
          'TOKEN_LIMIT_EXCEEDED',
          'The runtime exceeded its qualified token bounds.',
        );
      if (
        outcome.usage?.costMicros !== null &&
        outcome.usage?.costMicros !== undefined &&
        outcome.usage.costMicros > limits.reservationMicros
      )
        throw new AppError(
          409,
          'RESERVATION_EXCEEDED',
          'Reported usage exceeded the approved reservation. Review operator pricing bounds.',
        );
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [run.workspace_id]);
        const [current] = await tx.query<RunRow>(
          'SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE',
          [run.id],
        );
        if (current && current.session_id === sessionId)
          await settleSpending(tx, current, outcome?.usage);
        if (!current || current.status !== 'running' || current.lease_token !== run.lease_token)
          return;
        await publishRunResult(tx, current, output);
      });
    } catch (error) {
      if (outcome) await this.db.transaction((tx) => settleSpending(tx, run, outcome?.usage));
      if (sessionId) {
        try {
          await runtime.cancel(sessionId);
        } catch {}
      }
      await this.db.query(
        "UPDATE agent_runs SET status=$1,error_code=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$3 AND status='running' AND lease_token=$4",
        [
          error instanceof AppError ? 'failed' : sessionId ? 'outcome_unknown' : 'failed',
          error instanceof AppError
            ? error.code
            : controller.signal.aborted
              ? 'RUNTIME_TIMEOUT'
              : 'RUNTIME_FAILED',
          run.id,
          run.lease_token,
        ],
      );
      this.onError(
        new Error(
          `Hosted execution stopped: ${error instanceof AppError ? error.code : 'RUNTIME_FAILED'}`,
        ),
      );
    } finally {
      clearTimeout(deadline);
      clearInterval(monitor);
      this.controllers.delete(controller);
    }
  }
}
