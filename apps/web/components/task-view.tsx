'use client';
import { Button } from './ui/button';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Skeleton } from './ui/skeleton';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckSquare,
  Plus,
  SlidersHorizontal,
  List,
  Columns3,
  Calendar,
  Repeat,
  Folder,
  Tag,
  Workflow,
  Layers,
  Settings2,
} from 'lucide-react';
import { WorkspaceHeading } from './workspace-heading';
import type { Task, TaskPage, Member, Channel } from '@ao/contracts';
import { taskLabels, taskMoves } from '@ao/contracts/tasks';
import { api, post, HttpError } from '../lib/api';
import { dueLabel, localTaskDate, overdueTask } from '../lib/task-display';
import { Empty } from './primitives';
import { Dialog } from './dialog';
import { WorkflowHub } from './workflow-hub';
import { PortfolioHub } from './project-reporting';
import { CalendarSettings } from './calendar-settings';
import { TaskCalendar, RecurringTaskList } from './task-calendar';
import { taskFilterParams, type TaskFilters } from '../lib/task-filters';
import { OrganizationFilters, TaskBadges } from './task-organization';
import { ProjectHub } from './project-hub';
import { LabelManager } from './label-manager';
import { TaskBoard } from './task-board';
import { TaskBulkActions } from './task-bulk-actions';
import { TaskDetail } from './task-detail';
const taskViews = [
  { value: 'list', label: 'List', icon: List },
  { value: 'board', label: 'Kanban', icon: Columns3 },
  { value: 'calendar', label: 'Calendar', icon: Calendar },
  { value: 'recurring', label: 'Recurring', icon: Repeat },
  { value: 'projects', label: 'Projects', icon: Folder },
  { value: 'labels', label: 'Labels', icon: Tag },
  { value: 'workflows', label: 'Workflows', icon: Workflow },
  { value: 'portfolios', label: 'Portfolios', icon: Layers },
  { value: 'calendar-settings', label: 'Calendar settings', icon: Settings2 },
] as const;
const initial: TaskFilters = {
  q: '',
  state: '',
  assigneeId: '',
  conversationId: '',
  overdue: false,
  roots: false,
  sort: 'newest',
};
export function TaskView({
  revision,
  openWorkflow,
  onWorkflow,
  me,
  members,
  channels,
  selectedId,
  onSelect,
  onCreate,
  onChanged,
}: {
  revision: number;
  openWorkflow?: string | null;
  onWorkflow?: (id: string | null) => void;
  me: Member;
  members: Member[];
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const [mode, setMode] = useState<
      | 'list'
      | 'board'
      | 'calendar'
      | 'recurring'
      | 'projects'
      | 'labels'
      | 'workflows'
      | 'portfolios'
      | 'calendar-settings'
    >(openWorkflow ? 'workflows' : 'list'),
    [month, setMonth] = useState(() => localTaskDate().slice(0, 7));
  useEffect(() => {
    if (openWorkflow) setMode('workflows');
  }, [openWorkflow]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [selected, setSelected] = useState<Task[]>([]);
  const [draft, setDraft] = useState(initial),
    [filters, setFilters] = useState(initial),
    [items, setItems] = useState<Task[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [moving, setMoving] = useState(false),
    [completion, setCompletion] = useState<Task | null>(null),
    [evidence, setEvidence] = useState('');
  const controller = useRef<AbortController | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const load = useCallback(
    async (next: string | null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setError('');
      try {
        const params = taskFilterParams(filters);
        params.set('limit', '30');
        if (next) params.set('cursor', next);
        const page = await api<TaskPage>(`/tasks/list?${params}`, { signal: request.signal });
        if (!request.signal.aborted) {
          setItems((old) =>
            next
              ? [...new Map([...old, ...page.items].map((t) => [t.id, t])).values()]
              : page.items,
          );
          setCursor(page.next_cursor);
        }
      } catch (e) {
        if (!request.signal.aborted) {
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            setItems([]);
            setCursor(null);
          }
          setError(e instanceof Error ? e.message : 'Unable to load tasks.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [filters],
  );
  useEffect(() => {
    setItems([]);
    setCursor(null);
    if (!selectedId && mode === 'list') void load(null);
    return () => controller.current?.abort();
  }, [load, revision, selectedId, mode]);
  useEffect(() => {
    setSelected([]);
  }, [filters, mode, selectedId]);
  function toggle(task: Task) {
    setSelected((old) =>
      old.some((t) => t.id === task.id)
        ? old.filter((t) => t.id !== task.id)
        : old.length < 50
          ? [...old, task]
          : old,
    );
  }
  function moveFromView(task: Task, state: string) {
    if (state === 'completed') {
      setCompletion(task);
      setEvidence('');
      setError('');
    } else void move(task, state);
  }
  function selectLoaded() {
    const choices = items.filter(
      (task) =>
        task.is_collaborator === true ||
        task.created_by === me.id ||
        task.assignee_id === me.id ||
        (me.kind === 'human' && ['owner', 'admin'].includes(me.role)),
    );
    const union = [...new Map([...selected, ...choices].map((t) => [t.id, t])).values()];
    if (union.length > 50) {
      setError('Select up to 50 tasks at a time. Clear the selection or choose individual tasks.');
      return;
    }
    setSelected(union);
  }
  async function move(task: Task, state: string, proof = '') {
    if (moving) return;
    setMoving(true);
    setError('');
    try {
      await post(`/tasks/${task.id}/transitions`, {
        state,
        version: task.version,
        evidence: proof,
      });
      if (alive.current) {
        setCompletion(null);
        setEvidence('');
        await onChanged();
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to update task.');
        await onChanged();
      }
    } finally {
      if (alive.current) setMoving(false);
    }
  }
  if (selectedId)
    return (
      <TaskDetail
        key={selectedId}
        id={selectedId}
        revision={revision}
        me={me}
        members={members}
        channels={channels}
        onOpen={onSelect}
        onBack={() => onSelect(null)}
        onChanged={onChanged}
      />
    );
  return (
    <section className="page-content task-page">
      <WorkspaceHeading
        icon={CheckSquare}
        eyebrow="Plan, prioritize, deliver"
        title="Workspace tasks"
        description="Connect every next step to an owner, a project, and a clear definition of done."
      />
      <ToggleGroup
        type="multiple"
        role="group"
        className="task-view-switch"
        aria-label="Task view"
        value={[mode]}
        spacing={1}
        onValueChange={(values) => {
          const next = taskViews.find((item) => item.value === values.at(-1));
          if (next) setMode(next.value);
        }}
      >
        {taskViews.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value}>
            <item.icon size={15} aria-hidden="true" />
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {mode === 'workflows' ? (
        <WorkflowHub
          revision={revision}
          me={me}
          members={members}
          channels={channels}
          onChanged={onChanged}
          openRun={openWorkflow}
          {...(onWorkflow ? { onRun: onWorkflow } : {})}
        />
      ) : mode === 'portfolios' ? (
        <PortfolioHub revision={revision} me={me} channels={channels} onChanged={onChanged} />
      ) : mode === 'calendar-settings' ? (
        <CalendarSettings me={me} revision={revision} onChanged={onChanged} />
      ) : mode === 'projects' ? (
        <ProjectHub
          revision={revision}
          me={me}
          members={members}
          channels={channels}
          selectedId={selectedProjectId}
          onSelect={setSelectedProjectId}
          onChanged={onChanged}
          onTasks={(project, milestone) => {
            const next = {
              ...initial,
              projectId: project.id,
              projectName: project.name,
              milestoneId: milestone?.id ?? '',
              milestoneTitle: milestone?.title ?? '',
            };
            setDraft(next);
            setFilters(next);
            setMode('list');
          }}
        />
      ) : mode === 'labels' ? (
        <LabelManager revision={revision} me={me} onChanged={onChanged} />
      ) : mode === 'calendar' ? (
        <TaskCalendar
          month={month}
          onMonth={setMonth}
          revision={revision}
          members={members}
          channels={channels}
          onOpen={onSelect}
        />
      ) : mode === 'recurring' ? (
        <RecurringTaskList revision={revision} onOpen={onSelect} />
      ) : (
        <>
          <Button
            variant="outline"
            className="mobile-task-filters"
            type="button"
            aria-controls="task-filters"
            aria-expanded={filtersExpanded}
            onClick={() => setFiltersExpanded((expanded) => !expanded)}
          >
            <SlidersHorizontal size={15} /> Filters
          </Button>
          <form
            id="task-filters"
            className="task-filters"
            data-expanded={filtersExpanded}
            onSubmit={(e) => {
              e.preventDefault();
              setFilters({ ...draft, q: draft.q.trim() });
              setFiltersExpanded(false);
            }}
          >
            <label>
              Find tasks
              <Input
                aria-label="Find tasks"
                value={draft.q}
                maxLength={200}
                onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              />
            </label>
            <label>
              State
              <NativeSelect
                aria-label="Task state filter"
                value={draft.state}
                onChange={(e) => setDraft({ ...draft, state: e.target.value })}
              >
                <option value="">All states</option>
                {Object.entries(taskLabels).map(([state, label]) => (
                  <option key={state} value={state}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Assignee
              <NativeSelect
                aria-label="Task assignee filter"
                value={draft.assigneeId}
                onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}
              >
                <option value="">Anyone</option>
                <option value="unassigned">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.id === me.id ? ' (you)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Audience
              <NativeSelect
                aria-label="Task audience filter"
                value={draft.conversationId}
                onChange={(e) => setDraft({ ...draft, conversationId: e.target.value })}
              >
                <option value="">All accessible tasks</option>
                <option value="workspace">Workspace-wide only</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Sort
              <NativeSelect
                aria-label="Task sort"
                value={draft.sort}
                onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
              >
                <option value="newest">Newest first</option>
                <option value="due">Due date</option>
                <option value="priority">Priority</option>
              </NativeSelect>
            </label>
            <div className="task-filter-footer">
              <div className="task-filter-toggles">
                <label className="checkbox-field">
                  <Input
                    type="checkbox"
                    checked={draft.overdue}
                    onChange={(e) => setDraft({ ...draft, overdue: e.target.checked })}
                  />
                  Overdue only
                </label>
                <label className="checkbox-field">
                  <Input
                    type="checkbox"
                    checked={draft.roots}
                    onChange={(e) => setDraft({ ...draft, roots: e.target.checked })}
                  />
                  Root tasks only
                </label>
              </div>
              <Button size="sm" className="primary small" type="submit">
                Apply task filters
              </Button>
            </div>
            <OrganizationFilters value={draft} onChange={setDraft} />
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <TaskBulkActions
            selected={selected}
            members={members}
            onClear={() => setSelected([])}
            onReview={setSelected}
            onChanged={onChanged}
          />
          {mode === 'board' ? (
            <TaskBoard
              filters={filters}
              revision={revision}
              me={me}
              onOpen={onSelect}
              onMove={moveFromView}
              moving={moving}
              selected={selected}
              onToggle={toggle}
            />
          ) : (
            <>
              {items.length > 0 && (
                <Button variant="link" type="button" className="text-button" onClick={selectLoaded}>
                  Select loaded tasks
                </Button>
              )}
              {busy && (
                <div className="task-loading" aria-busy="true">
                  <p className="muted" role="status">
                    Loading tasks…
                  </p>
                  <Skeleton className="h-16 w-full" aria-hidden="true" />
                </div>
              )}
              {!busy && !error && items.length === 0 ? (
                <Empty
                  icon={CheckSquare}
                  title="Your next step starts here"
                  description="No tasks match these filters. Create work with a clear owner and definition of done."
                  action={
                    <Button size="sm" className="primary small" onClick={onCreate}>
                      Create a task <Plus size={16} />
                    </Button>
                  }
                />
              ) : (
                <Card asChild>
                  <div className="task-list">
                    {items.map((task) => (
                      <article className="task-row" key={task.id}>
                        {(task.is_collaborator === true ||
                          task.created_by === me.id ||
                          task.assignee_id === me.id ||
                          (me.kind === 'human' && ['owner', 'admin'].includes(me.role))) && (
                          <Input
                            aria-label={`Select ${task.title}`}
                            type="checkbox"
                            checked={selected.some((t) => t.id === task.id)}
                            disabled={
                              moving ||
                              (!selected.some((t) => t.id === task.id) && selected.length >= 50)
                            }
                            onChange={() => toggle(task)}
                          />
                        )}
                        <span className={`priority ${task.priority}`} />
                        <div>
                          <h3>
                            <Button
                              variant="ghost"
                              className="task-title-button"
                              onClick={() => onSelect(task.id)}
                            >
                              {task.title}
                            </Button>
                          </h3>
                          <TaskBadges task={task} />
                          <p>{task.description || 'No additional details'}</p>
                          <small>
                            {task.assignee_name ?? 'Unassigned'} · {task.priority} priority
                            {task.parent_id ? ' · Subtask' : ''}
                            {task.subtask_count > 0
                              ? ` · ${task.closed_subtask_count}/${task.subtask_count} subtasks closed`
                              : ''}
                            {task.unresolved_dependency_count > 0
                              ? ` · Waiting on ${task.unresolved_dependency_count}`
                              : ''}
                          </small>
                          {task.due_date && (
                            <time
                              className={overdueTask(task) ? 'task-overdue' : 'task-due'}
                              dateTime={task.due_date}
                            >
                              {overdueTask(task) ? 'Overdue · ' : 'Due '}
                              {dueLabel(task.due_date)}
                            </time>
                          )}
                        </div>
                        <Badge variant="outline" className={`state ${task.state}`}>
                          {taskLabels[task.state]}
                        </Badge>
                        {taskMoves[task.state].length > 0 &&
                          (task.is_collaborator === true ||
                            task.created_by === me.id ||
                            task.assignee_id === me.id ||
                            ['owner', 'admin'].includes(me.role)) && (
                            <NativeSelect
                              aria-label={`Update ${task.title}`}
                              value=""
                              disabled={moving}
                              onChange={(e) => {
                                if (e.target.value === 'completed') {
                                  setCompletion(task);
                                  setEvidence('');
                                  setError('');
                                } else void move(task, e.target.value);
                              }}
                            >
                              <option value="">Move to…</option>
                              {taskMoves[task.state].map((state) => (
                                <option key={state} value={state}>
                                  {taskLabels[state]}
                                </option>
                              ))}
                            </NativeSelect>
                          )}
                      </article>
                    ))}
                  </div>
                </Card>
              )}
              {cursor && (
                <Button
                  variant="outline"
                  className="history-button"
                  disabled={busy}
                  onClick={() => void load(cursor)}
                >
                  Load more tasks
                </Button>
              )}
            </>
          )}
          {completion && (
            <Dialog
              title="Verify task completion"
              onClose={() => {
                if (!moving) setCompletion(null);
              }}
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void move(completion, 'completed', evidence);
                }}
              >
                <p>Describe the evidence that verifies “{completion.title}” is complete.</p>
                <label>
                  Verification evidence
                  <Textarea
                    aria-label="Verification evidence"
                    required
                    maxLength={2000}
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                  />
                </label>
                {error && (
                  <p role="alert" className="error">
                    {error}
                  </p>
                )}
                <Button className="primary" disabled={moving || !evidence.trim()}>
                  Complete task
                </Button>
              </form>
            </Dialog>
          )}
        </>
      )}
    </section>
  );
}
