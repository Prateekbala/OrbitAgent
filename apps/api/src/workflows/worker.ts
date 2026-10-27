import { fenceWorkflowAgents } from './fencing.js';
import { randomUUID } from 'node:crypto';
import { coordinationState } from '../execution/coordination.js';
import {
  dispatcherScope,
  workerScope,
  scopedDatabase,
  type Database,
  type Sql,
} from '@ao/database';
import {
  templateDefinition,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@ao/contracts/workflows';
import { taskInput } from '@ao/contracts';
import { AppError } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { hasPermission } from '../identity/authorization.js';
import type { Identity } from '../lib/policy.js';
import { getTask } from '../tasks/queries.js';
import { TaskService, transitionTask, manageTask } from '../tasks/service.js';
import { enqueueRun } from '../execution/runs.js';
import { admitWorkflow } from './service.js';
import { workPrincipal, assumeWorkPrincipal } from './authority.js';
import { businessOffset } from '../scheduling/business.js';
type Row = Record<string, unknown>;
export class WorkflowWorker {
  private readonly db: Database;
  private pending: Promise<void> | null = null;
  constructor(
    db: Database,
    private readonly onError: (error: unknown) => void = () => {},
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
    for (const space of spaces)
      try {
        await workerScope(String(space.id), async () => {
          for (let i = 0; i < 20; i++) {
            const handled = await this.db.transaction((tx) => this.event(tx, String(space.id)));
            if (!handled) break;
          }
          const runs = await this.db.query(
            "SELECT id FROM workflow_runs WHERE workspace_id=$1 AND status IN ('queued','running','waiting') AND available_at<=$2 ORDER BY available_at,id LIMIT 50",
            [space.id, now],
          );
          for (const run of runs)
            await this.db.transaction((tx) =>
              this.advance(tx, String(space.id), String(run.id), now),
            );
        });
      } catch (error) {
        this.onError(error);
      }
  }
  private async event(tx: Sql, ws: string) {
    await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ws]);
    await tx.query('SELECT lock_task_graph($1)', [ws]);
    const [event] = await tx.query(
      'SELECT * FROM workflow_events WHERE workspace_id=$1 AND processed_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED',
      [ws],
    );
    if (!event) return false;
    if (!event.origin_run_id) {
      const triggers = await tx.query(
        'SELECT tr.*,t.conversation_id FROM workflow_triggers tr JOIN work_templates t ON t.workspace_id=tr.workspace_id AND t.id=tr.template_id WHERE tr.workspace_id=$1 AND tr.enabled AND NOT t.archived AND tr.event_type=$2 AND t.conversation_id IS NOT DISTINCT FROM $3::uuid AND (tr.state IS NULL OR tr.state=$4) AND (tr.project_id IS NULL OR tr.project_id=(SELECT project_id FROM tasks WHERE workspace_id=$1 AND id=$5)) ORDER BY tr.id LIMIT 100',
        [ws, event.event_type, event.conversation_id, event.state, event.task_id],
      );
      for (const trigger of triggers) {
        await tx.query('SAVEPOINT workflow_trigger');
        try {
          const p = await workPrincipal(tx, ws, String(trigger.created_by));
          await assumeWorkPrincipal(tx, p);
          const [template] = await tx.query(
            'SELECT * FROM work_templates WHERE workspace_id=$1 AND id=$2',
            [ws, trigger.template_id],
          );
          if (template)
            await admitWorkflow(
              tx,
              p,
              { ...template, published_revision: trigger.template_revision },
              {
                clientId: randomUUID(),
                revision: Number(trigger.template_revision),
                sourceTaskId: String(event.task_id),
                ...(trigger.project_id ? { projectId: String(trigger.project_id) } : {}),
              },
              {
                triggerId: String(trigger.id),
                eventId: String(event.id),
                hash: String(trigger.id) + ':' + String(event.id),
              },
            );
          await tx.query('SET LOCAL ROLE ao_worker');
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT workflow_trigger');
          if (!(error instanceof AppError)) throw error;
          await tx.query(
            'UPDATE workflow_triggers SET enabled=false,version=version+1 WHERE workspace_id=$1 AND id=$2',
            [ws, trigger.id],
          );
        }
        await tx.query('RELEASE SAVEPOINT workflow_trigger');
      }
    }
    await tx.query('UPDATE workflow_events SET processed_at=clock_timestamp() WHERE id=$1', [
      event.id,
    ]);
    return true;
  }
  private async advance(tx: Sql, ws: string, id: string, now: Date) {
    await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ws]);
    await tx.query('SELECT lock_task_graph($1)', [ws]);
    const [run] = await tx.query(
      "SELECT r.*,v.definition FROM workflow_runs r JOIN work_template_versions v ON v.workspace_id=r.workspace_id AND v.template_id=r.template_id AND v.revision=r.template_revision WHERE r.workspace_id=$1 AND r.id=$2 AND r.status IN ('queued','running','waiting') AND r.available_at<=$3 FOR UPDATE OF r SKIP LOCKED",
      [ws, id, now],
    );
    if (!run) return;
    const definition = templateDefinition.parse(run.definition),
      step = definition.steps[Number(run.next_step)];
    if (!step) {
      await tx.query(
        "UPDATE workflow_runs SET status='succeeded',version=version+1,finished_at=$3 WHERE workspace_id=$1 AND id=$2",
        [ws, id, now],
      );
      return;
    }
    const [previous] = await tx.query(
      'SELECT * FROM workflow_steps WHERE workspace_id=$1 AND run_id=$2 AND step_key=$3',
      [ws, id, step.key],
    );
    if (previous?.status === 'succeeded') {
      await tx.query(
        "UPDATE workflow_runs SET next_step=next_step+1,status='running',version=version+1 WHERE workspace_id=$1 AND id=$2",
        [ws, id],
      );
      return;
    }
    await tx.query('SAVEPOINT workflow_action');
    try {
      const p = await workPrincipal(tx, ws, String(run.created_by), {
        auth: Number(run.auth_version),
        policy: Number(run.policy_version),
      });
      if (run.automation_occurrence_id) {
        const [allowed] = await tx.query('SELECT automation_occurrence_allowed($1,$2) allowed', [
          ws,
          run.automation_occurrence_id,
        ]);
        if (!allowed?.allowed)
          throw new AppError(409, 'AUTOMATION_STOPPED', 'Automation authority changed.');
        await tx.query(
          "SELECT set_config('ao.automation_id',(SELECT automation_id::text FROM automation_occurrences WHERE workspace_id=$1 AND id=$2),true),set_config('ao.automation_occurrence_id',$2::text,true)",
          [ws, run.automation_occurrence_id],
        );
      }
      await assumeWorkPrincipal(tx, p);
      const [visible] = await tx.query(
        'SELECT id FROM workflow_runs WHERE workspace_id=$1 AND id=$2',
        [ws, id],
      );
      if (!visible)
        throw new AppError(403, 'SOURCE_ACCESS_REVOKED', 'Workflow audience access was revoked.');
      if (run.source_task_id) await getTask(tx, p, String(run.source_task_id), true);
      if (new Date(String(run.deadline_at)).getTime() <= now.getTime())
        throw new AppError(409, 'WORKFLOW_DEADLINE', 'Workflow deadline expired.');
      await tx.query("SELECT set_config('ao.workflow_run_id',$1,true)", [id]);
      const result = await this.step(tx, p, run, step, previous, now);
      await tx.query('SET LOCAL ROLE ao_worker');
      await tx.query(
        'INSERT INTO workflow_steps(workspace_id,run_id,step_key,status,output,attempts) VALUES($1,$2,$3,$4,$5::jsonb,1) ON CONFLICT(workspace_id,run_id,step_key) DO UPDATE SET status=EXCLUDED.status,output=EXCLUDED.output,error_code=NULL,updated_at=clock_timestamp()',
        [ws, id, step.key, result.wait ? 'waiting' : 'succeeded', JSON.stringify(result.output)],
      );
      const finished = !result.wait && Number(run.next_step) + 1 === definition.steps.length;
      await tx.query(
        "UPDATE workflow_runs SET status=$3,next_step=next_step+$4,version=version+1,available_at=$5::timestamptz+interval '5 seconds',finished_at=CASE WHEN $6 THEN $5::timestamptz ELSE NULL END WHERE workspace_id=$1 AND id=$2",
        [
          ws,
          id,
          finished ? 'succeeded' : result.wait ? 'waiting' : 'running',
          result.wait ? 0 : 1,
          now,
          finished,
        ],
      );
      if (result.wait && step.type === 'approval')
        await this.notice(tx, run, definition, 'approval', p.membershipId);
      await recordChange(tx, p, 'workflow.updated', id, run.conversation_id as string | null);
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT workflow_action');
      await tx.query('SET LOCAL ROLE ao_worker');
      const attempts = Number(previous?.attempts ?? 0) + 1,
        fatal = error instanceof AppError || attempts >= 5,
        code = error instanceof AppError ? error.code : 'WORKFLOW_STEP_FAILED';
      await tx.query(
        "INSERT INTO workflow_steps(workspace_id,run_id,step_key,status,attempts,error_code) VALUES($1,$2,$3,'failed',$4,$5) ON CONFLICT(workspace_id,run_id,step_key) DO UPDATE SET status='failed',attempts=$4,error_code=$5,updated_at=clock_timestamp()",
        [ws, id, step.key, attempts, code],
      );
      await tx.query(
        "UPDATE workflow_runs SET status=$3,error_code=$4,version=version+1,available_at=$5::timestamptz+$6::integer*interval '1 second',finished_at=CASE WHEN $7 THEN $5::timestamptz ELSE NULL END WHERE workspace_id=$1 AND id=$2",
        [ws, id, fatal ? 'failed' : 'running', code, now, Math.min(300, 5 * 2 ** attempts), fatal],
      );
      if (fatal) {
        await fenceWorkflowAgents(tx, ws, id);
        await this.notice(tx, run, definition, 'escalation', String(run.created_by));
        await tx.query(
          "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id) VALUES($1,'workflow.updated',$2,$3)",
          [ws, id, run.conversation_id],
        );
      }
    }
    await tx.query('RELEASE SAVEPOINT workflow_action');
  }
  private async step(
    tx: Sql,
    p: Identity,
    run: Row,
    step: WorkflowStep,
    previous: Row | undefined,
    now: Date,
  ): Promise<{ wait: boolean; output: Row }> {
    const output = (previous?.output ?? {}) as Row;
    const target = async (key: string) => {
      const [ref] =
        key === 'source'
          ? []
          : await tx.query(
              "SELECT output FROM workflow_steps WHERE workspace_id=$1 AND run_id=$2 AND step_key=$3 AND status='succeeded'",
              [p.workspaceId, run.id, key],
            );
      const id = key === 'source' ? run.source_task_id : (ref?.output as Row | undefined)?.taskId;
      if (!id)
        throw new AppError(409, 'STEP_TARGET_MISSING', 'The referenced task is unavailable.');
      const task = await getTask(tx, p, String(id), true);
      if (task.conversation_id !== run.conversation_id)
        throw new AppError(409, 'WORKFLOW_SCOPE_MISMATCH', 'Workflow task audiences changed.');
      return task;
    };
    if (step.type === 'approval') {
      if (previous?.decision_by) {
        if (previous.decision_evidence && output.approved === true) return { wait: false, output };
        throw new AppError(409, 'APPROVAL_REJECTED', 'The workflow approval was rejected.');
      }
      return { wait: true, output: { instructions: step.instructions } };
    }
    if (step.type === 'create_task') {
      let due: string | undefined;
      if (step.dueDays !== undefined) {
        let date = now.toISOString().slice(0, 10);
        if (step.businessCalendarId) {
          const [cal] = await tx.query(
            'SELECT weekdays,holidays,time_zone FROM business_calendars WHERE workspace_id=$1 AND id=$2',
            [p.workspaceId, step.businessCalendarId],
          );
          if (!cal)
            throw new AppError(
              409,
              'CALENDAR_UNAVAILABLE',
              'The business calendar is unavailable.',
            );
          const parts = new Intl.DateTimeFormat('en', {
            timeZone: String(cal.time_zone),
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).formatToParts(now);
          const localDate = ['year', 'month', 'day']
            .map((kind) => parts.find((part) => part.type === kind)!.value)
            .join('-');
          date = businessOffset(
            localDate,
            step.dueDays,
            cal as { weekdays: number[]; holidays: string[] },
          )!;
        } else {
          const d = new Date(now);
          d.setUTCDate(d.getUTCDate() + step.dueDays);
          date = d.toISOString().slice(0, 10);
        }
        due = date;
      }
      const parent = step.parentStep ? await target(step.parentStep) : null;
      const service = new TaskService({
        query: tx.query.bind(tx),
        transaction: (work) => work(tx),
        close: async () => {},
      });
      const result = await service.create(
        p,
        taskInput.parse({
          clientId: randomUUID(),
          title: step.title,
          description: step.description,
          priority: step.priority,
          ...(step.assigneeId ? { assigneeId: step.assigneeId } : {}),
          ...(run.conversation_id ? { conversationId: run.conversation_id } : {}),
          ...(run.project_id ? { projectId: run.project_id } : {}),
          ...(parent ? { parentId: parent.id } : {}),
          ...(due ? { dueDate: due } : {}),
        }),
      );
      for (const text of step.criteria)
        await tx.query(
          'INSERT INTO task_criteria(id,workspace_id,task_id,text) VALUES($1,$2,$3,$4)',
          [randomUUID(), p.workspaceId, result.id, text],
        );
      return { wait: false, output: { taskId: result.id } };
    }
    const task = await target(step.target);
    if (step.type === 'wait_for_task')
      return {
        wait: !step.states.includes(task.state),
        output: { taskId: task.id, state: task.state },
      };
    manageTask(p, task);
    if (step.type === 'transition_task') {
      await transitionTask(tx, p, task, {
        version: task.version,
        state: step.state,
        evidence: step.evidence,
      });
      return { wait: false, output: { taskId: task.id } };
    }
    if (!this.runtimeConfigured)
      throw new AppError(
        503,
        'RUNTIME_NOT_CONFIGURED',
        'Hosted execution must be configured before running agent steps.',
      );
    if (!hasPermission(p, 'execution.manage'))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Workflow owner cannot initiate agent execution.',
      );
    if (output.runId) {
      const [agent] = await tx.query(
        'SELECT status FROM agent_runs WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, output.runId],
      );
      if (!agent) throw new AppError(409, 'RUN_UNAVAILABLE', 'The agent run is unavailable.');
      if (['failed', 'cancelled', 'outcome_unknown'].includes(String(agent.status)))
        throw new AppError(
          409,
          String(agent.status) === 'outcome_unknown' ? 'OUTCOME_UNRESOLVED' : 'AGENT_RUN_FAILED',
          'The agent run requires review.',
        );
      const coordination = await coordinationState(tx, p.workspaceId, String(output.runId));
      if (coordination === 'blocked')
        throw new AppError(
          409,
          'DELEGATION_REQUIRES_REVIEW',
          'A delegated result failed or needs independent review.',
        );
      return {
        wait: agent.status !== 'succeeded' || coordination === 'awaiting_verification',
        output,
      };
    }
    if (!task.conversation_id)
      throw new AppError(409, 'CONVERSATION_REQUIRED', 'Agent runs require a conversation.');
    const [sourceAccess] = await tx.query(
      'SELECT a.id FROM agents a WHERE a.workspace_id=$1 AND a.id=$2 AND resource_visible_to($1,$3,$4::timestamptz,a.membership_id)',
      [p.workspaceId, step.agentId, task.conversation_id, task.created_at],
    );
    if (!sourceAccess)
      throw new AppError(
        409,
        'AGENT_SOURCE_ACCESS_REQUIRED',
        'The agent cannot access this task’s history.',
      );
    const agent = await enqueueRun(tx, p, {
      agentId: step.agentId,
      conversationId: task.conversation_id,
      prompt: step.prompt,
      requestKey: randomUUID(),
    });
    await tx.query(
      'INSERT INTO task_runs(workspace_id,task_id,run_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [p.workspaceId, task.id, agent.id, p.membershipId],
    );
    return { wait: true, output: { runId: agent.id, taskId: task.id } };
  }
  private async notice(
    tx: Sql,
    run: Row,
    definition: WorkflowDefinition,
    kind: 'approval' | 'escalation',
    fallback: string,
  ) {
    const member = kind === 'escalation' ? (definition.escalationMemberId ?? fallback) : fallback;
    const [eligible] = await tx.query(
      "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND kind='human' AND resource_visible_to($1,$3,$4::timestamptz,id)",
      [run.workspace_id, member, run.conversation_id, run.created_at],
    );
    if (!eligible) return;
    const [notice] = await tx.query(
      'INSERT INTO workflow_notices(id,workspace_id,run_id,recipient_id,kind) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
      [randomUUID(), run.workspace_id, run.id, member, kind],
    );
    if (kind === 'escalation')
      await tx.query(
        'UPDATE workflow_runs SET escalated_at=coalesce(escalated_at,clock_timestamp()) WHERE workspace_id=$1 AND id=$2',
        [run.workspace_id, run.id],
      );
    if (notice) {
      const id = randomUUID();
      await tx.query(
        "INSERT INTO notifications(id,workspace_id,recipient_id,actor_id,conversation_id,resource_id,kind,delivery_version) VALUES($1,$2,$3,$4,$5,$6,'workflow_attention',$7) ON CONFLICT DO NOTHING",
        [
          id,
          run.workspace_id,
          member,
          run.created_by,
          run.conversation_id,
          run.id,
          kind === 'approval' ? 1 : 2,
        ],
      );
      await tx.query(
        "INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id) VALUES($1,'notification.created',$2,$3)",
        [run.workspace_id, id, member],
      );
    }
  }
  start(interval = 5000) {
    const run = () => {
      void this.tick().catch(this.onError);
    };
    const timer = setInterval(run, interval);
    timer.unref();
    run();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
}
