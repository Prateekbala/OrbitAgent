'use client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskAttachment, TaskAttachmentPage } from '@ao/contracts';
import { api, post, HttpError } from '../lib/api';
import { useAttachments } from '../lib/use-attachments';
import { Attachments } from './attachments';
export function TaskAttachmentsPanel({
  id,
  canManage,
  revision,
  onChanged,
}: {
  id: string;
  canManage: boolean;
  revision: number;
  onChanged: () => Promise<unknown>;
}) {
  const [items, setItems] = useState<TaskAttachment[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [removing, setRemoving] = useState<TaskAttachment | null>(null),
    [busy, setBusy] = useState(false);
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
    async (cursor: string | null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setLoading(true);
      setError('');
      try {
        const page = await api<TaskAttachmentPage>(
          `/tasks/${id}/attachments?limit=30${cursor ? `&after=${cursor}` : ''}`,
          { signal: request.signal },
        );
        if (!request.signal.aborted) {
          setItems((old) =>
            cursor
              ? [...new Map([...old, ...page.items].map((f) => [f.id, f])).values()]
              : page.items,
          );
          setAfter(page.next_after);
        }
      } catch (e) {
        if (!request.signal.aborted) {
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            setItems([]);
            setAfter(null);
            setRemoving(null);
          }
          setError(e instanceof Error ? e.message : 'Unable to load attachments.');
        }
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    },
    [id],
  );
  useEffect(() => {
    setItems([]);
    setAfter(null);
  }, [id]);
  useEffect(() => {
    void load(null);
    return () => controller.current?.abort();
  }, [load, revision]);
  async function remove() {
    if (!removing || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${id}/attachments/${removing.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ version: removing.version }),
      });
      if (alive.current) {
        setRemoving(null);
        await onChanged();
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to remove attachment.');
        await onChanged();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="task-section task-attachments">
      <div className="task-section-heading">
        <h3>Task attachments</h3>
        <span className="muted">Private storage · Up to 25 MB per file</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Loading task attachments…</p>}
      {!loading && !items.length && !error && <p className="muted">No files attached yet.</p>}
      {items.map((file) => (
        <article className="task-attachment" key={file.id} data-task-file-id={file.id}>
          <Attachments files={[file]} />
          <div className="task-attachment-meta">
            <small>
              Added by {file.attached_by_name} · {new Date(file.attached_at).toLocaleString()}
            </small>
            {canManage &&
              (removing?.id === file.id ? (
                <span>
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    Confirm remove attachment
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => setRemoving(null)}
                  >
                    Keep attachment
                  </Button>
                </span>
              ) : (
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  aria-label={`Remove attachment ${file.name}`}
                  onClick={() => setRemoving(file)}
                >
                  Remove
                </Button>
              ))}
          </div>
        </article>
      ))}
      {after && (
        <Button variant="outline" type="button" disabled={loading} onClick={() => void load(after)}>
          Load more task attachments
        </Button>
      )}
      {canManage && <TaskFileComposer key={id} id={id} onChanged={onChanged} />}
    </section>
  );
}
function TaskFileComposer({ id, onChanged }: { id: string; onChanged: () => Promise<unknown> }) {
  const uploads = useAttachments(id, 'task'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function attach() {
    if (busy || !uploads.items.length || uploads.items.some((f) => f.status !== 'ready')) return;
    setBusy(true);
    setError('');
    try {
      await post(`/tasks/${id}/attachments`, { fileIds: uploads.items.map((f) => f.remote!.id) });
      if (alive.current) {
        uploads.clear();
        await onChanged();
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Unable to attach files.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="task-file-composer">
      <label>
        Choose task files
        <Input
          aria-label="Choose task files"
          type="file"
          multiple
          disabled={busy || uploads.items.length >= 10}
          onChange={(e) => {
            uploads.add(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      <ul className="upload-list" aria-label="Task upload queue">
        {uploads.items.map((item) => (
          <li key={item.key}>
            <div>
              <strong>{item.file.name}</strong>
              <small>
                {item.status === 'ready'
                  ? 'Ready to attach'
                  : item.status === 'failed'
                    ? item.error
                    : item.progress === 100
                      ? 'Checking and saving…'
                      : `Uploading ${item.progress}%`}
              </small>
              {item.status === 'uploading' && (
                <progress aria-label={`Upload ${item.file.name}`} max={100} value={item.progress} />
              )}
            </div>
            {item.status === 'failed' && (
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => uploads.retry(item)}
              >
                Retry task upload
              </Button>
            )}
            <Button
              variant="outline"
              type="button"
              aria-label={`Discard upload ${item.file.name}`}
              disabled={busy}
              onClick={() => uploads.remove(item.key)}
            >
              Discard
            </Button>
          </li>
        ))}
      </ul>
      {(error || uploads.error) && (
        <p className="error" role="alert">
          {error || uploads.error} Your upload draft has been kept.
        </p>
      )}
      {uploads.items.length > 0 && (
        <Button
          size="sm"
          type="button"
          className="primary small"
          disabled={busy || uploads.items.some((f) => f.status !== 'ready')}
          onClick={() => void attach()}
        >
          Attach files to task
        </Button>
      )}
    </div>
  );
}
