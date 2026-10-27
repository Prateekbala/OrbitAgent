import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import type { z } from 'zod';
import type { recurrenceInput, reminderInput, TaskRecurrence, TaskReminder } from '@ao/contracts';
import { taskActor, manageTask } from '../tasks/service.js';
import { getTask } from '../tasks/queries.js';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { occurrenceDate } from './dates.js';
import { recordChange } from '../lib/events.js';
export const recurrenceColumns = `r.id,r.business_calendar,r.task_id,r.frequency,r.interval,to_char(r.start_date,'YYYY-MM-DD') start_date,to_char(r.end_date,'YYYY-MM-DD') end_date,r.time_zone,r.lead_days,to_char(r.local_time,'HH24:MI') local_time,to_char(r.next_date,'YYYY-MM-DD') next_date,r.next_run_at,r.paused,r.paused_reason,r.version,r.occurrence_count`;
async function zone(tx: Sql, timeZone: string) {
  const [found] = await tx.query('SELECT name FROM pg_timezone_names WHERE name=$1', [timeZone]);
  if (!found) throw new AppError(400, 'INVALID_TIME_ZONE', 'Choose a supported IANA time zone.');
}
function revision(row: Record<string, unknown> | undefined, version: number) {
  if (Number(row?.version ?? 0) !== version)
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'This schedule changed. Refresh and review it before saving again.',
    );
}
export class SchedulingService {
  constructor(private readonly db: Database) {}
  async details(p: Identity, taskId: string) {
    await getTask(this.db, p, taskId);
    const [recurrence] = await this.db.query<TaskRecurrence & Record<string, unknown>>(
      `SELECT ${recurrenceColumns} FROM task_recurrences r WHERE r.workspace_id=$1 AND r.task_id=$2`,
      [p.workspaceId, taskId],
    );
    const [reminder] = await this.db.query<TaskReminder & Record<string, unknown>>(
      `SELECT enabled,days_before,to_char(local_time,'HH24:MI') local_time,time_zone,version FROM task_reminders WHERE workspace_id=$1 AND task_id=$2`,
      [p.workspaceId, taskId],
    );
    const [origin] = await this.db.query(
      `SELECT r.task_id source_task_id,to_char(o.occurrence_date,'YYYY-MM-DD') occurrence_date FROM task_occurrences o JOIN task_recurrences r ON r.workspace_id=o.workspace_id AND r.id=o.recurrence_id WHERE o.workspace_id=$1 AND o.task_id=$2`,
      [p.workspaceId, taskId],
    );
    return { recurrence: recurrence ?? null, reminder: reminder ?? null, origin: origin ?? null };
  }
  async recurrence(p: Identity, id: string, input: z.infer<typeof recurrenceInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      if (p.kind !== 'human')
        throw new AppError(403, 'HUMAN_REQUIRED', 'A human must authorize a recurring schedule.');
      await zone(tx, input.timeZone);
      const [old] = await tx.query(
        `SELECT *,to_char(start_date,'YYYY-MM-DD') anchor FROM task_recurrences WHERE workspace_id=$1 AND task_id=$2 FOR UPDATE`,
        [p.workspaceId, id],
      );
      revision(old, input.version);
      const unchanged =
        old &&
        old.frequency === input.frequency &&
        Number(old.interval) === input.interval &&
        old.anchor === input.startDate;
      let business: Record<string, unknown> | null = null;
      if (input.frequency === 'business_daily') {
        if (!input.businessCalendarId)
          throw new AppError(400, 'BUSINESS_CALENDAR_REQUIRED', 'Choose a business calendar.');
        const [calendar] = await tx.query(
          'SELECT id,name,weekdays,holidays,version,time_zone FROM business_calendars WHERE workspace_id=$1 AND id=$2',
          [p.workspaceId, input.businessCalendarId],
        );
        if (!calendar)
          throw new AppError(400, 'CALENDAR_UNAVAILABLE', 'Choose a workspace business calendar.');
        if (calendar.time_zone !== input.timeZone)
          throw new AppError(
            400,
            'CALENDAR_ZONE_MISMATCH',
            'Use the business calendar’s time zone.',
          );
        business = calendar;
      }
      const index = unchanged ? Number(old.occurrence_index) : 0;
      let date = occurrenceDate(
        input.startDate,
        input.frequency,
        input.interval,
        index,
        business as { weekdays: number[]; holidays: string[] } | null,
      );
      if (date && input.endDate && date > input.endDate) date = null;
      await tx.query(
        `INSERT INTO task_recurrences(id,workspace_id,task_id,created_by,frequency,interval,start_date,end_date,time_zone,local_time,next_date,next_run_at,paused,occurrence_index,lead_days,business_calendar)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(($11::date-$14::integer)+$10::time) AT TIME ZONE $9,$12,$13,$14,$15::jsonb)
        ON CONFLICT(workspace_id,task_id) DO UPDATE SET business_calendar=EXCLUDED.business_calendar,created_by=EXCLUDED.created_by,frequency=EXCLUDED.frequency,interval=EXCLUDED.interval,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,time_zone=EXCLUDED.time_zone,local_time=EXCLUDED.local_time,lead_days=EXCLUDED.lead_days,next_date=EXCLUDED.next_date,next_run_at=EXCLUDED.next_run_at,paused=EXCLUDED.paused,paused_reason=NULL,occurrence_index=EXCLUDED.occurrence_index,version=task_recurrences.version+1`,
        [
          old?.id ?? randomUUID(),
          p.workspaceId,
          id,
          p.membershipId,
          input.frequency,
          input.interval,
          input.startDate,
          input.endDate,
          input.timeZone,
          input.localTime,
          date,
          input.paused,
          index,
          input.leadDays,
          business ? JSON.stringify(business) : null,
        ],
      );
      await recordChange(tx, p, 'task.schedule_updated', id, task.conversation_id);
      return { ok: true };
    });
  }
  async reminder(p: Identity, id: string, input: z.infer<typeof reminderInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      await zone(tx, input.timeZone);
      const [old] = await tx.query(
        'SELECT version FROM task_reminders WHERE workspace_id=$1 AND task_id=$2 FOR UPDATE',
        [p.workspaceId, id],
      );
      revision(old, input.version);
      if (!task.due_date && input.enabled)
        throw new AppError(
          400,
          'DUE_DATE_REQUIRED',
          'Set a due date before enabling its reminder.',
        );
      await tx.query(
        `INSERT INTO task_reminders(workspace_id,task_id,enabled,days_before,local_time,time_zone) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(workspace_id,task_id) DO UPDATE SET enabled=EXCLUDED.enabled,days_before=EXCLUDED.days_before,local_time=EXCLUDED.local_time,time_zone=EXCLUDED.time_zone,version=task_reminders.version+1`,
        [p.workspaceId, id, input.enabled, input.daysBefore, input.localTime, input.timeZone],
      );
      await recordChange(tx, p, 'task.reminder_updated', id, task.conversation_id);
      return { ok: true };
    });
  }
}
