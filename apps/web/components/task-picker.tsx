'use client';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task, TaskPage } from '@ao/contracts';
import { taskLabels } from '@ao/contracts/tasks';
import { api } from '../lib/api';
export function TaskPicker({
  label,
  conversationId,
  exclude,
  onPick,
}: {
  label: string;
  conversationId: string | null;
  exclude: string;
  onPick: (task: Task) => void;
}) {
  const [query, setQuery] = useState(''),
    [items, setItems] = useState<Task[]>([]),
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
        const params = new URLSearchParams({
          q: query,
          limit: '20',
          ...(conversationId ? { conversationId } : { workspaceOnly: 'true' }),
          ...(next ? { cursor: next } : {}),
        });
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
        if (!request.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to find tasks.');
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [query, conversationId],
  );
  useEffect(() => {
    setItems([]);
    setCursor(null);
    const timer = setTimeout(() => void load(null), 200);
    return () => {
      clearTimeout(timer);
      controller.current?.abort();
    };
  }, [load]);
  return (
    <fieldset className="task-picker">
      <legend>{label}</legend>
      <Input
        aria-label={label}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tasks in the same audience"
        maxLength={200}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="task-picker-results">
        {items
          .filter((t) => t.id !== exclude)
          .map((task) => (
            <Button variant="outline" type="button" key={task.id} onClick={() => onPick(task)}>
              <strong>{task.title}</strong>
              <small>
                {taskLabels[task.state]} · {task.assignee_name ?? 'Unassigned'}
              </small>
            </Button>
          ))}
      </div>
      {cursor && (
        <Button variant="outline" type="button" disabled={busy} onClick={() => void load(cursor)}>
          Find more tasks
        </Button>
      )}
      {!busy && !items.some((t) => t.id !== exclude) && (
        <p className="muted">No matching tasks in this audience.</p>
      )}
    </fieldset>
  );
}
