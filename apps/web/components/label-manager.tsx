'use client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Badge } from './ui/badge';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LabelPage, WorkLabel, Member } from '@ao/contracts';
import { labelColors } from '@ao/contracts/projects';
import { api, post, HttpError } from '../lib/api';
import { useRequestIdentity } from '../lib/use-request-identity';
import { Dialog } from './dialog';
export function LabelManager({
  revision,
  me,
  onChanged,
}: {
  revision: number;
  me: Member;
  onChanged: () => Promise<unknown>;
}) {
  const [items, setItems] = useState<WorkLabel[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [q, setQ] = useState(''),
    [query, setQuery] = useState(''),
    [archived, setArchived] = useState('false'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [editing, setEditing] = useState<WorkLabel | 'new' | null>(null);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (next: string | null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setError('');
      try {
        const params = new URLSearchParams({ q: query, archived, limit: '30' });
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
    [query, archived],
  );
  useEffect(() => {
    setItems([]);
    setAfter(null);
    void load(null);
    return () => controller.current?.abort();
  }, [load, revision]);
  return (
    <section className="label-manager" aria-label="Workspace labels">
      <div className="task-section-heading">
        <h3>Task labels</h3>
        <Button size="sm" type="button" className="primary small" onClick={() => setEditing('new')}>
          New label
        </Button>
      </div>
      <p className="muted">
        Label names are visible throughout the workspace. Archiving retains existing task labels and
        prevents new assignments.
      </p>
      <form
        className="project-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <label>
          Find labels
          <Input
            aria-label="Manage labels search"
            maxLength={50}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label>
          Visibility
          <NativeSelect
            aria-label="Label archive filter"
            value={archived}
            onChange={(e) => setArchived(e.target.value)}
          >
            <option value="false">Active labels</option>
            <option value="true">Archived labels</option>
            <option value="all">All labels</option>
          </NativeSelect>
        </label>
        <Button variant="outline" type="submit">
          Search labels
        </Button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {items.map((l) => (
        <article className="label-catalog-row" key={l.id}>
          <Badge variant="outline" className={`work-label label-${l.color}`}>
            {l.name}
          </Badge>
          <small>
            {l.archived ? 'Archived' : 'Active'} · v{l.version}
          </small>
          {(l.created_by === me.id || ['owner', 'admin'].includes(me.role)) && (
            <Button
              variant="outline"
              type="button"
              aria-label={`Edit label ${l.name}`}
              onClick={() => setEditing(l)}
            >
              Edit label
            </Button>
          )}
        </article>
      ))}
      {busy && <p role="status">Loading labels…</p>}
      {!busy && !items.length && !error && <p className="muted">No labels match this view.</p>}
      {after && (
        <Button variant="outline" type="button" disabled={busy} onClick={() => void load(after)}>
          Load more labels
        </Button>
      )}
      {editing && (
        <LabelEditor
          key={editing === 'new' ? 'new' : editing.id}
          label={editing === 'new' ? null : editing}
          latest={editing === 'new' ? null : (items.find((l) => l.id === editing.id) ?? null)}
          onRefresh={onChanged}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      )}
    </section>
  );
}
function LabelEditor({
  label,
  latest,
  onClose,
  onSaved,
  onRefresh,
}: {
  label: WorkLabel | null;
  latest: WorkLabel | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onRefresh: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(() => ({
      name: label?.name ?? '',
      color: label?.color ?? 'sage',
      archived: label?.archived ?? false,
      version: label?.version ?? 0,
    })),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  const requestId = useRequestIdentity();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (label)
        await api(`/labels/${label.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            version: draft.version,
            name: draft.name,
            color: draft.color,
            archived: draft.archived,
          }),
        });
      else
        await post('/labels', {
          clientId: requestId({ name: draft.name, color: draft.color }),
          name: draft.name,
          color: draft.color,
        });
      if (alive.current) await onSaved();
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to save label.');
        if (e instanceof HttpError && e.code === 'VERSION_CONFLICT') await onRefresh();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const stale = Boolean(label && latest && latest.version !== draft.version);
  return (
    <Dialog
      title={label ? 'Edit label' : 'New label'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="organization-form" onSubmit={(e) => void save(e)}>
        {stale && (
          <p role="status">This label changed. Cancel and reopen to review its latest version.</p>
        )}
        <label>
          Name
          <Input
            aria-label="Label name"
            required
            maxLength={50}
            value={draft.name}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          Color
          <NativeSelect
            aria-label="Label color"
            value={draft.color}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, color: e.target.value as WorkLabel['color'] })}
          >
            {labelColors.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </NativeSelect>
        </label>
        <Badge variant="outline" className={`work-label label-${draft.color}`}>
          {draft.name || 'Preview'}
        </Badge>
        {label && (
          <label className="checkbox-label">
            <Input
              type="checkbox"
              aria-label="Archive label"
              checked={draft.archived}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, archived: e.target.checked })}
            />
            Archive label
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button size="sm" className="primary small" disabled={busy || stale}>
          {label ? 'Save label' : 'Create label'}
        </Button>
      </form>
    </Dialog>
  );
}
