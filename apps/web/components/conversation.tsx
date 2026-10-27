'use client';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Pencil, Trash2, SmilePlus, Bookmark, Bell, Pin, Link2 } from 'lucide-react';
import type { Message, Member } from '@ao/contracts';
import { reactionEmojis } from '@ao/contracts/messaging';
import { Attachments } from './attachments';
import { Avatar } from './primitives';
import { Dialog } from './dialog';
import { api } from '../lib/api';
import { RichMessage } from './rich-message';
export function MessageRow({
  message,
  onThread,
  me,
  onChanged,
  onRead,
  workspaceId,
}: {
  message: Message;
  onThread?: () => void;
  me: Member;
  onChanged: () => Promise<unknown>;
  onRead?: (message: Message) => void;
  workspaceId?: string;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(''),
    [editVersion, setEditVersion] = useState(0),
    [deleting, setDeleting] = useState(false),
    [deleteVersion, setDeleteVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const end = useRef<HTMLSpanElement>(null);
  const isAuthor = message.author_id === me.id;
  useEffect(() => {
    const node = end.current;
    if (!node || !onRead || message.deleted_at) return;
    let visible = false;
    const report = () => {
      if (visible && document.visibilityState === 'visible' && document.hasFocus()) onRead(message);
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      report();
    });
    observer.observe(node);
    window.addEventListener('focus', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('focus', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, [message, onRead]);
  async function mutate(method: string, suffix: string, body: unknown) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/messages/${message.id}${suffix}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      setEditing(false);
      setDeleting(false);
      await onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update message.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="message" data-message-id={message.id}>
      <Avatar name={message.author_name} agent={message.author_kind === 'agent'} />
      <div className="message-content">
        <div className="message-meta">
          <strong>{message.author_name}</strong>
          {message.source_attribution && (
            <Badge variant="outline" className="agent-label">
              Imported · {message.source_attribution.provider}
            </Badge>
          )}
          {message.external_organization && (
            <Badge variant="outline" className="agent-label">
              External · {message.external_organization.organizationName}
            </Badge>
          )}
          {message.author_kind === 'agent' && (
            <Badge variant="outline" className="agent-label">
              AGENT
            </Badge>
          )}
          <time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()}>
            {new Date(message.created_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          {message.edited_at && !message.deleted_at && <span className="edited-label">edited</span>}
        </div>
        {!message.deleted_at && message.source_attribution?.reactions.length ? (
          <p className="imported-reactions">
            Source reactions:{' '}
            {message.source_attribution.reactions.map((r) => `${r.emoji} ${r.count}`).join(' · ')}
          </p>
        ) : null}
        {message.deleted_at ? (
          <p className="deleted-message">Message deleted</p>
        ) : editing ? (
          <form
            className="message-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate('PATCH', '', {
                body: draft,
                format: message.format ?? 'plain',
                version: editVersion,
              });
            }}
          >
            <Textarea
              aria-label="Edit message text"
              autoFocus
              maxLength={12000}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setEditing(false);
              }}
            />
            {message.version !== editVersion && (
              <p role="alert" className="error">
                This message changed while you were editing. Cancel and reopen it to use the latest
                version.
              </p>
            )}
            <div className="message-actions">
              <Button
                size="sm"
                className="primary small"
                disabled={
                  busy ||
                  (!draft.trim() && !message.attachments?.length) ||
                  message.version !== editVersion
                }
              >
                Save changes
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel edit
              </Button>
            </div>
          </form>
        ) : (
          <RichMessage body={message.body} format={message.format} mentions={message.mentions} />
        )}
        {!message.deleted_at && <Attachments files={message.attachments ?? []} />}
        {!message.deleted_at && !editing && (
          <div className="message-actions message-toolbar" aria-label="Message actions">
            {me.kind === 'human' && (
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-pressed={message.saved ?? false}
                  title={message.saved ? 'Unsave' : 'Save message'}
                  onClick={() => void mutate(message.saved ? 'DELETE' : 'PUT', '/saved', undefined)}
                >
                  <Bookmark size={15} />
                  <span className="sr-only">{message.saved ? 'Unsave' : 'Save message'}</span>
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-pressed={message.following ?? false}
                  title={message.following ? 'Unfollow thread' : 'Follow thread'}
                  onClick={() =>
                    void mutate(message.following ? 'DELETE' : 'PUT', '/follow', undefined)
                  }
                >
                  <Bell size={15} />
                  <span className="sr-only">
                    {message.following ? 'Unfollow thread' : 'Follow thread'}
                  </span>
                </Button>
                {me.access_type !== 'guest' && me.permissions?.['messages.write'] !== false && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    aria-pressed={message.pinned ?? false}
                    title={message.pinned ? 'Unpin' : 'Pin message'}
                    onClick={() =>
                      void mutate(message.pinned ? 'DELETE' : 'PUT', '/pin', undefined)
                    }
                  >
                    <Pin size={15} />
                    <span className="sr-only">{message.pinned ? 'Unpin' : 'Pin message'}</span>
                  </Button>
                )}
              </>
            )}
            <Button
              variant="ghost"
              title="Copy message link"
              onClick={() => {
                const link = new URL('/app', window.location.origin);
                link.searchParams.set('message', message.id);
                if (workspaceId) link.searchParams.set('workspace', workspaceId);
                void navigator.clipboard
                  .writeText(link.href)
                  .catch(() => setError('Unable to copy the message link.'));
              }}
            >
              <Link2 size={15} />
              <span className="sr-only">Copy message link</span>
            </Button>
            <details className="reaction-picker">
              <summary aria-label="Add reaction" title="Add reaction">
                <SmilePlus size={15} />
                <span className="sr-only">React</span>
              </summary>
              <div role="group" aria-label="Choose reaction">
                {reactionEmojis.map((emoji) => (
                  <Button
                    variant="outline"
                    key={emoji}
                    aria-label={`React with ${emoji}`}
                    disabled={busy}
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open');
                      void mutate('PUT', '/reactions', { emoji });
                    }}
                  >
                    {emoji}
                  </Button>
                ))}
              </div>
            </details>
            {isAuthor && (
              <Button
                variant="ghost"
                aria-label="Edit message"
                title="Edit message"
                disabled={busy}
                onClick={() => {
                  setDraft(message.body);
                  setEditVersion(message.version);
                  setEditing(true);
                  setError('');
                }}
              >
                <Pencil size={15} />
                <span className="sr-only">Edit</span>
              </Button>
            )}
            {(isAuthor || (me.kind === 'human' && ['owner', 'admin'].includes(me.role))) && (
              <Button
                variant="ghost"
                aria-label="Delete message"
                title="Delete message"
                disabled={busy}
                onClick={() => {
                  setDeleteVersion(message.version);
                  setDeleting(true);
                  setError('');
                }}
              >
                <Trash2 size={15} />
                <span className="sr-only">Delete</span>
              </Button>
            )}
          </div>
        )}
        {!message.deleted_at && message.reactions.length > 0 && (
          <div className="message-reactions" aria-label="Message reactions">
            {message.reactions.map((reaction) => (
              <Button
                variant="outline"
                key={reaction.emoji}
                aria-label={`${reaction.emoji} ${reaction.count}`}
                aria-pressed={reaction.reacted}
                disabled={busy}
                onClick={() =>
                  void mutate(reaction.reacted ? 'DELETE' : 'PUT', '/reactions', {
                    emoji: reaction.emoji,
                  })
                }
              >
                {reaction.emoji} <span>{reaction.count}</span>
              </Button>
            ))}
          </div>
        )}
        {onThread && (
          <Button variant="link" className="reply-button" onClick={onThread}>
            <MessageSquare size={12} />
            {message.reply_count
              ? `${message.reply_count} ${message.reply_count === 1 ? 'reply' : 'replies'}`
              : 'Reply in thread'}
          </Button>
        )}
        {isAuthor && !message.deleted_at && message.read_count > 0 && (
          <p
            className="read-receipt"
            title={`Seen by ${message.read_by.map((reader) => reader.name).join(', ')}${message.read_count > message.read_by.length ? ` and ${message.read_count - message.read_by.length} more` : ''}`}
          >
            Seen by{' '}
            {message.read_count === 1 ? message.read_by[0]?.name : `${message.read_count} people`}
          </p>
        )}
        <span className="message-read-end" ref={end} aria-hidden="true" />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      {deleting && (
        <Dialog title="Delete message?" onClose={() => setDeleting(false)}>
          <p>This removes the message text. Replies stay in the thread.</p>
          {message.version !== deleteVersion && (
            <p className="error" role="alert">
              This message changed. Cancel and review the latest version before deleting.
            </p>
          )}
          <div className="message-actions">
            <Button
              variant="ghost"
              className="danger-button"
              disabled={busy || message.version !== deleteVersion}
              onClick={() => void mutate('DELETE', '', { version: deleteVersion })}
            >
              Delete message
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDeleting(false)}>
              Cancel
            </Button>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </article>
  );
}
