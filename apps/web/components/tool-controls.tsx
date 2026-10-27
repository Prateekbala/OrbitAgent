'use client';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useEffect, useState } from 'react';
import { toolEffects, type ToolDefinition, type ToolRule } from '@ao/contracts/tools';
import type { Bootstrap } from '@ao/contracts';
import { api, post } from '../lib/api';
interface Connection {
  id: string;
  name: string;
  owner_id: string;
  endpoint: string;
  version: number;
  revoked_at: string | null;
  operations: { name: string; effect: string; description: string }[];
}
interface Policy {
  version: number;
  rules: Record<(typeof toolEffects)[number], ToolRule>;
}
export function ToolControls({ boot }: { boot: Bootstrap }) {
  const [registry, setRegistry] = useState<ToolDefinition[]>([]),
    [policy, setPolicy] = useState<Policy | null>(null),
    [connections, setConnections] = useState<Connection[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const admin = ['owner', 'admin'].includes(boot.me.role);
  async function load(signal?: AbortSignal) {
    const options = signal ? { signal } : {};
    const [r, c, p] = await Promise.all([
      api<ToolDefinition[]>('/execution/tools', options),
      api<Connection[]>('/execution/connections', options),
      admin ? api<Policy>('/execution/tool-policy', options) : Promise.resolve(null),
    ]);
    if (signal?.aborted) return;
    setRegistry(r);
    setConnections(c);
    setPolicy(p);
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, []);
  async function action(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save tool configuration.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="agent-controls">
      <h3>Tool registry</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <ul>
        {registry.map((t) => (
          <li key={t.name}>
            <strong>
              {t.name} · v{t.version}
            </strong>
            <p>
              {t.effect} · {t.permission} · {t.resource.replaceAll('_', ' ')} · {t.deadlineSeconds}s
              · {t.cost} cost
            </p>
          </li>
        ))}
      </ul>
      {policy && (
        <form
          key={policy.version}
          onSubmit={(e) => {
            e.preventDefault();
            const values = new FormData(e.currentTarget);
            const rules = Object.fromEntries(
              toolEffects.map((effect) => [
                effect,
                {
                  approval: values.get(effect),
                  independent: values.get(effect + '-independent') === 'on',
                  expiresInMinutes: Number(values.get(effect + '-expiry')),
                },
              ]),
            );
            void action(
              () =>
                api('/execution/tool-policy', {
                  method: 'PUT',
                  body: JSON.stringify({ version: policy.version, rules }),
                }),
              'Tool approval policy saved.',
            );
          }}
        >
          <fieldset disabled={busy}>
            <legend>Approval policy · version {policy.version}</legend>
            {toolEffects.map((effect) => (
              <div key={effect}>
                <label>
                  {effect}
                  <NativeSelect
                    aria-label={effect + ' approval'}
                    name={effect}
                    defaultValue={policy.rules[effect].approval}
                  >
                    <option value="admin">Administrator review</option>
                    <option value="owner">Workspace owner review</option>
                    <option value="deny">Deny operation</option>
                  </NativeSelect>
                </label>
                <label className="agent-checkrow">
                  <Input
                    type="checkbox"
                    name={effect + '-independent'}
                    defaultChecked={policy.rules[effect].independent}
                  />
                  Reviewer must differ from requester
                </label>
                <label>
                  Approval validity in minutes
                  <Input
                    name={effect + '-expiry'}
                    type="number"
                    min={1}
                    max={1440}
                    defaultValue={policy.rules[effect].expiresInMinutes}
                  />
                </label>
              </div>
            ))}
            <Button variant="outline">Save tool approval policy</Button>
          </fieldset>
        </form>
      )}
      <h3>Provider connections</h3>
      <p className="muted">
        Register a provider adapter on an operator-approved HTTPS host. It must implement durable
        idempotency and receipt lookup. Grant each operation separately to requesters and agents.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget,
            v = new FormData(form);
          void action(async () => {
            await post('/execution/connections', {
              name: v.get('name'),
              endpoint: v.get('endpoint'),
              secret: v.get('secret'),
              operations: JSON.parse(String(v.get('operations'))),
            });
            form.reset();
          }, 'Connection created.');
        }}
      >
        <fieldset disabled={busy}>
          <legend>Add owned connection</legend>
          <label>
            Connection name
            <Input name="name" required minLength={2} maxLength={100} />
          </label>
          <label>
            Adapter endpoint
            <Input
              name="endpoint"
              type="url"
              placeholder="https://adapter.example.com/orbit"
              required
            />
          </label>
          <label>
            Provider secret
            <Input
              name="secret"
              type="password"
              autoComplete="new-password"
              required
              minLength={16}
              maxLength={4000}
            />
          </label>
          <label>
            Registered operations
            <Textarea
              aria-label="Registered operations"
              name="operations"
              required
              defaultValue={
                '[{"name":"publish_document","effect":"publish","description":"Publish a reviewed document to the connected account"}]'
              }
            />
          </label>
          <Button variant="outline">Create provider connection</Button>
        </fieldset>
      </form>
      {connections.map((c) => (
        <article key={c.id}>
          <h4>
            {c.name} · v{c.version}
            {c.revoked_at ? ' · revoked' : ''}
          </h4>
          <p>{c.endpoint}</p>
          <ul>
            {c.operations.map((o) => (
              <li key={o.name}>
                {o.name} · {o.effect} · {o.description}
              </li>
            ))}
          </ul>
          {c.owner_id === boot.me.id && !c.revoked_at && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = new FormData(e.currentTarget);
                  void action(
                    () =>
                      post(`/execution/connections/${c.id}/grant`, {
                        memberId: v.get('member'),
                        operations: v.getAll('operation'),
                        expiresAt: new Date(String(v.get('expiry'))).toISOString(),
                      }),
                    'Operation grant saved.',
                  );
                }}
              >
                <fieldset disabled={busy}>
                  <legend>Authorize operation access</legend>
                  <label>
                    Requester or agent
                    <NativeSelect name="member" required>
                      {boot.members
                        .filter((m) => m.status !== 'suspended')
                        .map((m) => (
                          <option value={m.id} key={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </NativeSelect>
                  </label>
                  {c.operations.map((o) => (
                    <label key={o.name} className="agent-checkrow">
                      <Input type="checkbox" name="operation" value={o.name} />
                      {o.name}
                    </label>
                  ))}
                  <label>
                    Grant expires
                    <Input name="expiry" type="datetime-local" required />
                  </label>
                  <Button variant="outline">Grant selected operations</Button>
                </fieldset>
              </form>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = new FormData(e.currentTarget);
                  void action(
                    () =>
                      post(`/execution/connections/${c.id}/revoke`, { memberId: v.get('member') }),
                    'Member authorization revoked.',
                  );
                }}
              >
                <label>
                  Revoke member access
                  <NativeSelect name="member">
                    {boot.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <Button variant="outline" disabled={busy}>
                  Revoke member authorization
                </Button>
              </form>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget,
                    v = new FormData(form);
                  void action(async () => {
                    await post(`/execution/connections/${c.id}/rotate`, {
                      secret: v.get('secret'),
                    });
                    form.reset();
                  }, 'Connection credential rotated. Pending approvals are fenced.');
                }}
              >
                <label>
                  Replacement secret
                  <Input
                    type="password"
                    name="secret"
                    minLength={16}
                    maxLength={4000}
                    required
                    autoComplete="new-password"
                  />
                </label>
                <Button variant="outline" disabled={busy}>
                  Rotate connection secret
                </Button>
              </form>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(
                    () => post(`/execution/connections/${c.id}/revoke`, {}),
                    'Connection revoked.',
                  )
                }
              >
                Revoke entire connection
              </Button>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
