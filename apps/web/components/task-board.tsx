'use client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Member, Task, TaskPage } from '@ao/contracts';
import { taskStates, taskLabels, taskMoves } from '@ao/contracts/tasks';
import { TaskBadges } from './task-organization';
import { api, HttpError } from '../lib/api';
import { taskFilterParams, type TaskFilters } from '../lib/task-filters';
import { dueLabel, overdueTask } from '../lib/task-display';
function manages(me: Member, task: Task) {
  return (
    task.is_collaborator === true ||
    me.id === task.created_by ||
    me.id === task.assignee_id ||
    (me.kind === 'human' && ['owner', 'admin'].includes(me.role))
  );
}
export function TaskBoard({
  filters,
  revision,
  me,
  onOpen,
  onMove,
  moving,
  selected,
  onToggle,
}: {
  filters: TaskFilters;
  revision: number;
  me: Member;
  onOpen: (id: string) => void;
  onMove: (task: Task, state: string) => void;
  moving: boolean;
  selected: Task[];
  onToggle: (task: Task) => void;
}) {
  const [dragged, setDragged] = useState<Task | null>(null),
    [target, setTarget] = useState<string | null>(null),
    [notice, setNotice] = useState('');
  useEffect(() => {
    setDragged(null);
    setTarget(null);
  }, [revision, filters]);
  function drop(state: Task['state']) {
    setTarget(null);
    setDragged(null);
    if (!dragged || moving || dragged.state === state) return;
    if (!taskMoves[dragged.state].includes(state)) {
      setNotice(
        `Cannot move ${dragged.title} from ${taskLabels[dragged.state]} to ${taskLabels[state]}. Use a permitted workflow state.`,
      );
      return;
    }
    setNotice('');
    onMove(dragged, state);
  }
  const states = filters.state ? taskStates.filter((state) => state === filters.state) : taskStates;
  return (
    <section className="task-board" aria-label="Task Kanban board">
      <p className="muted">
        Drag a card to a permitted state, or use its Move to control. Completion requires
        verification evidence. Cards are ordered by the selected sort; each column loads
        independently.
      </p>
      <div role="status" aria-live="polite">
        {notice && <p className="error">{notice}</p>}
      </div>
      <div className="kanban-columns">
        {states.map((state) => (
          <section
            key={state}
            data-state={state}
            className={`kanban-column${target === state ? ' drop-target' : ''}`}
            aria-label={`${taskLabels[state]} column`}
            onDragOver={(e) => {
              if (dragged && !moving) {
                e.preventDefault();
                e.dataTransfer.dropEffect = taskMoves[dragged.state].includes(state)
                  ? 'move'
                  : 'none';
                setTarget(state);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(state);
            }}
          >
            <BoardColumn
              state={state}
              filters={filters}
              revision={revision}
              me={me}
              onOpen={onOpen}
              onMove={onMove}
              moving={moving}
              selected={selected}
              onToggle={onToggle}
              onDrag={setDragged}
            />
          </section>
        ))}
      </div>
    </section>
  );
}
function BoardColumn({
  state,
  filters,
  revision,
  me,
  onOpen,
  onMove,
  moving,
  selected,
  onToggle,
  onDrag,
}: {
  state: Task['state'];
  filters: TaskFilters;
  revision: number;
  me: Member;
  onOpen: (id: string) => void;
  onMove: (task: Task, state: string) => void;
  moving: boolean;
  selected: Task[];
  onToggle: (task: Task) => void;
  onDrag: (task: Task | null) => void;
}) {
  const [items, setItems] = useState<Task[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (next: string | null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setError('');
      try {
        const params = taskFilterParams(filters);
        params.set('state', state);
        params.set('limit', '20');
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
          setError(e instanceof Error ? e.message : 'Unable to load column.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [state, filters],
  );
  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load(null);
    return () => controller.current?.abort();
  }, [load, revision]);
  return (
    <>
      <header className="kanban-column-heading">
        <h3>{taskLabels[state]}</h3>
        <span aria-label={`${items.length}${cursor ? ' or more' : ''} loaded tasks`}>
          {items.length}
          {cursor ? '+' : ''}
        </span>
      </header>
      {error && (
        <div>
          <p className="error" role="alert">
            {error}
          </p>
          <Button variant="outline" type="button" onClick={() => void load(null)}>
            Retry column
          </Button>
        </div>
      )}
      {items.map((task) => {
        const allowed = manages(me, task),
          checked = selected.some((t) => t.id === task.id);
        return (
          <article
            key={task.id}
            className={`kanban-card${checked ? ' selected' : ''}`}
            data-task-card-id={task.id}
            draggable={allowed && !moving && taskMoves[task.state].length > 0}
            onDragStart={(e) => {
              onDrag(task);
              e.dataTransfer.setData('text/plain', task.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => onDrag(null)}
          >
            <div className="kanban-card-title">
              {allowed && (
                <Input
                  aria-label={`Select ${task.title}`}
                  type="checkbox"
                  checked={checked}
                  disabled={moving || (!checked && selected.length >= 50)}
                  onChange={() => onToggle(task)}
                />
              )}
              <Button
                variant="ghost"
                type="button"
                className="task-title-button"
                onClick={() => onOpen(task.id)}
              >
                {task.title}
              </Button>
            </div>
            <TaskBadges task={task} />
            <p className="kanban-description">{task.description || 'No additional details'}</p>
            <small>
              {task.assignee_name ?? 'Unassigned'} · {task.priority} priority
              {task.parent_id ? ' · Subtask' : ''}
            </small>
            {task.due_date && (
              <time
                dateTime={task.due_date}
                className={overdueTask(task) ? 'task-overdue' : 'task-due'}
              >
                {overdueTask(task) ? 'Overdue · ' : 'Due '}
                {dueLabel(task.due_date)}
              </time>
            )}
            <small>
              {task.unresolved_dependency_count > 0
                ? `Waiting on ${task.unresolved_dependency_count} · `
                : ''}
              {task.subtask_count > 0
                ? `${task.closed_subtask_count}/${task.subtask_count} subtasks · `
                : ''}
              {task.attachment_count > 0
                ? `${task.attachment_count} file(s)`
                : `${task.comment_count} comment(s)`}
            </small>
            {allowed && taskMoves[task.state].length > 0 && (
              <NativeSelect
                aria-label={`Move ${task.title}`}
                value=""
                disabled={moving}
                onChange={(e) => onMove(task, e.target.value)}
              >
                <option value="">Move to…</option>
                {taskMoves[task.state].map((next) => (
                  <option value={next} key={next}>
                    {taskLabels[next]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </article>
        );
      })}
      {busy && (
        <p role="status" className="muted">
          Loading {taskLabels[state].toLowerCase()}…
        </p>
      )}
      {!busy && !error && !items.length && <p className="kanban-empty">No tasks in this state.</p>}
      {cursor && (
        <Button
          variant="outline"
          type="button"
          className="kanban-load"
          disabled={busy}
          onClick={() => void load(cursor)}
        >
          Load more {taskLabels[state].toLowerCase()}
        </Button>
      )}
    </>
  );
}
