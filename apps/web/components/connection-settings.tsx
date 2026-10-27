'use client';
import { Card } from './ui/card';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import type { ConnectorManifest } from '@ao/contracts/connections';
import { api } from '../lib/api';
import { NativeWebhookSettings } from './native-webhook-settings';
interface Connection {
  id: string;
  name: string;
  provider: string;
  owner_id: string;
  audience: string;
  state: string;
  version: number;
  write_enabled: boolean;
  last_success_at: string | null;
  last_error_code: string | null;
  credential_expires_at: string;
}
export function ConnectionSettings({ boot }: { boot: Bootstrap }) {
  const [catalog, setCatalog] = useState<ConnectorManifest[]>([]),
    [items, setItems] = useState<Connection[]>([]),
    [next, setNext] = useState<string | null>(null),
    [provider, setProvider] = useState('github'),
    [selected, setSelected] = useState<Connection | null>(null),
    [oauth, setOauth] = useState<string[]>([]),
    [oauthAccess, setOauthAccess] = useState('read'),
    [oauthAudience, setOauthAudience] = useState('personal'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0);
  const manage =
    boot.me.kind === 'human' &&
    (!boot.me.access_type || boot.me.access_type === 'member') &&
    boot.me.permissions?.['execution.manage'] !== false;
  const load = useCallback(async (after: string | null = null) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = ++generation.current;
    try {
      const page = await api<{ items: Connection[]; next_after: string | null }>(
        '/connections' + (after ? '?after=' + after : ''),
        { signal: request.signal },
      );
      if (current === generation.current) {
        setItems((old) => (after ? [...old, ...page.items] : page.items));
        setNext(page.next_after);
      }
    } catch (e) {
      if (!request.signal.aborted) {
        setItems([]);
        setSelected(null);
        setError(e instanceof Error ? e.message : 'Connections could not be loaded.');
      }
    }
  }, []);
  useEffect(() => {
    const request = new AbortController();
    void Promise.all([
      api<{ items: ConnectorManifest[] }>('/connections/catalog', { signal: request.signal }),
      api<{ items: string[] }>('/connections/oauth/providers', { signal: request.signal }),
    ])
      .then(([catalog, oauth]) => {
        setCatalog(catalog.items);
        setOauth(oauth.items);
      })
      .catch((e) => {
        if (!request.signal.aborted)
          setError(e instanceof Error ? e.message : 'Catalog unavailable.');
      });
    void load();
    return () => {
      request.abort();
      generation.current++;
      controller.current?.abort();
    };
  }, [load]);
  const manifest = catalog.find((m) => m.id === provider),
    selectedManifest = catalog.find((m) => m.id === selected?.provider);
  async function action(work: () => Promise<void>) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection action failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card asChild>
      <details className="settings-card">
        <summary>
          <strong>Connections and connector catalog</strong>
        </summary>
        <p className="muted">
          Choose explicit resources and consumers for each connection. Provider credentials stay on
          the server. Each operation needs independent provider test-account validation.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {manage && (
          <form
            className="search-filters"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                data = new FormData(form);
              void action(async () => {
                await api('/connections', {
                  method: 'POST',
                  body: JSON.stringify({
                    provider,
                    name: data.get('name'),
                    audience: data.get('audience'),
                    credential: data.get('credential'),
                    allowWrites: data.get('allowWrites') === 'on',
                    config: Object.fromEntries(
                      (manifest?.configuration ?? []).map((field) => [
                        field.key,
                        String(data.get('config:' + field.key) ?? ''),
                      ]),
                    ),
                  }),
                });
                form.reset();
                setNotice('Connection saved. Select it to import resources and grant consumers.');
              });
            }}
          >
            <label>
              Provider
              <NativeSelect
                aria-label="Connector provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                {catalog.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.operations.length ? '' : ' · adapter pending'}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Name
              <Input name="name" required maxLength={120} />
            </label>
            <label>
              Audience
              <NativeSelect name="audience">
                <option value="personal">Personal</option>
                <option value="workspace">Workspace with explicit grants</option>
              </NativeSelect>
            </label>
            <label>
              {manifest?.credentialFormat === 'json'
                ? 'Credential JSON (see provider documentation)'
                : 'Provider access token'}
              <Input
                type="password"
                name="credential"
                required
                autoComplete="off"
                maxLength={20000}
              />
            </label>
            {manifest?.configuration.map((field) => (
              <label key={field.key}>
                {field.label}
                <Input name={'config:' + field.key} required={field.required} maxLength={500} />
              </label>
            ))}
            {manifest?.writes === 'native-approved' && (
              <label className="checkbox-field">
                <Input type="checkbox" name="allowWrites" />
                Enable approved native writes. Each consumer still needs an exact resource grant and
                each action needs approval.
              </label>
            )}
            <Button
              size="sm"
              className="primary small"
              disabled={busy || !manifest?.operations.length}
            >
              Add connection
            </Button>
          </form>
        )}
        {manifest && (
          <p className="muted">
            {manifest.name}:{' '}
            {manifest.operations.length
              ? manifest.operations.map((o) => o.label).join(', ')
              : 'Native adapter pending'}
            . {manifest.limitations.join(' ')}{' '}
            <a href={manifest.documentation} target="_blank" rel="noreferrer">
              Provider documentation
            </a>
          </p>
        )}
        {manage && oauth.includes(provider) && (
          <Card asChild>
            <div className="settings-card">
              <label>
                OAuth access
                <NativeSelect
                  value={oauthAccess}
                  onChange={(e) => setOauthAccess(e.target.value)}
                  aria-label="OAuth access"
                >
                  <option value="read">Read only in Orbit</option>
                  <option value="write">Allow approved native writes</option>
                </NativeSelect>
              </label>
              <label>
                OAuth connection audience
                <NativeSelect
                  value={oauthAudience}
                  onChange={(e) => setOauthAudience(e.target.value)}
                >
                  <option value="personal">Personal</option>
                  <option value="workspace">Workspace with explicit consumer grants</option>
                </NativeSelect>
              </label>
              {provider === 'github' && (
                <p className="muted">
                  GitHub OAuth’s repo scope includes repository write permissions. Orbit still
                  enforces your selected local read/write setting; use a fine-grained token for
                  narrower provider permissions.
                </p>
              )}
              {provider === 'notion' && (
                <p className="muted">
                  Notion capabilities are configured on the provider application. Orbit enforces
                  local read/write access locally; native writes are limited to plain paragraph
                  replacement.
                </p>
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = await api<{ url: string }>('/connections/oauth/start', {
                      method: 'POST',
                      body: JSON.stringify({
                        provider,
                        name: manifest?.name ?? provider,
                        audience: oauthAudience,
                        access: oauthAccess,
                      }),
                    });
                    window.location.assign(result.url);
                  })
                }
              >
                Connect {manifest?.name} with OAuth
              </Button>
            </div>
          </Card>
        )}
        <div className="card-grid">
          {items.map((c) => (
            <Card key={c.id} asChild>
              <article className="settings-card">
                <h3>{c.name}</h3>
                <p>
                  {c.provider} · {c.audience} · {c.state} ·{' '}
                  {c.write_enabled ? 'approved writes enabled' : 'read only'}
                </p>
                <p className="muted">
                  Last successful import:{' '}
                  {c.last_success_at ? new Date(c.last_success_at).toLocaleString() : 'None'}
                  <br />
                  Credential expires: {new Date(c.credential_expires_at).toLocaleDateString()}
                </p>
                {c.last_error_code && <p role="status">{c.last_error_code}</p>}
                {c.owner_id === boot.me.id && manage && (
                  <Button variant="outline" onClick={() => setSelected(c)}>
                    Manage connection
                  </Button>
                )}
              </article>
            </Card>
          ))}
        </div>
        {next && (
          <Button variant="outline" onClick={() => void load(next)}>
            Load more connections
          </Button>
        )}
        {selected && selectedManifest && (
          <Card asChild>
            <div className="settings-card">
              <h3>{selected.name}</h3>
              <form
                className="search-filters"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void action(async () => {
                    await api(`/connections/${selected.id}/import`, {
                      method: 'POST',
                      body: JSON.stringify({
                        operation: data.get('operation'),
                        resource: data.get('resource'),
                        ...(data.get('conversation')
                          ? { conversationId: data.get('conversation') }
                          : {}),
                      }),
                    });
                    setNotice('Resource imported and queued for indexing.');
                  });
                }}
              >
                <label>
                  Operation
                  <NativeSelect name="operation">
                    {selectedManifest.operations
                      .filter((o) => o.effect === 'read')
                      .map((o) => (
                        <option key={o.id}>{o.id}</option>
                      ))}
                  </NativeSelect>
                </label>
                <label>
                  Resource ID
                  <Input
                    name="resource"
                    required
                    maxLength={500}
                    placeholder={selectedManifest.operations[0]?.resourceFormat}
                  />
                </label>
                <label>
                  Conversation audience
                  <NativeSelect name="conversation">
                    <option value="">Connection audience</option>
                    {boot.channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <Button variant="outline" disabled={busy || selected.state !== 'connected'}>
                  Import resource
                </Button>
              </form>
              {selected.audience === 'workspace' && (
                <form
                  className="search-filters"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    void action(async () => {
                      await api(`/connections/${selected.id}/grants`, {
                        method: 'PUT',
                        body: JSON.stringify({
                          memberId: data.get('member'),
                          operations: [data.get('operation')],
                          resources: String(data.get('resources'))
                            .split('\n')
                            .map((v) => v.trim())
                            .filter(Boolean),
                          expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
                        }),
                      });
                      setNotice('Consumer grant saved for 30 days.');
                    });
                  }}
                >
                  <label>
                    Consumer
                    <NativeSelect name="member">
                      {boot.members
                        .filter((m) => m.id !== boot.me.id)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </NativeSelect>
                  </label>
                  <label>
                    Operation
                    <NativeSelect name="operation">
                      {selectedManifest.operations
                        .filter((o) => o.effect === 'read' || selected.write_enabled)
                        .map((o) => (
                          <option key={o.id}>{o.id}</option>
                        ))}
                    </NativeSelect>
                  </label>
                  <label>
                    Explicit resource IDs, one per line
                    <Textarea name="resources" required maxLength={10000} />
                  </label>
                  <Button variant="outline" disabled={busy}>
                    Grant access for 30 days
                  </Button>
                </form>
              )}
              <form
                className="search-filters"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget,
                    data = new FormData(form);
                  void action(async () => {
                    const r = await api<{ version: number }>(`/connections/${selected.id}/rotate`, {
                      method: 'POST',
                      body: JSON.stringify({
                        version: selected.version,
                        credential: data.get('credential'),
                        allowWrites: data.get('allowWrites') === 'on',
                      }),
                    });
                    setSelected({
                      ...selected,
                      version: r.version,
                      state: 'connected',
                      write_enabled: data.get('allowWrites') === 'on',
                    });
                    form.reset();
                    setNotice('Credential rotated and access contexts invalidated.');
                  });
                }}
              >
                <label>
                  Replacement token
                  <Input
                    name="credential"
                    type="password"
                    required
                    autoComplete="off"
                    maxLength={20000}
                  />
                </label>
                {selectedManifest.writes === 'native-approved' && (
                  <label className="checkbox-field">
                    <Input
                      type="checkbox"
                      name="allowWrites"
                      defaultChecked={selected.write_enabled}
                    />
                    Enable approved native writes for this token
                  </label>
                )}
                <Button variant="outline" disabled={busy}>
                  Rotate or reconnect
                </Button>
              </form>
              {oauth.includes(selected.provider) && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const result = await api<{ url: string }>('/connections/oauth/start', {
                        method: 'POST',
                        body: JSON.stringify({
                          provider: selected.provider,
                          name: selected.name,
                          audience: selected.audience,
                          connectionId: selected.id,
                          access: oauthAccess,
                        }),
                      });
                      window.location.assign(result.url);
                    })
                  }
                >
                  Reconnect {selected.name} with OAuth ({oauthAccess})
                </Button>
              )}
              {selected.write_enabled &&
                selectedManifest.operations.some((o) => o.effect === 'write') && (
                  <Card asChild>
                    <div className="settings-card">
                      <h4>Native write operations</h4>
                      <p>
                        Agents use the approved provider-operation tool with this connection ID:{' '}
                        <code>{selected.id}</code>. A proposal must include the exact resource,
                        patched fields and reviewed previous values.
                      </p>
                      <ul>
                        {selectedManifest.operations
                          .filter((o) => o.effect === 'write')
                          .map((o) => (
                            <li key={o.id}>
                              <code>{o.id}</code>: {o.fields?.join(', ')} · {o.idempotency}
                            </li>
                          ))}
                      </ul>
                      <p className="muted">
                        Unknown outcomes are checked through read-only reconciliation. A new write
                        is never dispatched automatically to resolve an unknown outcome.
                      </p>
                    </div>
                  </Card>
                )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api(`/connections/${selected.id}`, {
                      method: 'DELETE',
                      body: JSON.stringify({ version: selected.version }),
                    });
                    setSelected(null);
                    setNotice('Connection revoked and imported content removed.');
                  })
                }
              >
                Disconnect and remove imports
              </Button>
              <Button variant="outline" onClick={() => setSelected(null)}>
                Close
              </Button>
              {Boolean(selectedManifest.nativeEvents?.length) && (
                <NativeWebhookSettings
                  key={selected.id + ':' + selected.version}
                  connectionId={selected.id}
                  provider={selected.provider}
                  version={selected.version}
                />
              )}
            </div>
          </Card>
        )}
      </details>
    </Card>
  );
}
