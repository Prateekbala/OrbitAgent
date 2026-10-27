import { coordinationState } from '../execution/coordination.js';
import { escalateAutomation } from './escalation.js';
import { randomUUID } from 'node:crypto';
import {
  dispatcherScope,
  workerScope,
  scopedDatabase,
  type Database,
  type Sql,
} from '@ao/database';
import { automationDefinition, type AutomationDefinition } from '@ao/contracts/automations';
import { workPrincipal, assumeWorkPrincipal } from '../workflows/authority.js';
import { getTemplate, admitWorkflow } from '../workflows/service.js';
import { enqueueRun } from '../execution/runs.js';
import { AppError } from '../lib/errors.js';
import type { Identity } from '../lib/policy.js';
import { hasPermission } from '../identity/authorization.js';
import { inQuietHours, nextOccurrence } from './schedule.js';
import { stopOccurrences, validateAutomation, automationPermissions } from './service.js';
type Row = Record<string, unknown>;
export class AutomationWorker {
  private readonly db: Database;
  private pending: Promise<void> | null = null;
  constructor(
    db: Database,
    private readonly onError: (code: string) => void = () => {},
    private readonly runtimeConfigured = true,
  ) {
    this.db = scopedDatabase(db);
  }
  tick(now = new Date()) {
    if (!this.pending)
      this.pending = this.sweep(now).finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  private async sweep(now: Date) {
    const spaces = await dispatcherScope(() =>
      this.db.query('SELECT id FROM workspaces ORDER BY id'),
    );
    for (const ws of spaces)
      await workerScope(String(ws.id), async () => {
        const rows = await this.db.query(
          "SELECT id FROM automations WHERE workspace_id=$1 AND (status='active' OR EXISTS(SELECT 1 FROM automation_occurrences o WHERE o.workspace_id=$1 AND o.automation_id=automations.id AND o.status='running')) ORDER BY next_at NULLS LAST,id LIMIT 1000",
          [ws.id],
        );
        for (const row of rows) {
          try {
            await this.db.transaction((tx) => this.advance(tx, String(ws.id), String(row.id), now));
          } catch (e) {
            this.onError(e instanceof AppError ? e.code : 'AUTOMATION_WORKER_FAILED');
          }
        }
      });
  }
  private async insert(tx: Sql, a: Row, key: string, at: Date, event?: Row, skipped?: string) {
    const [count] = await tx.query(
      "SELECT count(*)::int count FROM automation_occurrences WHERE workspace_id=$1 AND automation_id=$2 AND status='queued'",
      [a.workspace_id, a.id],
    );
    if (Number(count?.count) >= 100) return;
    await tx.query(
      'INSERT INTO automation_occurrences(id,workspace_id,automation_id,revision,occurrence_key,scheduled_at,status,reason,event_id,resource_id,created_by,event_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(workspace_id,automation_id,occurrence_key) DO NOTHING',
      [
        randomUUID(),
        a.workspace_id,
        a.id,
        a.revision,
        key,
        at,
        skipped ? 'skipped' : 'queued',
        skipped ?? null,
        event?.id ?? null,
        event?.resource_id ?? null,
        a.owner_id,
        event?.event_type ?? null,
      ],
    );
  }
  private async schedule(tx: Sql, a: Row, d: AutomationDefinition, now: Date) {
    if (d.trigger.kind !== 'schedule' || !a.next_at || new Date(String(a.next_at)) > now) return;
    const s = d.trigger,
      first = new Date(String(a.next_at)),
      late = now.getTime() - first.getTime() > s.graceSeconds * 1000;
    if (late && s.missed === 'skip') {
      await this.insert(tx, a, 'schedule:' + first.toISOString(), first, undefined, 'missed_run');
      await tx.query('UPDATE automations SET next_at=$3 WHERE workspace_id=$1 AND id=$2', [
        a.workspace_id,
        a.id,
        nextOccurrence(s, now),
      ]);
      return;
    }
    let at = first;
    if (late && s.missed === 'coalesce') {
      await this.insert(tx, a, 'schedule:' + first.toISOString(), now);
      at = nextOccurrence(s, now);
    } else {
      let handled = 0;
      while (at <= now && handled < (s.missed === 'catch_up' ? s.catchUpLimit : 1)) {
        await this.insert(tx, a, 'schedule:' + at.toISOString(), at);
        at = nextOccurrence(s, at);
        handled++;
      }
      if (at <= now) at = nextOccurrence(s, now);
    }
    await tx.query('UPDATE automations SET next_at=$3 WHERE workspace_id=$1 AND id=$2', [
      a.workspace_id,
      a.id,
      at,
    ]);
  }
  private async events(tx: Sql, a: Row, d: AutomationDefinition, now: Date) {
    if (d.trigger.kind !== 'event') return;
    const events = await tx.query(
      'SELECT e.* FROM outbox_events e WHERE e.workspace_id=$1 AND e.id>$2 ORDER BY e.id LIMIT 100',
      [a.workspace_id, a.event_cursor],
    );
    for (const e of events) {
      if (
        e.conversation_id !== d.conversationId ||
        e.origin_automation_id ||
        (e.audience_membership_id && e.audience_membership_id !== a.owner_id) ||
        !e.actor_id ||
        !d.trigger.events.includes(e.event_type as never) ||
        (d.trigger.ignoreOwner && e.actor_id === a.owner_id)
      )
        continue;
      const [actor] = await tx.query(
        "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND kind='human' AND status='active'",
        [a.workspace_id, e.actor_id],
      );
      if (!actor) continue;
      if (e.event_type === 'task.comment_created') {
        const [comment] = await tx.query(
          'SELECT task_id FROM task_comments WHERE workspace_id=$1 AND id=$2',
          [a.workspace_id, e.resource_id],
        );
        if (!comment) continue;
        e.resource_id = comment.task_id;
      }
      await this.insert(tx, a, 'event:' + String(e.id), now, e);
    }
    if (events.length)
      await tx.query('UPDATE automations SET event_cursor=$3 WHERE workspace_id=$1 AND id=$2', [
        a.workspace_id,
        a.id,
        events.at(-1)!.id,
      ]);
  }
  private async settle(tx: Sql, a: Row, d: AutomationDefinition, now: Date) {
    const running = await tx.query(
      "SELECT o.*,r.status agent_status,w.status workflow_status FROM automation_occurrences o LEFT JOIN agent_runs r ON r.workspace_id=o.workspace_id AND r.id=o.agent_run_id LEFT JOIN workflow_runs w ON w.workspace_id=o.workspace_id AND w.id=o.workflow_run_id WHERE o.workspace_id=$1 AND o.automation_id=$2 AND o.status IN ('running','outcome_unknown') ORDER BY o.id FOR UPDATE OF o",
      [a.workspace_id, a.id],
    );
    for (const o of running) {
      const child = String(o.agent_status ?? o.workflow_status ?? ''),
        expired = o.deadline_at && new Date(String(o.deadline_at)) <= now;
      let status = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(child)
        ? child
        : null;
      if (o.agent_run_id && status === 'succeeded') {
        const coordination = await coordinationState(
          tx,
          String(a.workspace_id),
          String(o.agent_run_id),
        );
        if (coordination === 'awaiting_verification') status = null;
        else if (coordination === 'blocked') status = 'failed';
      }
      if (expired && !status) {
        await stopOccurrences(
          tx,
          String(a.workspace_id),
          String(a.id),
          'deadline_exceeded',
          String(o.id),
        );
        status = 'failed';
      }
      if (!status || o.status === status) continue;
      await tx.query(
        'UPDATE automation_occurrences SET status=$3,reason=CASE WHEN $4 THEN $5 ELSE reason END,finished_at=$6 WHERE workspace_id=$1 AND id=$2',
        [a.workspace_id, o.id, status, Boolean(expired), 'deadline_exceeded', now],
      );
      if (['failed', 'outcome_unknown'].includes(status) && !o.escalated_at) {
        const target = d.escalationMemberId ?? String(a.owner_id);
        await escalateAutomation(
          tx,
          String(a.workspace_id),
          String(a.id),
          String(o.id),
          String(a.owner_id),
          target,
          d.conversationId,
        );
        await tx.query(
          'UPDATE automation_occurrences SET escalated_at=$3 WHERE workspace_id=$1 AND id=$2',
          [a.workspace_id, o.id, now],
        );
      }
    }
  }
  private async advance(tx: Sql, workspace: string, id: string, now: Date) {
    await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace]);
    const [a] = await tx.query(
      'SELECT a.*,v.definition,v.authority_snapshot FROM automations a JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.automation_id=a.id AND v.revision=a.revision WHERE a.workspace_id=$1 AND a.id=$2 FOR UPDATE OF a',
      [workspace, id],
    );
    if (!a) return;
    const d = automationDefinition.parse(a.definition);
    await this.settle(tx, a, d, now);
    if (a.status !== 'active') return;
    await tx.query('SAVEPOINT automation_authority');
    try {
      const p = await workPrincipal(
        tx,
        workspace,
        String(a.owner_id),
        {
          auth: Number(a.owner_auth_version),
          policy: Number(a.policy_version),
        },
        automationPermissions(d),
      );
      if (!hasPermission(p, 'execution.manage'))
        throw new AppError(403, 'AUTHORITY_REVOKED', 'Execution permission changed.');
      await assumeWorkPrincipal(tx, p);
      const snapshot = await validateAutomation(tx, p, d);
      const [unchanged] = await tx.query('SELECT $1::jsonb=$2::jsonb same', [
        JSON.stringify(snapshot),
        JSON.stringify(a.authority_snapshot),
      ]);
      if (!unchanged?.same)
        throw new AppError(
          409,
          'AGENT_AUTHORITY_CHANGED',
          'A pinned workflow agent revision changed.',
        );
      await tx.query('SET LOCAL ROLE ao_worker');
    } catch {
      await tx.query('ROLLBACK TO SAVEPOINT automation_authority');
      await stopOccurrences(tx, workspace, id, 'authority_revoked');
      await tx.query(
        "UPDATE automations SET status='paused',version=version+1,next_at=NULL WHERE workspace_id=$1 AND id=$2",
        [workspace, id],
      );
      await tx.query(
        "INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id) VALUES($1,'automation.authority_revoked',$2,$3)",
        [workspace, id, a.owner_id],
      );
      return;
    }
    await this.schedule(tx, a, d, now);
    await this.events(tx, a, d, now);
    const queued = await tx.query(
      "SELECT * FROM automation_occurrences WHERE workspace_id=$1 AND automation_id=$2 AND status='queued' ORDER BY scheduled_at,id LIMIT 20 FOR UPDATE",
      [workspace, id],
    );
    for (const o of queued) {
      const [counts] = await tx.query(
        "SELECT count(*) FILTER(WHERE status IN ('running','outcome_unknown'))::int active,count(*) FILTER(WHERE started_at>=date_trunc('day',$3::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int daily FROM automation_occurrences WHERE workspace_id=$1 AND automation_id=$2",
        [workspace, id, now],
      );
      let reason: string | null = !d.participation.enabled
        ? 'participation_disabled'
        : inQuietHours(d, now)
          ? 'quiet_hours'
          : Number(counts?.daily) >= d.maxRunsPerDay
            ? 'daily_limit'
            : null;
      if (Number(counts?.active) >= d.concurrency) {
        if (d.overlap === 'queue') break;
        reason = 'overlap';
      }
      if (
        d.action.kind === 'agent' &&
        a.last_publication_at &&
        now.getTime() - new Date(String(a.last_publication_at)).getTime() <
          d.participation.cooldownMinutes * 60000
      )
        reason = 'cooldown';
      if (reason) {
        await tx.query(
          "UPDATE automation_occurrences SET status='skipped',reason=$3,finished_at=$4 WHERE workspace_id=$1 AND id=$2",
          [workspace, o.id, reason, now],
        );
        continue;
      }
      await tx.query('SAVEPOINT automation_dispatch');
      try {
        const p = await workPrincipal(
          tx,
          workspace,
          String(a.owner_id),
          {
            auth: Number(a.owner_auth_version),
            policy: Number(a.policy_version),
          },
          automationPermissions(d),
        );
        await assumeWorkPrincipal(tx, p);
        await validateAutomationSource(tx, p, o, d);
        await tx.query(
          "SELECT set_config('ao.automation_id',$1,true),set_config('ao.automation_occurrence_id',$2,true)",
          [id, String(o.id)],
        );
        let agentId: string | null = null,
          workflowId: string | null = null;
        if (d.action.kind === 'agent') {
          if (!this.runtimeConfigured)
            throw new AppError(503, 'RUNTIME_UNAVAILABLE', 'Hosted execution is not configured.');
          const run = await enqueueRun(tx, p, {
            requestKey: String(o.id),
            agentId: d.action.agentId,
            conversationId: d.conversationId,
            prompt: d.action.prompt,
          });
          agentId = run.id;
          await tx.query(
            'UPDATE agent_runs SET automation_occurrence_id=$3 WHERE workspace_id=$1 AND id=$2',
            [workspace, agentId, o.id],
          );
        } else {
          const template = await getTemplate(tx, p, d.action.templateId);
          const run = await admitWorkflow(
            tx,
            p,
            { ...template, published_revision: d.action.revision },
            {
              clientId: String(o.id),
              revision: d.action.revision,
              ...(d.action.sourceTaskId
                ? { sourceTaskId: d.action.sourceTaskId }
                : o.event_id && String(o.event_type).startsWith('task.')
                  ? { sourceTaskId: String(o.resource_id) }
                  : {}),
              ...(d.action.projectId ? { projectId: d.action.projectId } : {}),
            },
            { hash: 'automation:' + String(o.id) },
          );
          workflowId = run.id;
          await tx.query(
            'UPDATE workflow_runs SET automation_occurrence_id=$3 WHERE workspace_id=$1 AND id=$2',
            [workspace, workflowId, o.id],
          );
        }
        await tx.query(
          "UPDATE automation_occurrences SET status='running',agent_run_id=$3,workflow_run_id=$4,started_at=$5,deadline_at=$5::timestamptz+$6::int*interval '1 minute' WHERE workspace_id=$1 AND id=$2",
          [workspace, o.id, agentId, workflowId, now, d.timeoutMinutes],
        );
        await tx.query('SET LOCAL ROLE ao_worker');
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT automation_dispatch');
        await tx.query(
          "UPDATE automation_occurrences SET status=CASE WHEN $3='SOURCE_UNAVAILABLE' THEN 'skipped' ELSE 'failed' END,reason=$3,finished_at=$4 WHERE workspace_id=$1 AND id=$2",
          [workspace, o.id, error instanceof AppError ? error.code : 'DISPATCH_FAILED', now],
        );
        if (!(error instanceof AppError && error.code === 'SOURCE_UNAVAILABLE'))
          await escalateAutomation(
            tx,
            workspace,
            id,
            String(o.id),
            String(a.owner_id),
            d.escalationMemberId ?? String(a.owner_id),
            d.conversationId,
          );
      }
    }
  }
  start(intervalMs = 1000) {
    const timer = setInterval(() => {
      void this.tick().catch(() => this.onError('AUTOMATION_WORKER_FAILED'));
    }, intervalMs);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
}

async function validateAutomationSource(tx: Sql, p: Identity, o: Row, d: AutomationDefinition) {
  if (!o.event_id) return;
  const [event] = await tx.query(
    'SELECT id,resource_id FROM outbox_events WHERE workspace_id=$1 AND id=$2 AND conversation_id=$3 AND resource_visible_to(workspace_id,conversation_id,created_at,$4)',
    [p.workspaceId, o.event_id, d.conversationId, p.membershipId],
  );
  const type = String(o.event_type);
  let source: Row | undefined;
  if (type.startsWith('message.') && hasPermission(p, 'messages.read'))
    [source] = await tx.query(
      'SELECT id FROM messages WHERE workspace_id=$1 AND id=$2 AND conversation_id=$3 AND deleted_at IS NULL',
      [p.workspaceId, o.resource_id, d.conversationId],
    );
  else if (type.startsWith('task.') && hasPermission(p, 'tasks.read'))
    [source] = await tx.query(
      "SELECT t.id FROM tasks t WHERE t.workspace_id=$1 AND t.id=$2 AND t.conversation_id=$3 AND ($5::text<>'task.comment_created' OR EXISTS(SELECT 1 FROM task_comments c WHERE c.workspace_id=t.workspace_id AND c.task_id=t.id AND c.id=$4 AND c.deleted_at IS NULL))",
      [p.workspaceId, o.resource_id, d.conversationId, event?.resource_id ?? null, type],
    );
  else if (type.startsWith('knowledge.') && hasPermission(p, 'knowledge.read'))
    [source] = await tx.query(
      'SELECT id FROM knowledge_pages WHERE workspace_id=$1 AND id=$2 AND conversation_id=$3',
      [p.workspaceId, o.resource_id, d.conversationId],
    );
  else if (type === 'connection.resource_imported' && hasPermission(p, 'knowledge.read'))
    [source] = await tx.query(
      'SELECT id FROM connection_resources WHERE workspace_id=$1 AND id=$2 AND conversation_id=$3',
      [p.workspaceId, o.resource_id, d.conversationId],
    );
  if (!event || !source)
    throw new AppError(
      409,
      'SOURCE_UNAVAILABLE',
      'The triggering source is no longer available under current access.',
    );
}
