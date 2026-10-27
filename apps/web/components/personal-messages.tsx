'use client';
import { WorkspaceHeading } from './workspace-heading';
import { BookOpen } from 'lucide-react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { useState } from 'react';
import type { PersonalMessage, ScheduledMessage } from '@ao/contracts/personal';
import type { OutboxMessage } from '../lib/use-offline-outbox';
import { useCursorPage } from '../lib/use-cursor-page';
import { api } from '../lib/api';
import { PageControls } from './page-controls';
import { RichMessage } from './rich-message';
type Tab =
  'saved-messages' | 'followed-threads' | 'drafts' | 'scheduled-messages' | 'outbox' | 'pins';
export function PersonalMessages({
  identity,
  revision,
  outbox,
  initialTab = 'saved-messages',
  conversation,
  onOpen,
  onConversation,
  onRetry,
  onRemove,
}: {
  identity: string;
  revision: number;
  outbox: OutboxMessage[];
  initialTab?: Tab;
  conversation?: string;
  onOpen: (id: string) => Promise<void>;
  onConversation: (id: string, thread?: string | null) => void;
  onRetry: (item: OutboxMessage) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>(initialTab),
    [error, setError] = useState('');
  const path =
      tab === 'pins'
        ? `/conversations/${conversation}/pins`
        : '/' + (tab === 'outbox' ? 'saved-messages' : tab),
    page = useCursorPage<PersonalMessage & ScheduledMessage>(
      tab === 'outbox' ? null : identity,
      path,
      revision,
    );
  async function cancel(item: ScheduledMessage, sendAt?: string) {
    try {
      await api(`/scheduled-messages/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: item.version,
          ...(sendAt ? { sendAt } : { cancel: true }),
        }),
      });
      await page.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update scheduled message.');
    }
  }
  return (
    <section className="page-content">
      <WorkspaceHeading
        icon={BookOpen}
        eyebrow="Your personal corner"
        title="Your messages"
        description="The conversations you saved, the threads you follow, and the ideas still taking shape."
      />
      <nav className="view-tabs" aria-label="Personal message views">
        {(
          [
            'saved-messages',
            'followed-threads',
            'drafts',
            'scheduled-messages',
            'outbox',
            ...(conversation ? (['pins'] as const) : []),
          ] as Tab[]
        ).map((t) => (
          <Button variant="ghost" key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {
              {
                'saved-messages': 'Saved',
                'followed-threads': 'Following',
                drafts: 'Drafts',
                'scheduled-messages': 'Scheduled',
                outbox: 'Offline outbox',
                pins: 'Pinned',
              }[t]
            }
            {t === 'outbox' && outbox.length ? ' (' + outbox.length + ')' : ''}
          </Button>
        ))}
      </nav>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {tab === 'outbox'
        ? outbox.map((item) => (
            <Card key={item.clientId} asChild>
              <article className="personal-message-card">
                <RichMessage body={item.body} format="markdown" />
                <p>
                  {item.status === 'blocked'
                    ? 'Needs review'
                    : item.status === 'sending'
                      ? 'Confirming delivery'
                      : 'Waiting to send'}
                  {item.error ? ' · ' + item.error : ''}
                </p>
                <Button variant="outline" onClick={() => void onRetry(item)}>
                  Retry queued message
                </Button>
                <Button variant="outline" onClick={() => void onRemove(item.clientId)}>
                  Remove from outbox
                </Button>
              </article>
            </Card>
          ))
        : page.items.map((item) => (
            <Card key={item.id} asChild>
              <article className="personal-message-card">
                <RichMessage body={item.body} format={item.format} />
                {item.author_name ? <p className="muted">{item.author_name}</p> : null}
                {tab === 'scheduled-messages' ? (
                  <>
                    <p>
                      {item.status} · {new Date(item.send_at).toLocaleString()}
                      {item.error_code ? ' · ' + item.error_code : ''}
                    </p>
                    {item.status === 'scheduled' ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const value = String(new FormData(event.currentTarget).get('time'));
                          void cancel(item, new Date(value).toISOString());
                        }}
                      >
                        <label>
                          New delivery time
                          <Input type="datetime-local" name="time" required />
                        </label>
                        <Button variant="outline">Reschedule</Button>
                        <Button variant="outline" type="button" onClick={() => void cancel(item)}>
                          Cancel scheduled message
                        </Button>
                      </form>
                    ) : null}
                    {item.message_id ? (
                      <Button variant="outline" onClick={() => void onOpen(item.message_id)}>
                        Open delivered message
                      </Button>
                    ) : null}
                  </>
                ) : tab === 'drafts' ? (
                  <Button
                    variant="outline"
                    onClick={() => onConversation(item.conversation_id, item.thread_id)}
                  >
                    Continue draft
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => void onOpen(item.message_id)}>
                    Open message
                  </Button>
                )}
              </article>
            </Card>
          ))}
      {tab === 'outbox' && !outbox.length ? (
        <p>No messages are waiting to send on this device.</p>
      ) : null}
      {tab !== 'outbox' && !page.busy && !page.items.length ? <p>Nothing here yet.</p> : null}
      <PageControls {...page} onMore={page.more} />
    </section>
  );
}
