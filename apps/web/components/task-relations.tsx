'use client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Member, Task, TaskRelations } from '@ao/contracts';
import { taskLabels } from '@ao/contracts/tasks';
import { api, post } from '../lib/api';
import { TaskPicker } from './task-picker';
export function TaskRelationsPanel({
  task,
  members,
  canManage,
  revision,
  onOpen,
  onChanged,
}: {
  task: Task;
  members: Member[];
  canManage: boolean;
  revision: number;
  onOpen: (id: string) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [addingChild, setAddingChild] = useState(false),
    [addingDependency, setAddingDependency] = useState(false),
    [title, setTitle] = useState(''),
    [assignee, setAssignee] = useState(''),
    [due, setDue] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef({ signature: '', id: crypto.randomUUID() }),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function subtask(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const input = {
      title,
      description: '',
      parentId: task.id,
      ...(assignee ? { assigneeId: assignee } : {}),
      ...(due ? { dueDate: due } : {}),
    };
    const signature = JSON.stringify(input);
    if (signature !== request.current.signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      await post('/tasks', { ...input, clientId: request.current.id });
      if (alive.current) {
        setTitle('');
        setDue('');
        setAssignee('');
        setAddingChild(false);
        request.current = { signature: '', id: crypto.randomUUID() };
        await onChanged();
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Unable to create subtask.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function dependency(target: Task, remove = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${task.id}/dependencies${remove ? `/${target.id}` : ''}`, {
        method: remove ? 'DELETE' : 'PUT',
        body: JSON.stringify(
          remove ? { version: task.version } : { version: task.version, dependsOnId: target.id },
        ),
      });
      if (alive.current) {
        setAddingDependency(false);
        await onChanged();
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to change dependency.');
        await onChanged();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="task-relations-grid">
      {error && (
        <p className="error wide-field" role="alert">
          {error}
        </p>
      )}
      <section className="task-section">
        <div className="task-section-heading">
          <h3>
            Subtasks{' '}
            <small>
              {task.closed_subtask_count}/{task.subtask_count} closed
            </small>
          </h3>
          {canManage && (
            <Button
              variant="link"
              type="button"
              className="text-button"
              onClick={() => setAddingChild((v) => !v)}
            >
              Add subtask
            </Button>
          )}
        </div>
        {addingChild && (
          <form className="task-inline-form" onSubmit={subtask}>
            <label>
              Subtask title
              <Input
                aria-label="Subtask title"
                required
                minLength={3}
                maxLength={200}
                value={title}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Subtask assignee
              <NativeSelect
                aria-label="Subtask assignee"
                value={assignee}
                disabled={busy}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Subtask due date
              <Input
                aria-label="Subtask due date"
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                value={due}
                disabled={busy}
                onChange={(e) => setDue(e.target.value)}
              />
            </label>
            <p className="muted">Inherits the parent’s audience.</p>
            <Button size="sm" className="primary small" disabled={busy}>
              Create subtask
            </Button>
          </form>
        )}
        <RelationList taskId={task.id} kind="subtasks" revision={revision} onOpen={onOpen} />
      </section>
      <section className="task-section">
        <div className="task-section-heading">
          <h3>Depends on</h3>
          {canManage && (
            <Button
              variant="link"
              type="button"
              className="text-button"
              onClick={() => setAddingDependency((v) => !v)}
            >
              Add dependency
            </Button>
          )}
        </div>
        <p className="muted">
          Every prerequisite must complete before this task starts. Cancelled prerequisites still
          block it.
        </p>
        {addingDependency && (
          <TaskPicker
            label="Find a prerequisite"
            conversationId={task.conversation_id}
            exclude={task.id}
            onPick={(target) => void dependency(target)}
          />
        )}
        <RelationList
          taskId={task.id}
          kind="dependencies"
          revision={revision}
          onOpen={onOpen}
          onRemove={canManage ? (target) => void dependency(target, true) : undefined}
          disabled={busy}
        />
      </section>
      <section className="task-section">
        <h3>Blocks</h3>
        <RelationList taskId={task.id} kind="dependents" revision={revision} onOpen={onOpen} />
      </section>
    </div>
  );
}
function RelationList({
  taskId,
  kind,
  revision,
  onOpen,
  onRemove,
  disabled = false,
}: {
  taskId: string;
  kind: 'subtasks' | 'dependencies' | 'dependents';
  revision: number;
  onOpen: (id: string) => void;
  onRemove?: ((task: Task) => void) | undefined;
  disabled?: boolean;
}) {
  const [items, setItems] = useState<Task[]>([]),
    [after, setAfter] = useState<string | null>(null),
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
        const params = new URLSearchParams({ kind, limit: '30', ...(next ? { after: next } : {}) });
        const page = await api<TaskRelations>(`/tasks/${taskId}/relations?${params}`, {
          signal: request.signal,
        });
        if (!request.signal.aborted) {
          setItems((old) =>
            next
              ? [...new Map([...old, ...page.items].map((t) => [t.id, t])).values()]
              : page.items,
          );
          setAfter(page.next_after);
        }
      } catch (e) {
        if (!request.signal.aborted) {
          setItems([]);
          setAfter(null);
          setError(e instanceof Error ? e.message : 'Unable to load related tasks.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [taskId, kind],
  );
  useEffect(() => {
    void load(null);
    return () => controller.current?.abort();
  }, [load, revision]);
  return (
    <div className="task-related-list">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!busy && !error && items.length === 0 && <p className="muted">None yet.</p>}
      {items.map((task) => (
        <article key={task.id}>
          <Button variant="outline" type="button" onClick={() => onOpen(task.id)}>
            <strong>{task.title}</strong>
            <small>
              {taskLabels[task.state]} · {task.assignee_name ?? 'Unassigned'}
            </small>
          </Button>
          {onRemove && (
            <Button
              variant="outline"
              type="button"
              disabled={disabled}
              aria-label={`Remove dependency ${task.title}`}
              onClick={() => onRemove(task)}
            >
              Remove
            </Button>
          )}
        </article>
      ))}
      {after && (
        <Button variant="outline" type="button" disabled={busy} onClick={() => void load(after)}>
          Load more {kind}
        </Button>
      )}
    </div>
  );
}
