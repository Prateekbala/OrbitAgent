'use client';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { useEffect, useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import { api, post } from '../lib/api';
import { ConversationGrants } from './developer-grants';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
interface Webhook {
  id: string;
  name: string;
  url: string;
  version: number;
  enabled: boolean;
}
const eventTypes = [
  'message.created',
  'message.updated',
  'message.deleted',
  'task.created',
  'task.updated',
  'task.transitioned',
  'task.comment_created',
  'knowledge.created',
  'knowledge.updated',
  'run.generated',
  'automation.escalated',
];
export function DeveloperWebhookSettings({ boot }: { boot: Bootstrap }) {
  const [items, setItems] = useState<Webhook[]>([]),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    [secret, setSecret] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    void api<Webhook[]>('/developer/webhooks', { signal: c.signal })
      .then((r) => {
        if (!c.signal.aborted) setItems(r);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e instanceof Error ? e.message : 'Webhooks unavailable.');
      });
    return () => c.abort();
  }, [revision]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Webhook action failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Public webhook settings">
      <h3>Public webhooks</h3>
      <p>Signed change notices with bounded retries and inspectable delivery history.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {secret && (
        <label>
          Webhook signing secret
          <Input readOnly value={secret} autoComplete="off" />
          <Button variant="outline" onClick={() => setSecret('')}>
            Hide signing secret
          </Button>
        </label>
      )}
      <form
        className="platform-form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = new FormData(e.currentTarget),
            form = e.currentTarget;
          void action(async () => {
            const r = await post<{ secret: string }>('/developer/webhooks', {
              name: v.get('name'),
              url: v.get('url'),
              conversationIds: v.getAll('conversationIds'),
              events: v.getAll('events'),
            });
            setSecret(r.secret);
            form.reset();
          });
        }}
      >
        <label>
          Webhook name
          <Input name="name" required minLength={2} />
        </label>
        <label>
          Webhook endpoint
          <Input name="url" type="url" placeholder="https://hooks.example/orbit" required />
        </label>
        <ConversationGrants boot={boot} />
        <fieldset>
          <legend>Webhook events</legend>
          {eventTypes.map((event) => (
            <label key={event}>
              <Input type="checkbox" name="events" value={event} />
              {event}
            </label>
          ))}
        </fieldset>
        <Button variant="outline" disabled={busy}>
          Create signed webhook
        </Button>
      </form>
      {items.map((w) => (
        <Card key={w.id} asChild>
          <article className="work-card">
            <strong>{w.name}</strong>
            <p>
              {w.url} · {w.enabled ? 'Active' : 'Paused'}
            </p>
            <div className="action-row">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await post('/developer/webhooks/' + w.id + '/control', {
                      version: w.version,
                      action: w.enabled ? 'pause' : 'resume',
                    });
                  })
                }
              >
                {w.enabled ? 'Pause' : 'Resume'} webhook {w.name}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const r = await post<{ secret: string }>(
                      '/developer/webhooks/' + w.id + '/control',
                      { version: w.version, action: 'rotate' },
                    );
                    setSecret(r.secret);
                  })
                }
              >
                Rotate signing secret for {w.name}
              </Button>
              <Button variant="outline" onClick={() => setSelected(w.id)}>
                Delivery history for {w.name}
              </Button>
            </div>
          </article>
        </Card>
      ))}
      {selected && (
        <Deliveries
          key={selected + ':' + revision}
          scope={boot.workspace.id + ':' + boot.me.id}
          id={selected}
          onReplay={(id) =>
            action(async () => {
              await post('/developer/deliveries/' + id + '/replay', {});
            })
          }
        />
      )}
    </section>
  );
}
function Deliveries({
  scope,
  id,
  onReplay,
}: {
  scope: string;
  id: string;
  onReplay: (id: string) => Promise<void>;
}) {
  const page = useCursorPage<{
    id: string;
    state: string;
    attempts: number;
    error_code: string | null;
  }>(scope, '/developer/webhooks/' + id + '/deliveries');
  return (
    <section aria-label="Webhook delivery history">
      <h4>Delivery history</h4>
      {page.items.map((d) => (
        <Card key={d.id} asChild>
          <article className="work-card">
            <p>
              {d.state} · {d.attempts} attempts{d.error_code ? ' · ' + d.error_code : ''}
            </p>
            {d.state === 'dead' && (
              <Button variant="outline" onClick={() => void onReplay(d.id)}>
                Replay failed delivery
              </Button>
            )}
          </article>
        </Card>
      ))}
      {!page.items.length && <p>No deliveries yet.</p>}
      <PageControls next={page.next} busy={page.busy} error={page.error} onMore={page.more} />
    </section>
  );
}
