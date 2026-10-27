'use client';
import { NotificationDeliverySettings } from './notification-delivery';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, Settings, ArrowRight } from 'lucide-react';
import type { InboxNotification, NotificationPage, NotificationPreferences } from '@ao/contracts';
import { defaultNotificationPreferences } from '@ao/contracts/notifications';
import { api, post } from '../lib/api';
import { Dialog } from './dialog';
import { WorkspaceHeading } from './workspace-heading';
import { Empty } from './primitives';
const labels: Record<InboxNotification['kind'], string> = {
  message: 'New message',
  mention: 'Mentioned you',
  reply: 'Replied to your thread',
  reaction: 'Reacted to your message',
  task_assigned: 'Assigned you a task',
  task_comment: 'Commented on a task',
  task_reminder: 'Task due-date reminder',
  task_activity: 'Updated a task you follow',
  workflow_attention: 'Workflow needs your attention',
  agent_attention: 'Delegated work needs your attention',
  automation_attention: 'Automation needs your attention',
  approval_request: 'Needs your approval',
  group_added: 'Added you to a conversation',
};
export function NotificationCenter({
  revision,
  onChanged,
  onOpen,
}: {
  revision: number;
  onChanged: () => Promise<void>;
  onOpen: (notification: InboxNotification) => Promise<void>;
}) {
  const [page, setPage] = useState<NotificationPage>({
      items: [],
      unread_count: 0,
      next_cursor: null,
    }),
    [unread, setUnread] = useState(false),
    [settings, setSettings] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current++;
  }, [revision, unread]);
  useLayoutEffect(() => {
    setPage({ items: [], unread_count: 0, next_cursor: null });
    setLoading(true);
  }, [unread]);
  useEffect(() => {
    const version = generation.current;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<NotificationPage>(`/notifications?unread=${unread}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && generation.current === version) setPage(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Unable to load notifications.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, unread]);
  async function mutate(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      await onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update notifications.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page-content notification-center" aria-busy={loading}>
      <WorkspaceHeading
        icon={Bell}
        eyebrow="Stay in the loop"
        title="Your activity"
        description="Mentions, replies, and updates that need your attention, all in one place."
      />
      <div className="notification-toolbar">
        <div role="group" aria-label="Notification filter">
          <Button
            variant="outline"
            className={!unread ? 'selected' : ''}
            aria-pressed={!unread}
            onClick={() => setUnread(false)}
          >
            All notifications
          </Button>
          <Button
            variant="outline"
            className={unread ? 'selected' : ''}
            aria-pressed={unread}
            onClick={() => setUnread(true)}
          >
            Unread notifications
          </Button>
        </div>
        <div>
          <Button
            variant="outline"
            disabled={busy || !page.items.length || !page.unread_count}
            onClick={() =>
              void mutate(() => post('/notifications/read-all', { throughId: page.items[0]!.id }))
            }
          >
            <CheckCheck size={16} />
            Mark all read
          </Button>
          <Button variant="outline" onClick={() => setSettings(true)}>
            <Settings size={16} />
            Notification settings
          </Button>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && !page.items.length ? (
        <p role="status">Loading notifications…</p>
      ) : !page.items.length ? (
        <Empty
          icon={Bell}
          title={unread ? 'You’re all caught up' : 'No notifications yet'}
          description="Messages, mentions, replies and actions for you appear here."
        />
      ) : (
        <ul className="notification-list">
          {page.items.map((item) => (
            <li
              key={item.id}
              className={item.read_at ? '' : 'notification-unread'}
              data-notification-id={item.id}
            >
              <Button
                variant="outline"
                className="notification-open"
                disabled={busy}
                onClick={() =>
                  void mutate(async () => {
                    await onOpen(item);
                    await api(`/notifications/${item.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ read: true }),
                    });
                  })
                }
              >
                <span>
                  <strong>{labels[item.kind]}</strong>
                  <small>
                    {item.actor_name}
                    {item.conversation_name ? ` · ${item.conversation_name}` : ''}
                  </small>
                  {item.message_id ? (
                    <p>{item.excerpt || 'File attachment'}</p>
                  ) : item.excerpt ? (
                    <p>{item.excerpt}</p>
                  ) : null}
                  <time dateTime={item.created_at}>
                    {new Date(item.created_at).toLocaleString()}
                  </time>
                </span>
                <ArrowRight size={16} />
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                className="notification-read-button"
                aria-label={item.read_at ? 'Mark notification unread' : 'Mark notification read'}
                onClick={() =>
                  void mutate(() =>
                    api(`/notifications/${item.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ read: !item.read_at }),
                    }),
                  )
                }
              >
                {item.read_at ? 'Mark unread' : 'Mark read'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {page.next_cursor && (
        <Button
          variant="outline"
          disabled={busy || loading}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const version = generation.current;
              const next = await api<NotificationPage>(
                `/notifications?unread=${unread}&before=${page.next_cursor}`,
              );
              if (generation.current === version)
                setPage((current) => ({ ...next, items: [...current.items, ...next.items] }));
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Unable to load notifications.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Load more notifications
        </Button>
      )}
      {settings && (
        <NotificationSettings onClose={() => setSettings(false)} onChanged={onChanged} />
      )}
    </section>
  );
}
const preferenceLabels: Record<keyof NotificationPreferences, string> = {
  enabled: 'Enable in-app notifications',
  mentions: 'Mentions',
  replies: 'Thread replies',
  direct_messages: 'Direct messages',
  group_messages: 'Group messages and invitations',
  reactions: 'Reactions to my messages',
  tasks: 'Task assignments, comments and reminders',
  approvals: 'Approval requests',
};
function NotificationSettings({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [preferences, setPreferences] = useState<NotificationPreferences>(
      defaultNotificationPreferences,
    ),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<NotificationPreferences>('/notifications/preferences', { signal: controller.signal })
      .then(setPreferences)
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Unable to load preferences.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  return (
    <Dialog title="Notification settings" onClose={onClose}>
      <div className="notification-settings">
        {(Object.keys(preferenceLabels) as (keyof NotificationPreferences)[]).map((key) => (
          <label key={key}>
            <Input
              type="checkbox"
              disabled={loading || busy}
              checked={preferences[key]}
              onChange={async (event) => {
                const checked = event.target.checked;
                const previous = preferences[key];
                setPreferences((current) => ({ ...current, [key]: checked }));
                setBusy(true);
                setError('');
                try {
                  await api('/notifications/preferences', {
                    method: 'PATCH',
                    body: JSON.stringify({ [key]: checked }),
                  });
                  setPreferences((current) => ({ ...current, [key]: checked }));
                  await onChanged();
                } catch (error) {
                  setPreferences((current) => ({ ...current, [key]: previous }));
                  setError(error instanceof Error ? error.message : 'Unable to save preference.');
                } finally {
                  setBusy(false);
                }
              }}
            />
            {preferenceLabels[key]}
          </label>
        ))}
        <p className="muted">
          These settings affect new in-app notifications. Conversation mute settings take
          precedence. Channel unread counts remain separate.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <NotificationDeliverySettings />
    </Dialog>
  );
}
export function ConversationNotifications({
  conversation,
  revision,
}: {
  conversation: string;
  revision: number;
}) {
  const [mode, setMode] = useState('default'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<{ mode: string }>(`/conversations/${conversation}/notification-preferences`, {
      signal: controller.signal,
    })
      .then((result) => setMode(result.mode))
      .catch(() => {});
    return () => controller.abort();
  }, [conversation, revision]);
  return (
    <div className="conversation-notification-control">
      <label>
        Conversation notifications
        <NativeSelect
          value={mode}
          disabled={busy}
          onChange={async (event) => {
            const next = event.target.value;
            setBusy(true);
            setError('');
            try {
              await api(`/conversations/${conversation}/notification-preferences`, {
                method: 'PUT',
                body: JSON.stringify({ mode: next }),
              });
              setMode(next);
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Unable to save preference.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="default">Default</option>
          <option value="all">All messages</option>
          <option value="mentions">Mentions and replies</option>
          <option value="muted">Muted</option>
        </NativeSelect>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
