'use client';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Badge } from './ui/badge';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Project,
  ProjectPage,
  Milestone,
  MilestonePage,
  TaskLabelRef,
  LabelPage,
} from '@ao/contracts';
import { api } from '../lib/api';
export function ProjectPicker({
  source,
  onPick,
  disabled = false,
  allowClosed = false,
}: {
  source?: string | null;
  onPick: (project: Project) => void;
  disabled?: boolean;
  allowClosed?: boolean;
}) {
  const [q, setQ] = useState(''),
    [query, setQuery] = useState(''),
    [items, setItems] = useState<Project[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 200);
    return () => clearTimeout(timer);
  }, [q]);
  const load = useCallback(
    async (next: string | null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setError('');
      try {
        const params = new URLSearchParams({ q: query, limit: '20' });
        if (source === null) params.set('workspaceOnly', 'true');
        else if (source) params.set('conversationId', source);
        if (next) params.set('after', next);
        const page = await api<ProjectPage>(`/projects?${params}`, { signal: request.signal });
        if (!request.signal.aborted) {
          setItems((old) =>
            next
              ? [...new Map([...old, ...page.items].map((p) => [p.id, p])).values()]
              : page.items,
          );
          setAfter(page.next_after);
        }
      } catch (e) {
        if (!request.signal.aborted) {
          setItems([]);
          setAfter(null);
          setError(e instanceof Error ? e.message : 'Unable to load projects.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [query, source],
  );
  useEffect(() => {
    setItems([]);
    setAfter(null);
    void load(null);
    return () => controller.current?.abort();
  }, [load]);
  return (
    <div className="organization-picker">
      <label>
        Find a project
        <Input
          aria-label="Find a project"
          value={q}
          maxLength={200}
          disabled={disabled}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul>
        {items.map((p) => (
          <li key={p.id}>
            <Button
              variant="outline"
              type="button"
              disabled={disabled || (!allowClosed && ['completed', 'archived'].includes(p.status))}
              onClick={() => onPick(p)}
            >
              {p.name}
              <small>
                {p.status} · {p.task_count} task(s)
              </small>
            </Button>
          </li>
        ))}
      </ul>
      {busy ? (
        <p role="status">Loading projects…</p>
      ) : (
        !items.length && <p className="muted">No matching projects.</p>
      )}
      {after && (
        <Button
          variant="outline"
          type="button"
          disabled={busy || disabled}
          onClick={() => void load(after)}
        >
          Load more projects
        </Button>
      )}
    </div>
  );
}
export function MilestoneSelect({
  projectId,
  value,
  title,
  onChange,
  disabled = false,
  allowClosed = false,
}: {
  projectId: string;
  value: string;
  title: string;
  onChange: (milestone: Milestone | null) => void;
  disabled?: boolean;
  allowClosed?: boolean;
}) {
  const [items, setItems] = useState<Milestone[]>([]),
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
        const page = await api<MilestonePage>(
          `/projects/${projectId}/milestones?limit=30${next ? `&after=${next}` : ''}`,
          { signal: request.signal },
        );
        if (!request.signal.aborted) {
          setItems((old) =>
            next
              ? [...new Map([...old, ...page.items].map((m) => [m.id, m])).values()]
              : page.items,
          );
          setAfter(page.next_after);
        }
      } catch (e) {
        if (!request.signal.aborted) {
          setItems([]);
          setAfter(null);
          setError(e instanceof Error ? e.message : 'Unable to load milestones.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [projectId],
  );
  useEffect(() => {
    setItems([]);
    void load(null);
    return () => controller.current?.abort();
  }, [load]);
  return (
    <div>
      <label>
        Milestone
        <NativeSelect
          aria-label="Task milestone"
          value={value}
          disabled={disabled || busy}
          onChange={(e) => onChange(items.find((m) => m.id === e.target.value) ?? null)}
        >
          <option value="">No milestone</option>
          {value && !items.some((m) => m.id === value) && (
            <option value={value}>{title || 'Current milestone'}</option>
          )}
          {items.map((m) => (
            <option
              value={m.id}
              key={m.id}
              disabled={
                !allowClosed && m.id !== value && ['completed', 'cancelled'].includes(m.status)
              }
            >
              {m.title} · {m.status}
            </option>
          ))}
        </NativeSelect>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {after && (
        <Button
          variant="outline"
          type="button"
          disabled={busy || disabled}
          onClick={() => void load(after)}
        >
          Load more milestones
        </Button>
      )}
    </div>
  );
}
export function LabelPicker({
  selected,
  onChange,
  disabled = false,
  single = false,
}: {
  selected: TaskLabelRef[];
  onChange: (labels: TaskLabelRef[]) => void;
  disabled?: boolean;
  single?: boolean;
}) {
  const [q, setQ] = useState(''),
    [query, setQuery] = useState(''),
    [items, setItems] = useState<TaskLabelRef[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 200);
    return () => clearTimeout(timer);
  }, [q]);
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
          limit: '30',
          archived: single ? 'all' : 'false',
        });
        if (next) params.set('after', next);
        const page = await api<LabelPage>(`/labels?${params}`, { signal: request.signal });
        if (!request.signal.aborted) {
          setItems((old) =>
            next
              ? [...new Map([...old, ...page.items].map((l) => [l.id, l])).values()]
              : page.items,
          );
          setAfter(page.next_after);
        }
      } catch (e) {
        if (!request.signal.aborted) {
          setItems([]);
          setAfter(null);
          setError(e instanceof Error ? e.message : 'Unable to load labels.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [query, single],
  );
  useEffect(() => {
    setItems([]);
    void load(null);
    return () => controller.current?.abort();
  }, [load]);
  return (
    <div className="organization-picker">
      <label>
        Find labels
        <Input
          aria-label="Find labels"
          value={q}
          disabled={disabled}
          maxLength={50}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      <p className="muted">Label names are visible throughout the workspace.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="label-picker-list">
        {items.map((label) => {
          const checked = selected.some((l) => l.id === label.id);
          return (
            <li key={label.id}>
              {single ? (
                <Button
                  variant="outline"
                  type="button"
                  aria-label={`Filter label ${label.name}`}
                  aria-pressed={checked}
                  disabled={disabled}
                  onClick={() => onChange(checked ? [] : [label])}
                >
                  <Badge variant="outline" className={`work-label label-${label.color}`}>
                    {label.name}
                    {label.archived ? ' · Archived' : ''}
                  </Badge>
                </Button>
              ) : (
                <label>
                  <Input
                    aria-label={`Label ${label.name}`}
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || (!checked && !single && selected.length >= 20)}
                    onChange={() =>
                      onChange(
                        checked
                          ? selected.filter((l) => l.id !== label.id)
                          : single
                            ? [label]
                            : [...selected, label],
                      )
                    }
                  />
                  <Badge variant="outline" className={`work-label label-${label.color}`}>
                    {label.name}
                    {label.archived ? ' · Archived' : ''}
                  </Badge>
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {busy && <p role="status">Loading labels…</p>}
      {!busy && !items.length && (
        <p className="muted">No matching labels. Create labels in Tasks → Labels.</p>
      )}
      {after && (
        <Button
          variant="outline"
          type="button"
          disabled={busy || disabled}
          onClick={() => void load(after)}
        >
          Load more labels
        </Button>
      )}
    </div>
  );
}
