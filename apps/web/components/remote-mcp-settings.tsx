'use client';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { NativeSelect } from './ui/native-select';
import { useEffect, useRef, useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import { toolEffects } from '@ao/contracts/tools';
import { api, post } from '../lib/api';
import { ConversationGrants } from './developer-grants';
interface Connection {
  id: string;
  name: string;
  protocol: string;
  owner_id: string;
  version: number;
  revoked_at: string | null;
  health: string;
  operations: { name: string; remoteName?: string; effect: string; description: string }[];
  mcp_manifest?: { name: string; description?: string }[];
}
export function RemoteMcpSettings({ boot }: { boot: Bootstrap }) {
  const [items, setItems] = useState<Connection[]>([]),
    [selected, setSelected] = useState<Connection | null>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [tools, setTools] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    void api<Connection[]>('/execution/connections', { signal: c.signal })
      .then((r) => {
        if (!c.signal.aborted) setItems(r.filter((v) => v.protocol === 'mcp'));
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : 'Remote connections unavailable.');
      });
    return () => c.abort();
  }, [revision]);
  useEffect(() => () => controller.current?.abort(), []);
  async function open(id: string) {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    const result = await api<Connection>('/execution/mcp/' + id, { signal: c.signal });
    if (!c.signal.aborted) {
      setSelected(result);
      setTools([]);
    }
  }
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setRevision((n) => n + 1);
      if (selected) await open(selected.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remote MCP action failed.');
    } finally {
      setBusy(false);
    }
  }
  const manage = boot.me.permissions?.['execution.manage'] !== false;
  return (
    <section aria-label="Remote MCP settings">
      <h3>Remote MCP connections</h3>
      <p>
        Discover a server, review its tool manifest, classify effects, and grant operations to each
        requester and agent.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {manage && (
        <form
          className="platform-form"
          onSubmit={(e) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget),
              form = e.currentTarget;
            void action(async () => {
              const r = await post<{ id: string }>('/execution/mcp', {
                name: v.get('name'),
                url: v.get('url'),
                conversationIds: v.getAll('conversationIds'),
                ...(v.get('token') ? { token: v.get('token') } : {}),
              });
              form.reset();
              await open(r.id);
            });
          }}
        >
          <label>
            Remote MCP name
            <Input name="name" required minLength={2} />
          </label>
          <label>
            MCP server URL
            <Input name="url" type="url" required placeholder="https://mcp.example/server" />
          </label>
          <label>
            Remote access token
            <Input name="token" type="password" autoComplete="new-password" />
          </label>
          <ConversationGrants boot={boot} />
          <Button variant="outline" disabled={busy}>
            Discover remote MCP server
          </Button>
        </form>
      )}
      {items.map((c) => (
        <Card key={c.id} asChild>
          <article className="work-card">
            <Button
              variant="outline"
              onClick={() =>
                void open(c.id).catch((e) =>
                  setError(e instanceof Error ? e.message : 'Connection unavailable.'),
                )
              }
            >
              {c.name}
            </Button>
            <p>
              {c.revoked_at ? 'Revoked' : c.health} · version {c.version}
            </p>
          </article>
        </Card>
      ))}
      {selected && (
        <section aria-label="Remote MCP connection details">
          <h4>{selected.name}</h4>
          <p>
            {selected.health} · version {selected.version}
          </p>
          {selected.owner_id === boot.me.id && !selected.revoked_at && (
            <>
              <div className="action-row">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await post('/execution/mcp/' + selected.id + '/refresh', {});
                    })
                  }
                >
                  Refresh MCP manifest
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await post('/execution/connections/' + selected.id + '/revoke', {});
                    })
                  }
                >
                  Revoke MCP connection
                </Button>
              </div>
              <form
                className="platform-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = new FormData(e.currentTarget);
                  void action(async () => {
                    await post('/execution/mcp/' + selected.id + '/publication', {
                      version: selected.version,
                      tools: tools.map((name) => ({ name, effect: v.get('effect:' + name) })),
                    });
                  });
                }}
              >
                <fieldset>
                  <legend>Review remote tools</legend>
                  {selected.mcp_manifest?.map((t) => (
                    <Card key={t.name} asChild>
                      <div className="work-card">
                        <label>
                          <Input
                            type="checkbox"
                            checked={tools.includes(t.name)}
                            onChange={(e) =>
                              setTools((old) =>
                                e.target.checked
                                  ? [...old, t.name]
                                  : old.filter((v) => v !== t.name),
                              )
                            }
                          />
                          {t.name}
                        </label>
                        <p>{t.description}</p>
                        <label>
                          Effect of {t.name}
                          <NativeSelect
                            name={'effect:' + t.name}
                            disabled={!tools.includes(t.name)}
                            required={tools.includes(t.name)}
                            defaultValue=""
                          >
                            <option value="" disabled>
                              Classify the operation
                            </option>
                            {toolEffects
                              .filter((e) => e !== 'execute')
                              .map((effect) => (
                                <option value={effect} key={effect}>
                                  {effect}
                                </option>
                              ))}
                          </NativeSelect>
                        </label>
                      </div>
                    </Card>
                  ))}
                </fieldset>
                <Button variant="outline" disabled={busy}>
                  Publish reviewed MCP tools
                </Button>
                <small>
                  Publication revokes previous member grants and invalidates pending approvals.
                </small>
              </form>
              <form
                className="platform-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = new FormData(e.currentTarget);
                  void action(async () => {
                    await post('/execution/connections/' + selected.id + '/grant', {
                      memberId: v.get('member'),
                      operations: v.getAll('operations'),
                      expiresAt: new Date(
                        Date.now() + Number(v.get('days')) * 86400000,
                      ).toISOString(),
                    });
                  });
                }}
              >
                <label>
                  MCP consumer
                  <NativeSelect name="member" required>
                    <option value="">Choose a member or agent</option>
                    {boot.members.map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.name} · {m.kind}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <fieldset>
                  <legend>Granted MCP operations</legend>
                  {selected.operations.map((o) => (
                    <label key={o.name}>
                      <Input type="checkbox" name="operations" value={o.name} />
                      {o.remoteName ?? o.name} · {o.effect}
                    </label>
                  ))}
                </fieldset>
                <label>
                  MCP grant lifetime in days
                  <Input name="days" type="number" min={1} max={90} defaultValue={30} required />
                </label>
                <Button variant="outline" disabled={busy}>
                  Grant MCP operations
                </Button>
              </form>
              <form
                className="platform-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = new FormData(e.currentTarget),
                    form = e.currentTarget;
                  void action(async () => {
                    await post('/execution/mcp/' + selected.id + '/credentials', {
                      version: selected.version,
                      token: v.get('token'),
                    });
                    form.reset();
                  });
                }}
              >
                <label>
                  Replacement remote access token
                  <Input name="token" type="password" autoComplete="new-password" />
                </label>
                <Button variant="outline" disabled={busy}>
                  Rotate MCP credentials
                </Button>
              </form>
            </>
          )}
        </section>
      )}
    </section>
  );
}
