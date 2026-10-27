'use client';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Member, TaskComment, TaskComments } from '@ao/contracts';
import { api, post } from '../lib/api';
export function TaskCommentsPanel({
  id,
  revision,
  me,
  onChanged,
}: {
  id: string;
  revision: number;
  me: Member;
  onChanged: () => Promise<unknown>;
}) {
  const [items, setItems] = useState<TaskComment[]>([]),
    [before, setBefore] = useState<number | null>(null),
    [body, setBody] = useState(''),
    [busy, setBusy] = useState(false),
    [sending, setSending] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null),
    oldest = useRef<number | null>(null),
    client = useRef(crypto.randomUUID()),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    oldest.current = items[0]?.sequence ?? null;
  }, [items]);
  const load = useCallback(
    async (next: number | null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setError('');
      const get = (position: number | null) =>
        api<TaskComments>(
          `/tasks/${id}/comments?limit=30${position ? `&before=${position}` : ''}`,
          { signal: request.signal },
        );
      try {
        let page = await get(next);
        let rows = page.items;
        if (!next)
          while (
            !request.signal.aborted &&
            oldest.current !== null &&
            page.next_before !== null &&
            rows.at(-1)!.sequence > oldest.current
          ) {
            page = await get(page.next_before);
            rows = [...rows, ...page.items];
          }
        if (!request.signal.aborted) {
          const ascending = rows.reverse();
          setItems((old) => {
            const merged = next
              ? [...new Map([...ascending, ...old].map((c) => [c.id, c])).values()].sort(
                  (a, b) => a.sequence - b.sequence,
                )
              : ascending;
            return merged;
          });
          setBefore(page.next_before);
        }
      } catch (e) {
        if (!request.signal.aborted) {
          setItems([]);
          setBefore(null);
          setError(e instanceof Error ? e.message : 'Unable to load comments.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [id],
  );
  useEffect(() => {
    void load(null);
    return () => controller.current?.abort();
  }, [load, revision]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (sending || !body.trim()) return;
    setSending(true);
    setError('');
    try {
      await post(`/tasks/${id}/comments`, { body, clientId: client.current });
      if (alive.current) {
        setBody('');
        client.current = crypto.randomUUID();
        await onChanged();
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Unable to post comment.');
    } finally {
      if (alive.current) setSending(false);
    }
  }
  return (
    <section className="task-section task-comments">
      <h3>Discussion</h3>
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <Button variant="outline" onClick={() => void load(null)}>
            Retry comments
          </Button>
        </p>
      )}
      {before && (
        <Button
          variant="outline"
          className="history-button"
          disabled={busy}
          onClick={() => void load(before)}
        >
          Load older task comments
        </Button>
      )}
      {items.map((comment) => (
        <CommentRow key={comment.id} comment={comment} me={me} onChanged={onChanged} />
      ))}
      {!busy && !error && items.length === 0 && (
        <p className="muted">Add context, ask a question, or record an update.</p>
      )}
      <form className="task-comment-composer" onSubmit={send}>
        <label>
          Add a comment
          <Textarea
            aria-label="Add a task comment"
            rows={3}
            maxLength={12000}
            required
            disabled={sending}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              client.current = crypto.randomUUID();
            }}
          />
        </label>
        <Button size="sm" className="primary small" disabled={sending || !body.trim()}>
          {sending ? 'Posting…' : 'Post comment'}
        </Button>
      </form>
    </section>
  );
}
function CommentRow({
  comment,
  me,
  onChanged,
}: {
  comment: TaskComment;
  me: Member;
  onChanged: () => Promise<unknown>;
}) {
  const [edit, setEdit] = useState<{ body: string; version: number } | null>(null),
    [deleting, setDeleting] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (comment.deleted_at) {
      setEdit(null);
      setDeleting(null);
    }
  }, [comment.deleted_at]);
  async function save(remove = false) {
    if (busy || (!remove && !edit)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${comment.task_id}/comments/${comment.id}`, {
        method: remove ? 'DELETE' : 'PATCH',
        body: JSON.stringify(
          remove ? { version: deleting } : { version: edit!.version, body: edit!.body },
        ),
      });
      if (alive.current) {
        setEdit(null);
        setDeleting(null);
        await onChanged();
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to change comment.');
        await onChanged();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <article className="task-comment" data-task-comment-id={comment.id}>
      <div className="task-comment-meta">
        <strong>{comment.author_name}</strong>
        {comment.author_kind === 'agent' && (
          <Badge variant="outline" className="agent-label">
            AGENT
          </Badge>
        )}
        <time dateTime={comment.created_at}>{new Date(comment.created_at).toLocaleString()}</time>
        {comment.edited_at && !comment.deleted_at && <small>edited</small>}
      </div>
      {comment.deleted_at ? (
        <p className="muted">Comment deleted</p>
      ) : edit ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {edit.version !== comment.version && (
            <div className="conflict-panel">
              <p>The comment changed: {comment.body}</p>
              <Button
                variant="outline"
                type="button"
                onClick={() => setEdit({ ...edit, version: comment.version })}
              >
                I reviewed the latest comment; keep my edit
              </Button>
            </div>
          )}
          <label>
            Edit comment
            <Textarea
              aria-label="Edit task comment"
              required
              maxLength={12000}
              rows={3}
              disabled={busy}
              value={edit.body}
              onChange={(e) => setEdit({ ...edit, body: e.target.value })}
            />
          </label>
          <div className="document-actions">
            <Button
              size="sm"
              className="primary small"
              disabled={busy || edit.version !== comment.version}
            >
              Save comment
            </Button>
            <Button variant="outline" type="button" disabled={busy} onClick={() => setEdit(null)}>
              Cancel editing
            </Button>
          </div>
        </form>
      ) : (
        <p className="task-comment-body">{comment.body}</p>
      )}
      {!comment.deleted_at && !edit && (
        <div className="task-comment-actions">
          {comment.author_id === me.id && (
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => {
                setEdit({ body: comment.body, version: comment.version });
                setError('');
              }}
            >
              Edit comment
            </Button>
          )}
          {(comment.author_id === me.id || ['owner', 'admin'].includes(me.role)) && (
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => {
                setDeleting(comment.version);
                setError('');
              }}
            >
              Delete comment
            </Button>
          )}
        </div>
      )}
      {deleting !== null && !comment.deleted_at && (
        <div className="task-comment-confirmation">
          <p>
            {deleting === comment.version
              ? 'Delete this comment? Its text will be removed.'
              : 'This comment changed. Review it and open deletion again.'}
          </p>
          <Button
            variant="outline"
            type="button"
            disabled={busy || deleting !== comment.version}
            onClick={() => void save(true)}
          >
            Confirm delete comment
          </Button>
          <Button variant="outline" type="button" disabled={busy} onClick={() => setDeleting(null)}>
            Keep comment
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </article>
  );
}
