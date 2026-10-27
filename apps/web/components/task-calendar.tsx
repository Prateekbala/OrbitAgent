'use client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Card } from './ui/card';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Channel, Member, RecurringTaskPage, Task, TaskPage } from '@ao/contracts';
import { taskLabels } from '@ao/contracts/tasks';
import { api, HttpError } from '../lib/api';
import { OrganizationFilters } from './task-organization';
import type { TaskFilters } from '../lib/task-filters';
import { localTaskDate } from '../lib/task-display';
type Recurring = RecurringTaskPage['items'][number];
export function TaskCalendar({
  month,
  onMonth,
  revision,
  members,
  channels,
  onOpen,
}: {
  month: string;
  onMonth: (month: string) => void;
  revision: number;
  members: Member[];
  channels: Channel[];
  onOpen: (id: string) => void;
}) {
  const [organization, setOrganization] = useState<TaskFilters>({
    q: '',
    state: '',
    assigneeId: '',
    conversationId: '',
    overdue: false,
    roots: false,
    sort: 'newest',
  });
  const [tasks, setTasks] = useState<Task[]>([]),
    [rules, setRules] = useState<Recurring[]>([]),
    [taskCursor, setTaskCursor] = useState<string | null>(null),
    [ruleCursor, setRuleCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [assignee, setAssignee] = useState(''),
    [source, setSource] = useState(''),
    [state, setState] = useState('');
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (nextTasks: string | null, nextRules: string | null, append = false) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setError('');
      try {
        const first = `${month}-01`,
          end = new Date(`${first}T12:00:00Z`);
        end.setUTCMonth(end.getUTCMonth() + 1, 0);
        const through = end.toISOString().slice(0, 10),
          common = new URLSearchParams();
        for (const key of ['projectId', 'milestoneId', 'labelId'] as const)
          if (organization[key]) common.set(key, organization[key]);
        if (assignee) common.set('assigneeId', assignee);
        if (source === 'workspace') common.set('workspaceOnly', 'true');
        else if (source) common.set('conversationId', source);
        const tq = new URLSearchParams(common),
          rq = new URLSearchParams(common);
        tq.set('dueFrom', first);
        tq.set('dueThrough', through);
        tq.set('sort', 'due');
        tq.set('limit', '100');
        rq.set('from', first);
        rq.set('through', through);
        rq.set('limit', '50');
        if (state) tq.set('state', state);
        if (nextTasks) tq.set('cursor', nextTasks);
        if (nextRules) rq.set('after', nextRules);
        const [taskPage, rulePage] = await Promise.all([
          !append || nextTasks
            ? api<TaskPage>(`/tasks/list?${tq}`, { signal: request.signal })
            : Promise.resolve(null),
          !append || nextRules
            ? api<RecurringTaskPage>(`/task-schedules?${rq}`, { signal: request.signal })
            : Promise.resolve(null),
        ]);
        if (!request.signal.aborted) {
          if (taskPage) {
            setTasks((old) =>
              append
                ? [...new Map([...old, ...taskPage.items].map((t) => [t.id, t])).values()]
                : taskPage.items,
            );
            setTaskCursor(taskPage.next_cursor);
          }
          if (rulePage) {
            setRules((old) =>
              append
                ? [...new Map([...old, ...rulePage.items].map((r) => [r.id, r])).values()]
                : rulePage.items,
            );
            setRuleCursor(rulePage.next_after);
          }
        }
      } catch (e) {
        if (!request.signal.aborted) {
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            setTasks([]);
            setRules([]);
            setTaskCursor(null);
            setRuleCursor(null);
          }
          setError(e instanceof Error ? e.message : 'Unable to load calendar.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [month, assignee, source, state, organization],
  );
  useEffect(() => {
    setTasks([]);
    setRules([]);
    setTaskCursor(null);
    setRuleCursor(null);
    void load(null, null);
    return () => controller.current?.abort();
  }, [load, revision]);
  const first = new Date(`${month}-01T12:00:00Z`),
    last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const today = localTaskDate(),
    offset = (first.getUTCDay() + 6) % 7,
    days = last.getUTCDate();
  const byDay = new Map<string, Task[]>(),
    previews = new Map<string, Recurring[]>();
  for (const task of tasks) {
    if (task.due_date) {
      const rows = byDay.get(task.due_date) ?? [];
      rows.push(task);
      byDay.set(task.due_date, rows);
    }
  }
  if (!state || state === 'proposed')
    for (const rule of rules)
      for (const date of rule.preview_dates) {
        const rows = previews.get(date) ?? [];
        rows.push(rule);
        previews.set(date, rows);
      }
  function shift(amount: number) {
    const date = new Date(first);
    date.setUTCMonth(date.getUTCMonth() + amount);
    if (date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999)
      onMonth(date.toISOString().slice(0, 7));
  }
  return (
    <section className="task-calendar" aria-label="Task calendar">
      <div className="calendar-toolbar">
        <div className="document-actions">
          <Button
            variant="outline"
            type="button"
            aria-label="Previous month"
            disabled={month === '0001-01'}
            onClick={() => shift(-1)}
          >
            ←
          </Button>
          <h3>
            {first.toLocaleDateString(undefined, {
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            })}
          </h3>
          <Button
            variant="outline"
            type="button"
            aria-label="Next month"
            disabled={month === '9999-12'}
            onClick={() => shift(1)}
          >
            →
          </Button>
          <Button variant="outline" type="button" onClick={() => onMonth(today.slice(0, 7))}>
            Today
          </Button>
        </div>
        <label>
          Jump to month
          <Input
            aria-label="Calendar month"
            type="month"
            min="0001-01"
            max="9999-12"
            value={month}
            onChange={(e) => {
              if (/^\d{4}-\d{2}$/.test(e.target.value)) onMonth(e.target.value);
            }}
          />
        </label>
      </div>
      <div className="calendar-filters">
        <label>
          Assignee
          <NativeSelect
            aria-label="Calendar assignee"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">Everyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          Audience
          <NativeSelect
            aria-label="Calendar audience"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">All accessible tasks</option>
            <option value="workspace">Workspace only</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          State
          <NativeSelect
            aria-label="Calendar state"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">All states</option>
            {Object.entries(taskLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <OrganizationFilters value={organization} onChange={setOrganization} />
      <p className="muted calendar-legend">
        Dates follow each task’s due date. Dashed entries preview future recurring occurrences; open
        one to manage its source schedule.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {busy && <p role="status">Loading calendar…</p>}
      <div className="calendar-scroll">
        <div className="calendar-grid" role="table" aria-label={`${month} due dates`}>
          <div className="calendar-week" role="row">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
              <div role="columnheader" key={day}>
                {day}
              </div>
            ))}
          </div>
          {Array.from({ length: Math.ceil((offset + days) / 7) }, (_, week) => (
            <div className="calendar-week" role="row" key={week}>
              {Array.from({ length: 7 }, (_, weekday) => {
                const day = week * 7 + weekday - offset + 1,
                  date = `${month}-${String(day).padStart(2, '0')}`;
                return day < 1 || day > days ? (
                  <div className="calendar-day empty" role="cell" key={weekday} />
                ) : (
                  <div
                    className={`calendar-day${date === today ? ' today' : ''}`}
                    role="cell"
                    aria-label={date}
                    key={date}
                  >
                    <time dateTime={date}>{day}</time>
                    {byDay.get(date)?.map((task) => (
                      <Button
                        variant="outline"
                        className={`calendar-task ${task.state}`}
                        type="button"
                        key={task.id}
                        title={`${task.title} · ${taskLabels[task.state]} · ${task.assignee_name ?? 'Unassigned'}`}
                        onClick={() => onOpen(task.id)}
                      >
                        <span>{task.title}</span>
                        <small>{taskLabels[task.state]}</small>
                      </Button>
                    ))}
                    {previews.get(date)?.map((rule) => (
                      <Button
                        variant="outline"
                        className="calendar-task preview"
                        type="button"
                        key={rule.id}
                        onClick={() => onOpen(rule.task_id)}
                      >
                        <span>↻ {rule.title}</span>
                        <small>
                          Scheduled · {rule.local_time} {rule.time_zone}
                        </small>
                      </Button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {(taskCursor || ruleCursor) && (
        <div className="calendar-more">
          <p role="status">
            More tasks or recurring schedules are available for this month. Load them to complete
            the calendar.
          </p>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => void load(taskCursor, ruleCursor, true)}
          >
            Load more calendar entries
          </Button>
        </div>
      )}
      {!busy && !tasks.length && !Array.from(previews.values()).some((rows) => rows.length) && (
        <p className="muted">No due dates in this month for these filters.</p>
      )}
    </section>
  );
}
export function RecurringTaskList({
  revision,
  onOpen,
}: {
  revision: number;
  onOpen: (id: string) => void;
}) {
  const [items, setItems] = useState<Recurring[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (cursor: string | null) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    try {
      const page = await api<RecurringTaskPage>(
        `/task-schedules?limit=30${cursor ? `&after=${cursor}` : ''}`,
        { signal: request.signal },
      );
      if (!request.signal.aborted) {
        setItems((old) =>
          cursor
            ? [...new Map([...old, ...page.items].map((r) => [r.id, r])).values()]
            : page.items,
        );
        setAfter(page.next_after);
      }
    } catch (e) {
      if (!request.signal.aborted) {
        setItems([]);
        setAfter(null);
        setError(e instanceof Error ? e.message : 'Unable to load recurring schedules.');
      }
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    setItems([]);
    setAfter(null);
    void load(null);
    return () => controller.current?.abort();
  }, [load, revision]);
  return (
    <Card asChild>
      <section className="recurring-task-list" aria-label="Recurring schedules">
        <h3>Recurring schedules</h3>
        <p className="muted">
          Open a source task to edit, pause, or resume its schedule. Existing occurrences remain
          independent.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {items.map((rule) => (
          <article className="recurring-task-row" key={rule.id}>
            <Button
              variant="link"
              type="button"
              className="text-button"
              onClick={() => onOpen(rule.task_id)}
            >
              {rule.title}
            </Button>
            <span>
              {rule.frequency.replaceAll('_', ' ')} · every {rule.interval}
            </span>
            <span>
              {rule.paused ? 'Paused' : rule.next_date ? `Next: ${rule.next_date}` : 'Ended'}
            </span>
            <small>
              {rule.local_time} · {rule.time_zone} · {rule.occurrence_count} created
            </small>
          </article>
        ))}
        {busy ? (
          <p role="status">Loading schedules…</p>
        ) : (
          items.length === 0 && (
            <p>No recurring schedules yet. Open a task and choose “Make recurring.”</p>
          )
        )}
        {after && (
          <Button variant="outline" type="button" disabled={busy} onClick={() => void load(after)}>
            Load more schedules
          </Button>
        )}
      </section>
    </Card>
  );
}
