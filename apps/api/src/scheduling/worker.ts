import { randomUUID } from 'node:crypto';
import {
  dispatcherScope,
  workerScope,
  scopedDatabase,
  type Database,
  type Sql,
} from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { recordChange } from '../lib/events.js';
import { occurrenceDate } from './dates.js';
export class TaskSchedulingWorker {
  private readonly db: Database;
  constructor(
    db: Database,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  async tick(now = new Date()) {
    const workspaces = await dispatcherScope(() =>
      this.db.query('SELECT id FROM workspaces ORDER BY id'),
    );
    for (const workspace of workspaces) {
      try {
        await workerScope(String(workspace.id), () =>
          this.db.transaction(async (tx) => {
            const ws = String(workspace.id);
            await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [ws]);
            await tx.query('SELECT lock_task_graph($1)', [ws]);
            for (let n = 0; n < 50; n++) if (!(await this.occurrence(tx, ws, now))) break;
            await this.reminders(tx, ws, now);
          }),
        );
      } catch (error) {
        this.onError(error);
      }
    }
  }
  private async occurrence(tx: Sql, ws: string, now: Date): Promise<boolean> {
    const [rule] = await tx.query(
      `SELECT r.*,to_char(r.start_date,'YYYY-MM-DD') anchor,to_char(r.next_date,'YYYY-MM-DD') date,to_char(r.end_date,'YYYY-MM-DD') ending FROM task_recurrences r WHERE workspace_id=$1 AND NOT paused AND next_run_at<=$2 ORDER BY next_run_at,id LIMIT 1 FOR UPDATE`,
      [ws, now],
    );
    if (!rule) return false;
    const [actor] = await tx.query(
      `SELECT id,name,role,kind,permissions,access_type FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND kind='human' FOR SHARE`,
      [ws, rule.created_by],
    );
    await tx.query(
      `SELECT c.id FROM conversations c JOIN tasks t ON t.workspace_id=c.workspace_id AND t.conversation_id=c.id WHERE t.workspace_id=$1 AND t.id=$2 FOR SHARE OF c`,
      [ws, rule.task_id],
    );
    const [source] = await tx.query(
      `SELECT t.* FROM tasks t WHERE t.workspace_id=$1 AND t.id=$2 AND resource_visible_to(t.workspace_id,t.conversation_id,t.created_at,$3) AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=t.workspace_id AND m.id=$3 AND m.status='active' AND m.kind='human' AND coalesce((m.permissions->>'tasks.write')::boolean,true) AND (m.role IN ('owner','admin') OR m.id=t.created_by OR m.id=t.assignee_id OR EXISTS(SELECT 1 FROM task_participants tp WHERE tp.workspace_id=t.workspace_id AND tp.task_id=t.id AND tp.membership_id=m.id AND tp.role='collaborator')))
      AND ((t.conversation_id IS NULL AND EXISTS(SELECT 1 FROM memberships WHERE id=$3 AND access_type='member')) OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=t.workspace_id AND c.id=t.conversation_id AND ((c.visibility='public' AND EXISTS(SELECT 1 FROM memberships WHERE id=$3 AND access_type='member')) OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$3))))
      AND (t.project_id IS NULL OR EXISTS(SELECT 1 FROM projects project WHERE project.workspace_id=t.workspace_id AND project.id=t.project_id AND project.status NOT IN ('completed','archived')))
      AND (t.milestone_id IS NULL OR EXISTS(SELECT 1 FROM project_milestones milestone WHERE milestone.workspace_id=t.workspace_id AND milestone.id=t.milestone_id AND milestone.status NOT IN ('completed','cancelled')))
      AND (t.assignee_id IS NULL OR EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=t.workspace_id AND m.id=t.assignee_id AND m.status='active' AND resource_visible_to(t.workspace_id,t.conversation_id,t.created_at,m.id) AND (t.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=t.workspace_id AND c.id=t.conversation_id AND ((c.visibility='public' AND m.access_type='member') OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=m.id)))))) FOR UPDATE OF t`,
      [ws, rule.task_id, rule.created_by],
    );
    if (!actor || !source) {
      await tx.query(
        `UPDATE task_recurrences SET paused=true,paused_reason='The schedule owner, assignee, project or milestone is no longer eligible. An authorized human must review and resume this schedule.',version=version+1 WHERE workspace_id=$1 AND id=$2`,
        [ws, rule.id],
      );
      await tx.query(
        `INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id) SELECT workspace_id,'task.schedule_paused',id,conversation_id FROM tasks WHERE workspace_id=$1 AND id=$2`,
        [ws, rule.task_id],
      );
      return true;
    }
    const p: Identity = {
      workspaceId: ws,
      membershipId: String(actor.id),
      name: String(actor.name),
      role: actor.role as Identity['role'],
      kind: 'human',
    };
    const [existing] = await tx.query(
      'SELECT task_id FROM task_occurrences WHERE workspace_id=$1 AND recurrence_id=$2 AND occurrence_date=$3',
      [ws, rule.id, rule.date],
    );
    if (!existing) {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO tasks(id,workspace_id,title,description,priority,assignee_id,conversation_id,created_by,due_date,project_id,milestone_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          ws,
          source.title,
          source.description,
          source.priority,
          source.assignee_id,
          source.conversation_id,
          p.membershipId,
          rule.date,
          source.project_id,
          source.milestone_id,
        ],
      );
      await tx.query(
        'INSERT INTO task_occurrences(workspace_id,recurrence_id,task_id,occurrence_date) VALUES($1,$2,$3,$4)',
        [ws, rule.id, id, rule.date],
      );
      await tx.query(
        `INSERT INTO task_reminders(workspace_id,task_id,enabled,days_before,local_time,time_zone) SELECT workspace_id,$3,enabled,days_before,local_time,time_zone FROM task_reminders WHERE workspace_id=$1 AND task_id=$2`,
        [ws, rule.task_id, id],
      );
      await tx.query(
        `INSERT INTO task_label_links(workspace_id,task_id,label_id,assigned_by) SELECT link.workspace_id,$3,link.label_id,$4 FROM task_label_links link JOIN work_labels label ON label.workspace_id=link.workspace_id AND label.id=link.label_id AND NOT label.archived WHERE link.workspace_id=$1 AND link.task_id=$2`,
        [ws, rule.task_id, id, p.membershipId],
      );
      await tx.query(
        'INSERT INTO task_criteria(id,workspace_id,task_id,text,required) SELECT gen_random_uuid(),workspace_id,$3,text,required FROM task_criteria WHERE workspace_id=$1 AND task_id=$2',
        [ws, rule.task_id, id],
      );
      await recordChange(tx, p, 'task.created', id, source.conversation_id as string | null);
    }
    const index = Number(rule.occurrence_index) + 1;
    let next = occurrenceDate(
      String(rule.anchor),
      rule.frequency as 'daily' | 'weekly' | 'monthly' | 'business_daily',
      Number(rule.interval),
      index,
      rule.business_calendar as { weekdays: number[]; holidays: string[] } | null,
    );
    if (next && rule.ending && next > String(rule.ending)) next = null;
    await tx.query(
      `UPDATE task_recurrences SET occurrence_index=$3,occurrence_count=occurrence_count+$4,next_date=$5,next_run_at=(($5::date-lead_days)+local_time) AT TIME ZONE time_zone,version=version+1 WHERE workspace_id=$1 AND id=$2`,
      [ws, rule.id, index, existing ? 0 : 1, next],
    );
    await recordChange(
      tx,
      p,
      'task.schedule_advanced',
      String(rule.task_id),
      source.conversation_id as string | null,
    );
    return true;
  }
  private async reminders(tx: Sql, ws: string, now: Date) {
    const rows = await tx.query(
      `SELECT t.id,t.conversation_id,t.created_by,t.due_version,t.assignment_version,r.version reminder_version,recipient.id recipient_id,COALESCE(np.enabled,true) AND COALESCE(np.tasks,true) AND COALESCE(cp.mode,'default')<>'muted' notify
      FROM tasks t JOIN task_reminders r ON r.workspace_id=t.workspace_id AND r.task_id=t.id AND r.enabled
      JOIN memberships recipient ON recipient.workspace_id=t.workspace_id AND recipient.id=COALESCE(t.assignee_id,t.created_by) AND recipient.status='active' AND recipient.kind='human'
      LEFT JOIN notification_preferences np ON np.workspace_id=t.workspace_id AND np.membership_id=recipient.id
      LEFT JOIN conversation_notification_preferences cp ON cp.workspace_id=t.workspace_id AND cp.membership_id=recipient.id AND cp.conversation_id=t.conversation_id
      WHERE t.workspace_id=$1 AND resource_visible_to(t.workspace_id,t.conversation_id,t.created_at,recipient.id) AND t.due_date IS NOT NULL AND t.state NOT IN ('completed','cancelled') AND ((t.due_date-r.days_before)+r.local_time) AT TIME ZONE r.time_zone <= $2
      AND ((t.conversation_id IS NULL AND recipient.access_type='member') OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=t.workspace_id AND c.id=t.conversation_id AND ((c.visibility='public' AND recipient.access_type='member') OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=recipient.id))))
      AND NOT EXISTS(SELECT 1 FROM task_reminder_deliveries d WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND d.reminder_version=r.version AND d.due_version=t.due_version AND d.assignment_version=t.assignment_version)
      ORDER BY t.due_date,t.id LIMIT 100 FOR UPDATE OF t,r`,
      [ws, now],
    );
    for (const row of rows) {
      if (row.conversation_id) {
        await tx.query('SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR SHARE', [
          ws,
          row.conversation_id,
        ]);
        const [access] = await tx.query(
          `SELECT id FROM conversations c WHERE workspace_id=$1 AND id=$2 AND ((visibility='public' AND EXISTS(SELECT 1 FROM memberships WHERE id=$3 AND access_type='member')) OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$3))`,
          [ws, row.conversation_id, row.recipient_id],
        );
        if (!access) continue;
      }
      const delivery = randomUUID();
      await tx.query(
        `INSERT INTO task_reminder_deliveries(id,workspace_id,task_id,recipient_id,reminder_version,due_version,assignment_version) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          delivery,
          ws,
          row.id,
          row.recipient_id,
          row.reminder_version,
          row.due_version,
          row.assignment_version,
        ],
      );
      if (!row.notify) continue;
      const notice = randomUUID();
      await tx.query(
        `INSERT INTO notifications(id,workspace_id,recipient_id,actor_id,conversation_id,resource_id,kind) VALUES($1,$2,$3,$4,$5,$6,'task_reminder')`,
        [
          notice,
          ws,
          row.recipient_id,
          row.created_by ?? row.recipient_id,
          row.conversation_id,
          delivery,
        ],
      );
      await tx.query(
        `INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id) VALUES($1,'notification.created',$2,$3)`,
        [ws, notice, row.recipient_id],
      );
    }
  }
  start() {
    let stopped = false,
      pending: Promise<void> | undefined;
    const run = () => {
      if (stopped || pending) return;
      pending = this.tick()
        .catch(this.onError)
        .finally(() => {
          pending = undefined;
        });
    };
    const timer = setInterval(run, 30000);
    timer.unref();
    run();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    };
  }
}
