'use client';
import { WorkspaceHeading } from './workspace-heading';
import { Code2 } from 'lucide-react';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useEffect, useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import { publicScopes } from '@ao/contracts/developer';
import { api, post } from '../lib/api';
import { RemoteMcpSettings } from './remote-mcp-settings';
import { ConversationGrants } from './developer-grants';
import { DeveloperWebhookSettings } from './developer-webhook-settings';
interface Key {
  id: string;
  name: string;
  scopes: string[];
  conversation_ids: string[];
  workspace_resources: boolean;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  kind: string;
}
interface Client {
  id: string;
  name: string;
  redirect_uris: string[];
  revoked_at: string | null;
}
export function DeveloperView({ boot }: { boot: Bootstrap }) {
  const [keys, setKeys] = useState<Key[]>([]),
    [clients, setClients] = useState<Client[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [secret, setSecret] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void Promise.all([
      api<Key[]>('/developer/keys', { signal: c.signal }),
      api<Client[]>('/developer/clients', { signal: c.signal }),
    ])
      .then(([k, a]) => {
        if (!c.signal.aborted) {
          setKeys(k);
          setClients(a);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setKeys([]);
          setClients([]);
          setError(e instanceof Error ? e.message : 'Developer settings unavailable.');
        }
      });
    return () => c.abort();
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      const [k, a] = await Promise.all([
        api<Key[]>('/developer/keys'),
        api<Client[]>('/developer/clients'),
      ]);
      setKeys(k);
      setClients(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Developer action failed.');
    } finally {
      setBusy(false);
    }
  }
  if (
    boot.me.kind !== 'human' ||
    boot.me.access_type === 'guest' ||
    boot.me.access_type === 'service'
  )
    return <p className="empty-state">Developer credentials require a verified member account.</p>;
  return (
    <section className="domain-view platform-view" aria-label="Developer platform">
      <WorkspaceHeading
        icon={Code2}
        eyebrow="Build with Orbit"
        title="Developer access"
        description="Connect your applications through scoped API keys, OAuth, MCP, and webhooks."
      />
      <div className="action-row">
        <a href="/api/public/v1/openapi.json" target="_blank" rel="noreferrer">
          OpenAPI v1 specification
        </a>
        <code>/api/public/v1</code>
        <code>/api/mcp</code>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {secret && (
        <Card asChild>
          <section className="work-card" aria-label="New developer credential">
            <h3>Save this credential now</h3>
            <p>It is shown once. Keep it in your application’s secret store.</p>
            <label>
              Developer credential
              <Input readOnly value={secret} autoComplete="off" spellCheck={false} />
            </label>
            <Button variant="outline" onClick={() => setSecret('')}>
              Hide credential
            </Button>
          </section>
        </Card>
      )}
      <div className="platform-columns">
        <Card asChild>
          <form
            className="platform-form work-card"
            aria-label="Create API key"
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget),
                form = e.currentTarget;
              void action(async () => {
                const key = await post<{ token: string }>('/developer/keys', {
                  name: v.get('name'),
                  expiresInDays: Number(v.get('days')),
                  grants: {
                    scopes: v.getAll('scopes'),
                    conversationIds: v.getAll('conversationIds'),
                    workspaceResources: v.get('workspaceResources') === 'on',
                  },
                  audiences: v.getAll('audiences'),
                });
                setSecret(key.token);
                form.reset();
              });
            }}
          >
            <h3>Create an API key</h3>
            <label>
              API key name
              <Input name="name" minLength={2} maxLength={100} required />
            </label>
            <label>
              Key lifetime in days
              <Input type="number" name="days" min={1} max={365} defaultValue={30} required />
            </label>
            <fieldset>
              <legend>API permissions</legend>
              {publicScopes.map((scope) => (
                <label key={scope}>
                  <Input type="checkbox" name="scopes" value={scope} />
                  {scope}
                </label>
              ))}
            </fieldset>
            <ConversationGrants boot={boot} />
            <label>
              <Input type="checkbox" name="workspaceResources" />
              Allow content without a conversation
            </label>
            <fieldset>
              <legend>Allowed interfaces</legend>
              <label>
                <Input type="checkbox" name="audiences" value="rest" defaultChecked />
                REST API
              </label>
              <label>
                <Input type="checkbox" name="audiences" value="mcp" defaultChecked />
                MCP server
              </label>
            </fieldset>
            <Button className="primary" disabled={busy}>
              Create scoped API key
            </Button>
          </form>
        </Card>
        <section className="developer-credentials" aria-label="Developer credentials">
          <h3>Your credentials</h3>
          {keys.map((k) => (
            <Card key={k.id} asChild>
              <article className="work-card">
                <strong>{k.name}</strong>
                <p>
                  {k.kind} ·{' '}
                  {k.revoked_at
                    ? 'Revoked'
                    : 'Expires ' + new Date(k.expires_at).toLocaleDateString()}
                </p>
                <p>{k.scopes.join(', ')}</p>
                <p>
                  {k.conversation_ids
                    .map(
                      (id) =>
                        boot.channels.find((c) => c.id === id)?.name ?? 'Unavailable conversation',
                    )
                    .join(', ')}
                  {k.workspace_resources ? ' · Workspace resources' : ''}
                </p>
                {!k.revoked_at && (
                  <div className="action-row">
                    {k.kind === 'api_key' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const key = await post<{ token: string }>(
                              '/developer/keys/' + k.id + '/rotate',
                              {},
                            );
                            setSecret(key.token);
                          })
                        }
                      >
                        Rotate {k.name}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api('/developer/keys/' + k.id, { method: 'DELETE' });
                          setSecret('');
                        })
                      }
                    >
                      Revoke {k.name}
                    </Button>
                  </div>
                )}
              </article>
            </Card>
          ))}
          {!keys.length && <p>No API keys or OAuth grants.</p>}
        </section>
      </div>
      <section aria-label="OAuth application registration">
        <h3>OAuth applications</h3>
        <p>
          Authorization Code with PKCE, explicit workspace consent, and rotating refresh tokens.
        </p>
        <form
          className="platform-form"
          onSubmit={(e) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget),
              form = e.currentTarget;
            void action(async () => {
              await post('/developer/clients', {
                name: v.get('name'),
                redirectUris: String(v.get('redirects'))
                  .split('\n')
                  .map((v) => v.trim())
                  .filter(Boolean),
              });
              form.reset();
            });
          }}
        >
          <label>
            OAuth application name
            <Input name="name" required minLength={2} maxLength={100} />
          </label>
          <label>
            Exact redirect URLs, one per line
            <Textarea
              name="redirects"
              required
              placeholder="https://your-app.example/oauth/callback"
            />
          </label>
          <Button variant="outline" disabled={busy}>
            Register OAuth application
          </Button>
        </form>
        {clients.map((c) => (
          <Card key={c.id} asChild>
            <article className="work-card">
              <strong>{c.name}</strong>
              <p>
                Client ID: <code>{c.id}</code>
              </p>
              <p>{c.redirect_uris.join(', ')}</p>
              {c.revoked_at ? (
                <p>Revoked</p>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api('/developer/clients/' + c.id, { method: 'DELETE' });
                    })
                  }
                >
                  Revoke application {c.name}
                </Button>
              )}
            </article>
          </Card>
        ))}
      </section>
      <DeveloperWebhookSettings boot={boot} />
      <RemoteMcpSettings boot={boot} />
    </section>
  );
}
