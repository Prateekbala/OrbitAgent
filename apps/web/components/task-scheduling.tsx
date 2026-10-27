'use client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { useEffect, useRef, useState } from 'react';
import type { Task, TaskScheduling } from '@ao/contracts';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
import type { BusinessCalendar } from '@ao/contracts/workflows';
import { api, HttpError } from '../lib/api';
import { localTaskDate } from '../lib/task-display';
type RecurrenceDraft = {
  version: number;
  frequency: 'daily' | 'weekly' | 'monthly' | 'business_daily';
  businessCalendarId?: string;
  interval: number;
  startDate: string;
  endDate: string | null;
  timeZone: string;
  localTime: string;
  paused: boolean;
  leadDays: number;
};
type ReminderDraft = {
  version: number;
  enabled: boolean;
  daysBefore: number;
  localTime: string;
  timeZone: string;
};
function browserZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function firstNewOccurrence(dueDate: string | null) {
  const date = new Date(`${dueDate ?? localTaskDate()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 7);
  return date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : '9999-12-31';
}
export function TaskSchedulingPanel({
  task,
  canManage,
  human,
  revision,
  onChanged,
  onOpen,
}: {
  task: Task;
  canManage: boolean;
  human: boolean;
  revision: number;
  onChanged: () => Promise<unknown>;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<TaskScheduling | null>(null),
    [recurrence, setRecurrence] = useState<RecurrenceDraft | null>(null),
    [reminder, setReminder] = useState<ReminderDraft | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const calendars = useCursorPage<BusinessCalendar>(
    canManage ? task.id : null,
    '/business-calendars',
    revision,
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const request = new AbortController();
    void api<TaskScheduling>(`/tasks/${task.id}/scheduling`, { signal: request.signal })
      .then((result) => {
        if (!request.signal.aborted) setData(result);
      })
      .catch((e) => {
        if (!request.signal.aborted) {
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            setData(null);
            setRecurrence(null);
            setReminder(null);
          }
          setError(e instanceof Error ? e.message : 'Unable to load scheduling.');
        }
      });
    return () => request.abort();
  }, [task.id, revision]);
  async function save(e: React.FormEvent, kind: 'recurrence' | 'reminder') {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${task.id}/${kind}`, {
        method: 'PUT',
        body: JSON.stringify(kind === 'recurrence' ? recurrence : reminder),
      });
      if (alive.current) {
        if (kind === 'recurrence') setRecurrence(null);
        else setReminder(null);
        await onChanged();
      }
    } catch (e) {
      if (alive.current) {
        if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
          setData(null);
          setRecurrence(null);
          setReminder(null);
        }
        setError(e instanceof Error ? e.message : 'Unable to save scheduling.');
        await onChanged();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="task-section task-scheduling">
      <h3>Recurrence and reminders</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!data ? (
        <p role="status">Loading scheduling…</p>
      ) : (
        <>
          {data.origin && (
            <p className="muted">
              Recurring occurrence for {data.origin.occurrence_date}.{' '}
              <Button
                variant="link"
                className="text-button"
                type="button"
                onClick={() => onOpen(data.origin!.source_task_id)}
              >
                Open recurring source
              </Button>
            </p>
          )}
          <div className="task-schedule-summary">
            <strong>Recurrence</strong>
            <p>
              {data.recurrence
                ? `Every ${data.recurrence.interval} ${data.recurrence.frequency === 'daily' ? 'day(s)' : data.recurrence.frequency === 'weekly' ? 'week(s)' : data.recurrence.frequency === 'business_daily' ? 'business day(s)' : 'month(s)'} at ${data.recurrence.local_time} · ${data.recurrence.time_zone} · Creates ${data.recurrence.lead_days} day(s) before due`
                : 'Does not repeat'}
            </p>
            {data.recurrence && (
              <p className="muted">
                {data.recurrence.paused
                  ? 'Paused'
                  : data.recurrence.next_date
                    ? `Next due date: ${data.recurrence.next_date}`
                    : 'Schedule ended'}{' '}
                · {data.recurrence.occurrence_count} created
                {data.recurrence.end_date ? ` · Ends ${data.recurrence.end_date}` : ''}
              </p>
            )}
            {data.recurrence?.paused_reason && (
              <p role="status" className="task-blocker-notice">
                {data.recurrence.paused_reason}
              </p>
            )}
            {canManage && human && !recurrence && (
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  const r = data.recurrence;
                  setRecurrence(
                    r
                      ? {
                          version: r.version,
                          frequency: r.frequency,
                          ...(r.business_calendar
                            ? { businessCalendarId: r.business_calendar.id }
                            : {}),
                          interval: r.interval,
                          startDate: r.start_date,
                          endDate: r.end_date,
                          timeZone: r.time_zone,
                          localTime: r.local_time,
                          paused: r.paused,
                          leadDays: r.lead_days,
                        }
                      : {
                          version: 0,
                          frequency: 'weekly',
                          interval: 1,
                          startDate: firstNewOccurrence(task.due_date),
                          endDate: null,
                          timeZone: browserZone(),
                          localTime: '00:00',
                          paused: false,
                          leadDays: 1,
                        },
                  );
                }}
              >
                {' '}
                {data.recurrence ? 'Edit recurring schedule' : 'Make recurring'}
              </Button>
            )}
          </div>
          {recurrence && (
            <form className="task-edit-form" onSubmit={(e) => void save(e, 'recurrence')}>
              <p className="muted">
                Each occurrence creates an independent proposed task with the source’s current
                title, description, priority, assignee, audience and reminder. Its due date is the
                occurrence date. Subtasks, dependencies and comments stay on their original tasks.
                Completing the source does not stop the schedule.
              </p>
              {recurrence.version !== (data.recurrence?.version ?? 0) && (
                <p role="status">
                  This schedule changed. Cancel and reopen it to review the latest settings.
                </p>
              )}
              <div className="task-form-columns">
                <label>
                  Repeat every
                  <Input
                    aria-label="Recurrence interval"
                    type="number"
                    min={1}
                    max={365}
                    required
                    value={recurrence.interval}
                    disabled={busy}
                    onChange={(e) =>
                      setRecurrence({ ...recurrence, interval: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Frequency
                  <NativeSelect
                    aria-label="Recurrence frequency"
                    value={recurrence.frequency}
                    disabled={busy}
                    onChange={(e) =>
                      setRecurrence({
                        ...recurrence,
                        frequency: e.target.value as RecurrenceDraft['frequency'],
                      })
                    }
                  >
                    <option value="daily">Days</option>
                    <option value="weekly">Weeks</option>
                    <option value="monthly">Months</option>
                    <option value="business_daily">Business days</option>
                  </NativeSelect>
                </label>
                {recurrence.frequency === 'business_daily' ? (
                  <>
                    <label>
                      Business calendar
                      <NativeSelect
                        required
                        aria-label="Recurrence business calendar"
                        value={recurrence.businessCalendarId ?? ''}
                        onChange={(event) => {
                          const calendar = calendars.items.find((c) => c.id === event.target.value);
                          setRecurrence({
                            ...recurrence,
                            businessCalendarId: event.target.value,
                            ...(calendar ? { timeZone: calendar.time_zone } : {}),
                          });
                        }}
                      >
                        <option value="">Choose a business calendar</option>
                        {calendars.items.map((calendar) => (
                          <option key={calendar.id} value={calendar.id}>
                            {calendar.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                    <PageControls {...calendars} onMore={calendars.more} />
                  </>
                ) : null}
                <label>
                  First occurrence
                  <Input
                    aria-label="First occurrence"
                    type="date"
                    min="0001-01-01"
                    max="9999-12-31"
                    required
                    value={recurrence.startDate}
                    disabled={busy}
                    onChange={(e) => setRecurrence({ ...recurrence, startDate: e.target.value })}
                  />
                </label>
                <label>
                  End date (optional)
                  <Input
                    aria-label="Recurrence end date"
                    type="date"
                    min={recurrence.startDate}
                    max="9999-12-31"
                    value={recurrence.endDate ?? ''}
                    disabled={busy}
                    onChange={(e) =>
                      setRecurrence({ ...recurrence, endDate: e.target.value || null })
                    }
                  />
                </label>
                <label>
                  Create days before due
                  <Input
                    aria-label="Recurrence creation lead days"
                    type="number"
                    min={0}
                    max={365}
                    required
                    value={recurrence.leadDays}
                    disabled={busy}
                    onChange={(e) =>
                      setRecurrence({ ...recurrence, leadDays: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Creation time
                  <Input
                    aria-label="Recurrence creation time"
                    type="time"
                    required
                    value={recurrence.localTime}
                    disabled={busy}
                    onChange={(e) => setRecurrence({ ...recurrence, localTime: e.target.value })}
                  />
                </label>
                <label>
                  IANA time zone
                  <Input
                    aria-label="Recurrence time zone"
                    required
                    maxLength={100}
                    value={recurrence.timeZone}
                    disabled={busy}
                    onChange={(e) => setRecurrence({ ...recurrence, timeZone: e.target.value })}
                  />
                </label>
              </div>
              <label className="checkbox-label">
                <Input
                  type="checkbox"
                  checked={recurrence.paused}
                  disabled={busy}
                  onChange={(e) => setRecurrence({ ...recurrence, paused: e.target.checked })}
                />
                Pause this schedule
              </label>
              <p className="muted">
                Monthly schedules use the last day of shorter months, then return to the original
                day. Past dates are caught up in batches after saving or resuming.
              </p>
              <div className="document-actions">
                <Button
                  size="sm"
                  className="primary small"
                  disabled={busy || recurrence.version !== (data.recurrence?.version ?? 0)}
                >
                  Save recurring schedule
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => setRecurrence(null)}
                >
                  Cancel recurrence edit
                </Button>
              </div>
            </form>
          )}
          <div className="task-schedule-summary">
            <strong>Due-date reminder</strong>
            <p>
              {data.reminder?.enabled
                ? `${data.reminder.days_before === 0 ? 'On the due date' : `${data.reminder.days_before} day(s) before due`} at ${data.reminder.local_time} · ${data.reminder.time_zone}`
                : 'No reminder'}
            </p>
            <p className="muted">
              Delivered once to the human assignee’s inbox, or the creator if unassigned. Inbox
              preferences and conversation mutes apply. Overdue reminders are delivered after
              downtime.
            </p>
            {canManage && !reminder && (
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  const r = data.reminder;
                  setReminder(
                    r
                      ? {
                          version: r.version,
                          enabled: r.enabled,
                          daysBefore: r.days_before,
                          localTime: r.local_time,
                          timeZone: r.time_zone,
                        }
                      : {
                          version: 0,
                          enabled: true,
                          daysBefore: 0,
                          localTime: '09:00',
                          timeZone: browserZone(),
                        },
                  );
                }}
              >
                {data.reminder ? 'Edit due-date reminder' : 'Add due-date reminder'}
              </Button>
            )}
          </div>
          {reminder && (
            <form className="task-edit-form" onSubmit={(e) => void save(e, 'reminder')}>
              {reminder.version !== (data.reminder?.version ?? 0) && (
                <p role="status">
                  The reminder changed. Cancel and reopen to review the latest settings.
                </p>
              )}
              {!task.due_date && (
                <p role="status">Set a task due date before enabling its reminder.</p>
              )}
              <label className="checkbox-label">
                <Input
                  type="checkbox"
                  checked={reminder.enabled}
                  disabled={busy}
                  onChange={(e) => setReminder({ ...reminder, enabled: e.target.checked })}
                />
                Enable due-date reminder
              </label>
              <div className="task-form-columns">
                <label>
                  Days before due
                  <Input
                    aria-label="Reminder days before"
                    type="number"
                    min={0}
                    max={365}
                    required
                    value={reminder.daysBefore}
                    disabled={busy}
                    onChange={(e) =>
                      setReminder({ ...reminder, daysBefore: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Reminder time
                  <Input
                    aria-label="Reminder time"
                    type="time"
                    required
                    value={reminder.localTime}
                    disabled={busy}
                    onChange={(e) => setReminder({ ...reminder, localTime: e.target.value })}
                  />
                </label>
                <label>
                  IANA time zone
                  <Input
                    aria-label="Reminder time zone"
                    required
                    maxLength={100}
                    value={reminder.timeZone}
                    disabled={busy}
                    onChange={(e) => setReminder({ ...reminder, timeZone: e.target.value })}
                  />
                </label>
              </div>
              <div className="document-actions">
                <Button
                  size="sm"
                  className="primary small"
                  disabled={
                    busy ||
                    (!task.due_date && reminder.enabled) ||
                    reminder.version !== (data.reminder?.version ?? 0)
                  }
                >
                  Save due-date reminder
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => setReminder(null)}
                >
                  Cancel reminder edit
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
