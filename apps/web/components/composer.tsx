'use client';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Input } from './ui/input';
import { useEffect, useRef, useState } from 'react';
import {
  SendHorizontal,
  LoaderCircle,
  Paperclip,
  X,
  AtSign,
  Bold,
  Italic,
  Strikethrough,
  Code,
  CodeSquare,
  List,
  Quote,
  Eye,
  Pencil,
  Clock3,
} from 'lucide-react';
import { api, HttpError } from '../lib/api';
import { mentionToken } from '@ao/contracts/personal';
import { useMessageDraft } from '../lib/use-message-draft';
import { saveOutbox, type OutboxMessage } from '../lib/use-offline-outbox';
import { removePrivate } from '../lib/private-storage';
import { RichMessage } from './rich-message';
import { useTyping } from '../lib/use-typing';
import type { Member } from '@ao/contracts';
import { useAttachments } from '../lib/use-attachments';
export function Composer({
  onSend,
  onSent,
  placeholder,
  conversationId,
  onTyping,
  identity,
  authorId,
  membershipVersion,
  accessInterval,
  threadId,
}: {
  onSend: (
    body: string,
    clientId: string,
    attachmentIds: string[],
    mentionIds: string[],
  ) => Promise<void>;
  onSent?: () => Promise<unknown>;
  identity: string;
  authorId: string;
  membershipVersion?: number | undefined;
  accessInterval?: string | null | undefined;
  threadId?: string;
  placeholder: string;
  conversationId: string;
  onTyping?: (active: boolean) => Promise<void>;
}) {
  const draft = useMessageDraft(identity, conversationId, threadId);
  const body = draft.value.body,
    setBody = draft.setBody;
  const [preview, setPreview] = useState(false),
    [schedule, setSchedule] = useState(false),
    [sendAt, setSendAt] = useState(''),
    [notice, setNotice] = useState(''),
    [restoring, setRestoring] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [mentionPicker, setMentionPicker] = useState(false),
    [members, setMembers] = useState<Pick<Member, 'id' | 'name' | 'kind'>[]>([]),
    [mentionQuery, setMentionQuery] = useState('');
  const typing = useTyping(onTyping);
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!mentionPicker) return;
    const controller = new AbortController();
    void api<Pick<Member, 'id' | 'name' | 'kind'>[]>(
      `/conversations/${conversationId}/mentionable-members`,
      { signal: controller.signal },
    )
      .then(setMembers)
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Unable to load teammates.');
      });
    return () => controller.abort();
  }, [mentionPicker, conversationId]);
  const attachments = useAttachments(conversationId);
  const restored = useRef(false);
  useEffect(() => {
    if (!draft.ready || restored.current) return;
    restored.current = true;
    if (!draft.value.attachmentIds.length) {
      setRestoring(false);
      return;
    }
    void attachments
      .restore(draft.value.attachmentIds)
      .then(() => setRestoring(false))
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : 'Unable to restore attachments.'),
      );
  }, [draft.ready]);
  const remoteIds = JSON.stringify(
    attachments.items.flatMap((i) => (i.remote && i.status === 'ready' ? [i.remote.id] : [])),
  );
  useEffect(() => {
    if (draft.ready && !restoring) draft.setAttachments(JSON.parse(remoteIds) as string[]);
  }, [remoteIds, draft.ready, restoring]);
  const picker = useRef<HTMLInputElement>(null),
    pendingRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const ready = attachments.items.every((item) => item.status === 'ready');
  const canSend =
    draft.ready &&
    !restoring &&
    !draft.conflict &&
    ready &&
    (Boolean(body.trim()) || attachments.items.length > 0);
  async function submit(scheduled = false) {
    if (!canSend || busy || !draft.ready || restoring || draft.conflict) return;
    const submitted = body,
      attachmentIds = attachments.items.flatMap((i) => (i.remote ? [i.remote.id] : [])),
      mentionIds: string[] = [];
    let when: string | undefined;
    try {
      if (scheduled) when = new Date(sendAt).toISOString();
    } catch {
      setError('Choose a valid delivery time.');
      return;
    }
    const fingerprint = JSON.stringify([submitted, attachmentIds, when]);
    if (pendingRequest.current?.fingerprint !== fingerprint)
      pendingRequest.current = { fingerprint, id: crypto.randomUUID() };
    const clientId = pendingRequest.current.id;
    let queued: OutboxMessage = {
      clientId,
      conversationId,
      authorId,
      ...(membershipVersion ? { membershipVersion } : {}),
      ...(accessInterval !== undefined ? { accessInterval } : {}),
      body: submitted,
      format: 'markdown',
      attachmentIds,
      mentionIds,
      ...(threadId ? { threadId } : {}),
      ...(when ? { sendAt: when } : {}),
      status: navigator.onLine ? 'sending' : 'queued',
      createdAt: Date.now(),
      attemptedAt: Date.now(),
    };
    typing.stop();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await saveOutbox(identity, queued);
      if (navigator.onLine) {
        try {
          if (when)
            await api(`/conversations/${conversationId}/scheduled-messages`, {
              method: 'POST',
              body: JSON.stringify({
                body: submitted,
                format: 'markdown',
                clientId,
                attachmentIds,
                mentionIds,
                expectedAuthorId: authorId,
                ...(membershipVersion ? { expectedMembershipVersion: membershipVersion } : {}),
                ...(accessInterval !== undefined ? { expectedAccessInterval: accessInterval } : {}),
                ...(threadId ? { threadId } : {}),
                sendAt: when,
              }),
            });
          else await onSend(submitted, clientId, attachmentIds, mentionIds);
          await removePrivate(identity, 'outbox', clientId);
        } catch (cause) {
          if (
            cause instanceof HttpError &&
            cause.status < 500 &&
            ![408, 429].includes(cause.status)
          ) {
            await saveOutbox(identity, { ...queued, status: 'blocked', error: cause.message });
            throw cause;
          }
          queued = { ...queued, status: 'queued' };
          await saveOutbox(identity, queued);
        }
      }
      pendingRequest.current = null;
      await draft.clear();
      attachments.clear();
      setMentionPicker(false);
      setSchedule(false);
      if (queued.status !== 'queued') await onSent?.();
      setNotice(
        queued.status === 'queued'
          ? 'Queued on this device. It will send after reconnecting and rechecking access.'
          : when
            ? 'Message scheduled.'
            : '',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your message has not been sent.');
    } finally {
      setBusy(false);
    }
  }
  function formatSelection(before: string, after = before) {
    const node = text.current;
    if (!node) return;
    const start = node.selectionStart,
      end = node.selectionEnd;
    setBody(body.slice(0, start) + before + body.slice(start, end) + after + body.slice(end));
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(start + before.length, end + before.length);
    });
  }
  return (
    <div className="composer-wrap">
      <div className="composer">
        {attachments.items.length > 0 && (
          <ul className="upload-list" aria-label="Message attachments">
            {attachments.items.map((item) => (
              <li key={item.key}>
                <Paperclip size={16} />
                <div>
                  <strong>{item.file.name}</strong>
                  <small>
                    {item.status === 'ready'
                      ? 'Ready to send'
                      : item.status === 'failed'
                        ? item.error
                        : item.progress === 100
                          ? 'Checking and saving…'
                          : `Uploading ${item.progress}%`}
                  </small>
                  {item.status === 'uploading' && (
                    <progress
                      max={100}
                      value={item.progress}
                      aria-label={`Upload ${item.file.name}`}
                    />
                  )}
                </div>
                {item.status === 'failed' && (
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => attachments.retry(item)}
                  >
                    Retry upload
                  </Button>
                )}
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${item.file.name}`}
                  onClick={() => attachments.remove(item.key)}
                >
                  <X size={16} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="rich-toolbar" role="toolbar" aria-label="Message formatting">
          {(
            [
              ['Bold', '**', '**', Bold],
              ['Italic', '_', '_', Italic],
              ['Strikethrough', '~~', '~~', Strikethrough],
              ['Code', '`', '`', Code],
              ['Code block', '\n```\n', '\n```\n', CodeSquare],
              ['Bullet list', '\n- ', '', List],
              ['Quote', '\n> ', '', Quote],
            ] as const
          ).map(([label, before, after, Icon]) => (
            <Button
              variant="ghost"
              type="button"
              key={label}
              aria-label={label}
              title={label}
              disabled={busy || !draft.ready || preview}
              onClick={() => formatSelection(before, after)}
            >
              <Icon size={16} />
            </Button>
          ))}
          <Button
            variant="ghost"
            className="preview-toggle"
            type="button"
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? <Pencil size={14} /> : <Eye size={14} />} {preview ? 'Write' : 'Preview'}
          </Button>
        </div>
        {preview ? (
          <RichMessage body={body} format="markdown" mentions={members} />
        ) : (
          <Textarea
            ref={text}
            aria-label={placeholder}
            placeholder={placeholder}
            value={body}
            maxLength={12000}
            disabled={busy || !draft.ready || restoring}
            onBlur={typing.stop}
            onChange={(event) => {
              setBody(event.target.value);
              typing.changed(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        )}
        {mentionPicker && (
          <div className="mention-picker">
            <label>
              Find a teammate
              <Input
                autoFocus
                value={mentionQuery}
                onChange={(event) => setMentionQuery(event.target.value)}
              />
            </label>
            <div role="group" aria-label="Mention a teammate">
              {members
                .filter((member) => member.name.toLowerCase().includes(mentionQuery.toLowerCase()))
                .slice(0, 20)
                .map((member) => (
                  <Button
                    variant="outline"
                    key={member.id}
                    type="button"
                    onClick={() => {
                      setBody(
                        `${body}${body && !/\s$/.test(body) ? ' ' : ''}${mentionToken(member)} `,
                      );
                      setMentionPicker(false);
                      setMentionQuery('');
                      text.current?.focus();
                    }}
                  >
                    {member.name}
                    {member.kind === 'agent' ? ' · Agent' : ''}
                  </Button>
                ))}
            </div>
            <Button variant="outline" type="button" onClick={() => setMentionPicker(false)}>
              Close mentions
            </Button>
          </div>
        )}
        <div className="composer-tools">
          <span>
            <Button
              variant="ghost"
              type="button"
              aria-label="Attach files"
              className="attach-button"
              disabled={busy || attachments.items.length >= 10}
              onClick={() => picker.current?.click()}
            >
              <Paperclip size={17} />
            </Button>
            <Button
              variant="ghost"
              type="button"
              className="attach-button"
              aria-label="Mention a teammate"
              disabled={busy}
              onClick={() => setMentionPicker(!mentionPicker)}
            >
              <AtSign size={17} />
            </Button>
            <small>Files up to 25 MB · Formatting supported</small>
          </span>
          <Input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose files"
            onChange={(event) => {
              attachments.add(event.target.files);
              event.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            type="button"
            className="text-tool"
            disabled={busy || !canSend}
            onClick={() => setSchedule(!schedule)}
          >
            <Clock3 size={15} /> Schedule
          </Button>
          <Button
            variant="ghost"
            aria-label="Send message"
            disabled={busy || !canSend}
            onClick={() => void submit()}
          >
            {busy ? <LoaderCircle size={17} className="spin" /> : <SendHorizontal size={17} />}
          </Button>
        </div>
      </div>
      {schedule && (
        <div className="schedule-composer">
          <label>
            Delivery time
            <Input
              type="datetime-local"
              value={sendAt}
              onChange={(event) => setSendAt(event.target.value)}
            />
          </label>
          <Button
            variant="outline"
            type="button"
            disabled={busy || !canSend || !sendAt}
            onClick={() => void submit(true)}
          >
            Schedule message
          </Button>
        </div>
      )}
      {draft.conflict && (
        <div className="error" role="alert">
          This draft changed on another device.
          <Button variant="outline" onClick={() => draft.resolve(true)}>
            Use saved draft
          </Button>
          <Button variant="outline" onClick={() => draft.resolve(false)}>
            Keep this draft
          </Button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {restoring && error ? (
        <div role="alert">
          <p>Review the unavailable draft attachments before sending.</p>
          <Button
            variant="outline"
            onClick={() => {
              void attachments
                .restore(draft.value.attachmentIds)
                .then(() => {
                  setRestoring(false);
                  setError('');
                })
                .catch((e) =>
                  setError(e instanceof Error ? e.message : 'Unable to restore attachments.'),
                );
            }}
          >
            Retry draft attachments
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              draft.setAttachments([]);
              attachments.clear();
              setRestoring(false);
              setError('');
            }}
          >
            Discard unavailable draft attachments
          </Button>
        </div>
      ) : null}
      {draft.error && (
        <p role="alert" className="error">
          {draft.error}
        </p>
      )}
      {(error || attachments.error) && (
        <p className="error" role="alert">
          {error || attachments.error} Your draft has been kept.
        </p>
      )}
    </div>
  );
}
