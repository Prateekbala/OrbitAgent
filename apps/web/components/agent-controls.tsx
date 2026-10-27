'use client';
import { Button } from './ui/button';
import { DeliverySourceControl } from './delivery-source-control';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Card } from './ui/card';
import { useCallback, useEffect, useState } from 'react';
import type { Agent, Bootstrap } from '@ao/contracts';
import {
  agentSkills,
  agentTools,
  credentialScopes,
  type AgentConfiguration,
  type AgentDetail,
  type AgentRevision,
  type AgentCredential,
} from '@ao/contracts/agents';
import { api, post } from '../lib/api';
import { Dialog } from './dialog';
import { PageControls } from './page-controls';
import { useCursorPage } from '../lib/use-cursor-page';

export function AgentControls({
  agent,
  boot,
  canManage,
  onClose,
}: {
  agent: Agent;
  boot: Bootstrap;
  canManage: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [secret, setSecret] = useState(''),
    [tab, setTab] = useState<'configuration' | 'credentials' | 'delivery' | 'history'>(
      'configuration',
    );
  const refresh = useCallback(
    async () => setDetail(await api<AgentDetail>(`/agents/${agent.id}`)),
    [agent.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    void api<AgentDetail>(`/agents/${agent.id}`, { signal: controller.signal })
      .then(setDetail)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [agent.id]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update the agent.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`${agent.name} · Agent controls`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <DeliverySourceControl scope="agent" resourceId={agent.id} />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {detail ? (
        <div className="agent-controls">
          <p>
            Revision {detail.revision} · {detail.status} · {detail.health.open_runs} open runs ·{' '}
            {detail.health.pending_deliveries} pending deliveries · {detail.health.dead_letters}{' '}
            dead letters
          </p>
          <p className="muted">
            {agent.runtime === 'managed'
              ? detail.runtime.configured
                ? 'Hosted runtime configured'
                : 'Hosted runtime unavailable'
              : detail.health.last_seen_at
                ? `Last receiver contact ${new Date(detail.health.last_seen_at).toLocaleString()}`
                : 'No receiver contact recorded'}
            . Durable recovery:{' '}
            {detail.runtime.capabilities.durableCheckpoints ? 'qualified' : 'not qualified'}.
          </p>
          <nav className="work-toolbar" aria-label="Agent settings">
            {(['configuration', 'credentials', 'delivery', 'history'] as const).map((value) => (
              <Button
                variant="outline"
                key={value}
                className="subtle-button"
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {value === 'delivery'
                  ? 'Delivery and webhooks'
                  : value[0]!.toUpperCase() + value.slice(1)}
              </Button>
            ))}
          </nav>
          {tab === 'configuration' && (
            <>
              <AgentConfigurationForm
                key={`${agent.id}:${detail.version}`}
                detail={detail}
                boot={boot}
                disabled={!canManage || busy || detail.status === 'archived'}
                onSave={(configuration) =>
                  action(() =>
                    post(`/agents/${agent.id}/revisions`, {
                      version: detail.version,
                      configuration,
                    }),
                  )
                }
              />
              {canManage && (
                <form
                  className="work-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void action(() =>
                      post(`/agents/${agent.id}/lifecycle`, {
                        version: detail.version,
                        status: data.get('status'),
                        ownerId: data.get('ownerId'),
                      }),
                    );
                  }}
                >
                  <h3>Ownership and lifecycle</h3>
                  <p className="muted">
                    Changes fence active work. Ownership transfers revoke credentials and pause the
                    agent. Archival preserves history.
                  </p>
                  <label>
                    Agent owner
                    <NativeSelect
                      aria-label="Agent owner"
                      name="ownerId"
                      defaultValue={detail.owner_id ?? ''}
                      required
                    >
                      {boot.members
                        .filter(
                          (member) =>
                            member.kind === 'human' &&
                            member.status !== 'suspended' &&
                            member.access_type !== 'guest',
                        )
                        .map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.name}
                          </option>
                        ))}
                    </NativeSelect>
                  </label>
                  <label>
                    Agent state
                    <NativeSelect
                      aria-label="Agent state"
                      name="status"
                      defaultValue={detail.status}
                    >
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                      <option value="archived">Archived</option>
                    </NativeSelect>
                  </label>
                  <Button className="primary" disabled={busy}>
                    Apply lifecycle change
                  </Button>
                </form>
              )}
            </>
          )}
          {tab === 'credentials' && (
            <>
              {secret && (
                <div role="status" className="runtime-notice">
                  <p>Save this credential now. It is shown once.</p>
                  <code className="agent-secret">{secret}</code>
                  <Button variant="outline" onClick={() => setSecret('')}>
                    Dismiss secret
                  </Button>
                </div>
              )}
              <CredentialHistory
                revision={detail.credentials.length}
                agentId={agent.id}
                canManage={canManage}
                busy={busy}
                action={action}
              />
              {canManage && agent.runtime === 'external' && detail.status !== 'archived' && (
                <form
                  className="work-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void action(async () => {
                      const result = await post<{ key: string }>(
                        `/agents/${agent.id}/credentials`,
                        {
                          name: data.get('name'),
                          scopes: data.getAll('scope'),
                          conversationIds: data.getAll('conversation'),
                          expiresInDays: Number(data.get('days')),
                        },
                      );
                      setSecret(result.key);
                    });
                  }}
                >
                  <h3>Create scoped credential</h3>
                  <label>
                    Credential name
                    <Input name="name" required minLength={2} maxLength={80} />
                  </label>
                  <label>
                    Expires in days
                    <Input name="days" type="number" min={1} max={90} defaultValue={30} required />
                  </label>
                  <fieldset>
                    <legend>Credential scopes</legend>
                    {credentialScopes.map((scope) => (
                      <label className="agent-check" key={scope}>
                        <Input
                          type="checkbox"
                          name="scope"
                          value={scope}
                          defaultChecked={scope === 'inbox.read' || scope === 'inbox.work'}
                        />
                        {scope}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend>Allowed conversations</legend>
                    <p className="muted">
                      Leave empty to use all conversations the agent can access.
                    </p>
                    {boot.channels.map((channel) => (
                      <label className="agent-check" key={channel.id}>
                        <Input type="checkbox" name="conversation" value={channel.id} />
                        {channel.title ?? channel.name}
                      </label>
                    ))}
                  </fieldset>
                  <Button disabled={busy} className="primary">
                    Create credential
                  </Button>
                </form>
              )}
            </>
          )}
          {tab === 'history' && <AgentRevisionHistory agentId={agent.id} />}
          {tab === 'delivery' && (
            <AgentDeliverySettings
              agentId={agent.id}
              canManage={canManage}
              action={action}
              busy={busy}
            />
          )}
        </div>
      ) : (
        <p>Loading agent controls…</p>
      )}
    </Dialog>
  );
}
function AgentConfigurationForm({
  detail,
  boot,
  disabled,
  onSave,
}: {
  detail: AgentDetail;
  boot: Bootstrap;
  disabled: boolean;
  onSave: (configuration: AgentConfiguration) => Promise<void>;
}) {
  const [draft, setDraft] = useState(detail.configuration);
  return (
    <form
      className="work-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(draft);
      }}
    >
      <h3>Versioned configuration</h3>
      <p className="muted">
        Saving creates an immutable revision and fences work using the previous revision.
      </p>
      <label>
        Agent instructions
        <Textarea
          aria-label="Agent instructions"
          required
          minLength={3}
          maxLength={12000}
          rows={5}
          value={draft.instructions}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
        />
      </label>
      <label>
        Model policy
        <Input
          value={draft.model}
          maxLength={150}
          required
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
        />
      </label>
      <small>Use operator_default or a model approved by the deployment operator.</small>
      <label>
        Activation
        <NativeSelect
          aria-label="Activation"
          value={draft.activation}
          onChange={(event) =>
            setDraft({
              ...draft,
              activation: event.target.value as AgentConfiguration['activation'],
            })
          }
        >
          <option value="mentions">Manual requests and mentions</option>
          <option value="manual">Manual requests only</option>
          <option value="disabled">Disabled</option>
        </NativeSelect>
      </label>
      <fieldset>
        <legend>Tool grants</legend>
        {agentTools.map((tool) => (
          <label className="agent-check" key={tool}>
            <Input
              type="checkbox"
              checked={draft.tools.includes(tool)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  tools: event.target.checked
                    ? [...draft.tools, tool]
                    : draft.tools.filter((value) => value !== tool),
                })
              }
            />
            {tool.replaceAll('_', ' ')}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Skill grants</legend>
        {agentSkills.map((skill) => (
          <label className="agent-check" key={skill}>
            <Input
              type="checkbox"
              checked={draft.skills.includes(skill)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  skills: event.target.checked
                    ? [...draft.skills, skill]
                    : draft.skills.filter((value) => value !== skill),
                })
              }
            />
            {skill}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Conversation activation</legend>
        <small>Empty selection permits all accessible conversations.</small>
        {boot.channels.map((channel) => (
          <label className="agent-check" key={channel.id}>
            <Input
              type="checkbox"
              checked={draft.conversationIds.includes(channel.id)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  conversationIds: event.target.checked
                    ? [...draft.conversationIds, channel.id]
                    : draft.conversationIds.filter((id) => id !== channel.id),
                })
              }
            />
            {channel.title ?? channel.name}
          </label>
        ))}
      </fieldset>
      <div className="work-form-grid">
        {(
          [
            ['maxSeconds', 'Maximum seconds', 10, 86400],
            ['maxInputTokens', 'Maximum input tokens', 1000, 200000],
            ['maxOutputTokens', 'Maximum output tokens', 100, 16000],
            ['maxTools', 'Maximum tool proposals', 0, 4],
            ['reservationMicros', 'Spending reservation (USD micros)', 1, 100000000],
          ] as const
        ).map(([key, label, min, max]) => (
          <label key={key}>
            {label}
            <Input
              type="number"
              min={min}
              max={max}
              required
              value={draft.limits[key]}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  limits: { ...draft.limits, [key]: Number(event.target.value) },
                })
              }
            />
          </label>
        ))}
      </div>
      <Button className="primary" disabled={disabled}>
        Save new agent revision
      </Button>
    </form>
  );
}
function AgentRevisionHistory({ agentId }: { agentId: string }) {
  const page = useCursorPage<AgentRevision>(agentId, `/agents/${agentId}/revisions`);
  return (
    <div>
      {page.items.map((revision) => (
        <Card key={revision.revision} asChild>
          <article className="work-card">
            <strong>Revision {revision.revision}</strong>
            <p>{revision.configuration.instructions}</p>
            <small>
              {revision.configuration.model} · {revision.configuration.activation} ·{' '}
              {new Date(revision.created_at).toLocaleString()}
            </small>
          </article>
        </Card>
      ))}
      <PageControls {...page} onMore={page.more} />
    </div>
  );
}
function AgentDeliverySettings({
  agentId,
  canManage,
  action,
  busy,
}: {
  agentId: string;
  canManage: boolean;
  action: (work: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [state, setState] = useState('dead'),
    [webhook, setWebhook] = useState<{ url: string; version: number; enabled: boolean } | null>(
      null,
    ),
    [secret, setSecret] = useState(''),
    [error, setError] = useState('');
  const page = useCursorPage<{
    id: string;
    state: string;
    attempts: number;
    summary: string | null;
  }>(agentId, `/agents/${agentId}/deliveries?state=${state}`);
  useEffect(() => {
    const controller = new AbortController();
    void api<typeof webhook>(`/agents/${agentId}/webhook`, { signal: controller.signal })
      .then(setWebhook)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [agentId]);
  return (
    <>
      <h3>External inbox deliveries</h3>
      <label>
        Delivery state
        <NativeSelect
          aria-label="Delivery state"
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          {['dead', 'expired', 'pending', 'leased', 'completed'].map((value) => (
            <option value={value} key={value}>
              {value}
            </option>
          ))}
        </NativeSelect>
      </label>
      {page.items.map((delivery) => (
        <Card key={delivery.id} asChild>
          <article className="work-card">
            <strong>
              {delivery.state} · {delivery.attempts} attempts
            </strong>
            <p>{delivery.summary ?? 'No completion summary'}</p>
            {canManage && ['dead', 'expired'].includes(delivery.state) && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await post(`/agents/${agentId}/deliveries/${delivery.id}/retry`, {});
                    await page.refresh();
                  })
                }
              >
                Retry delivery
              </Button>
            )}
          </article>
        </Card>
      ))}
      <PageControls {...page} onMore={page.more} />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <WakeupHistory agentId={agentId} canManage={canManage} action={action} busy={busy} />
      {canManage && (
        <form
          key={webhook?.version ?? 0}
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void action(async () => {
              const result = await api<{ signingSecret: string }>(`/agents/${agentId}/webhook`, {
                method: 'PUT',
                body: JSON.stringify({
                  url: data.get('url'),
                  enabled: data.get('enabled') === 'on',
                  version: webhook?.version ?? 0,
                }),
              });
              setSecret(result.signingSecret);
              setWebhook(await api(`/agents/${agentId}/webhook`));
            });
          }}
        >
          <h3>Signed wake-up webhook</h3>
          <p className="muted">
            Use an HTTPS endpoint on a host approved by your operator. Saving rotates the signing
            secret.
          </p>
          <label>
            Webhook URL
            <Input name="url" type="url" required defaultValue={webhook?.url ?? ''} />
          </label>
          <label className="agent-check">
            <Input name="enabled" type="checkbox" defaultChecked={webhook?.enabled ?? true} />
            Enabled
          </label>
          <Button className="primary" disabled={busy}>
            Save webhook and rotate secret
          </Button>
          {secret && (
            <div role="status">
              <p>Save this signing secret now:</p>
              <code className="agent-secret">{secret}</code>
              <Button variant="outline" type="button" onClick={() => setSecret('')}>
                Dismiss signing secret
              </Button>
            </div>
          )}
        </form>
      )}
    </>
  );
}

function CredentialHistory({
  agentId,
  canManage,
  busy,
  action,
  revision,
}: {
  agentId: string;
  canManage: boolean;
  busy: boolean;
  revision: number;
  action: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const page = useCursorPage<AgentCredential>(
    canManage ? agentId : null,
    `/agents/${agentId}/credentials`,
    revision,
  );
  return (
    <>
      {page.items.map((credential) => (
        <Card key={credential.id} asChild>
          <article className="work-card">
            <strong>{credential.name}</strong>
            <p>{credential.scopes.join(', ')}</p>
            <small>
              Expires {new Date(credential.expires_at).toLocaleString()} ·{' '}
              {credential.revoked_at ? 'Revoked' : 'Not revoked'}
            </small>
            {canManage && !credential.revoked_at && (
              <Button
                variant="outline"
                className="subtle-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api(`/agents/${agentId}/credentials/${credential.id}`, {
                      method: 'DELETE',
                    });
                    await page.refresh();
                  })
                }
              >
                Revoke {credential.name}
              </Button>
            )}
          </article>
        </Card>
      ))}
      <PageControls {...page} onMore={page.more} />
    </>
  );
}

function WakeupHistory({
  agentId,
  canManage,
  busy,
  action,
}: {
  agentId: string;
  canManage: boolean;
  busy: boolean;
  action: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const page = useCursorPage<{
    id: string;
    state: string;
    attempts: number;
    error_code: string | null;
  }>(agentId, `/agents/${agentId}/wakeups`);
  return (
    <section aria-label="Webhook delivery history">
      <h3>Webhook delivery history</h3>
      {page.items.map((wakeup) => (
        <Card key={wakeup.id} asChild>
          <article className="work-card">
            <strong>
              {wakeup.state} · {wakeup.attempts} attempts
            </strong>
            {wakeup.error_code && <p>{wakeup.error_code}</p>}
            {canManage && wakeup.state === 'dead' && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await post(`/agents/${agentId}/wakeups/${wakeup.id}/retry`, {});
                    await page.refresh();
                  })
                }
              >
                Retry webhook wake-up
              </Button>
            )}
          </article>
        </Card>
      ))}
      <PageControls {...page} onMore={page.more} />
    </section>
  );
}
