'use client';
import { WorkspaceHeading } from './workspace-heading';
import { Globe2 } from 'lucide-react';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { SharedChannelComposer } from './shared-channel-composer';
import { useEffect, useRef, useState } from 'react';
import type { Bootstrap, Message } from '@ao/contracts';
import type { SharedPolicy } from '@ao/contracts/interoperability';
import { api, post } from '../lib/api';
import { RichMessage } from './rich-message';
interface Grant {
  id: string;
  workspace_id: string;
  conversation_id: string;
  name: string;
  host_organization_name: string;
  external_organization_name: string;
  organization_id: string;
  policy: SharedPolicy;
  state: string;
  version: number;
}
interface Preview {
  id: string;
  policy: SharedPolicy;
  host_organization_name: string;
  name: string;
}
export function SharedChannelHub({
  boot,
  onOpen,
}: {
  boot: Bootstrap;
  onOpen: (id: string) => void;
}) {
  const [grants, setGrants] = useState<Grant[]>([]),
    [selected, setSelected] = useState(''),
    [messages, setMessages] = useState<Message[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [token, setToken] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [invitation, setInvitation] = useState(''),
    [members, setMembers] = useState<string[]>([boot.me.id]),
    [older, setOlder] = useState<number | null>(null),
    [thread, setThread] = useState<string | null>(null);
  const [participants, setParticipants] = useState<
    { source_membership_id: string; name: string; current: boolean }[]
  >([]);
  const loadedLow = useRef<number | null>(null);
  useEffect(() => {
    loadedLow.current = null;
    setMessages([]);
    setOlder(null);
  }, [selected, thread]);
  const grant = grants.find((g) => g.id === selected),
    admin = ['owner', 'admin'].includes(boot.me.role) && boot.me.access_type === 'member';
  useEffect(() => {
    const controller = new AbortController();
    api<Grant[]>('/shared-channels', { signal: controller.signal })
      .then(setGrants)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!selected || !grant || grant.workspace_id === boot.workspace.id || grant.state !== 'active')
      return;
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const boundary = loadedLow.current;
        let rows = await api<Message[]>(
          '/shared-channels/' + selected + '/messages' + (thread ? '?threadId=' + thread : ''),
          { signal: controller.signal },
        );
        let page = rows;
        while (boundary !== null && page.length === 100 && page.at(-1)!.sequence > boundary) {
          page = await api<Message[]>(
            '/shared-channels/' +
              selected +
              '/messages?before=' +
              page.at(-1)!.sequence +
              (thread ? '&threadId=' + thread : ''),
            { signal: controller.signal },
          );
          rows = [...rows, ...page];
        }
        if (controller.signal.aborted) return;
        if (boundary !== loadedLow.current) {
          loading = false;
          void load();
          return;
        }
        loadedLow.current = rows.at(-1)?.sequence ?? null;
        setMessages(rows.slice().reverse());
        setOlder(page.length === 100 ? page.at(-1)!.sequence : null);
      } catch (e) {
        if (!controller.signal.aborted) {
          setMessages([]);
          setError(e instanceof Error ? e.message : 'Channel unavailable.');
        }
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [selected, grant?.workspace_id, grant?.state, boot.workspace.id, thread, revision]);
  useEffect(() => {
    setParticipants([]);
    if (!selected || !admin) return;
    const controller = new AbortController();
    api<{ source_membership_id: string; name: string; current: boolean }[]>(
      '/shared-channels/' + selected + '/participants',
      { signal: controller.signal },
    )
      .then((rows) => {
        setParticipants(rows);
        setMembers(rows.map((r) => r.source_membership_id));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [selected, admin, revision]);
  async function run(work: () => Promise<unknown>, refresh = true) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      if (refresh) setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="view-padding platform-view shared-channel-page">
      <WorkspaceHeading
        icon={Globe2}
        eyebrow="Work beyond your workspace"
        title="Shared channels"
        description="Bring organizations together in a shared conversation, with explicit participation and clear boundaries."
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {admin && (
        <>
          <section className="platform-card">
            <h3>Invite an organization</h3>
            <form
              className="platform-form"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void run(async () => {
                  const result = await post<{ token: string }>('/shared-channels/invitations', {
                    conversationId: data.get('conversationId'),
                    organizationId: data.get('organizationId'),
                    policy: {
                      history: data.get('history'),
                      retentionDays: Number(data.get('retentionDays')),
                      export: data.get('export') === 'on',
                      agents: data.get('agents') === 'on',
                      recording: false,
                    },
                  });
                  setInvitation(result.token);
                });
              }}
            >
              <label>
                Private host channel
                <NativeSelect required name="conversationId">
                  <option value="">Choose a channel</option>
                  {boot.channels
                    .filter((c) => c.kind === 'channel' && c.visibility === 'private')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </NativeSelect>
              </label>
              <label>
                External organization ID
                <Input required name="organizationId" placeholder="Organization UUID" />
              </label>
              <label>
                History agreement
                <NativeSelect name="history">
                  <option value="join_time">Only messages after joining</option>
                  <option value="retained">All retained channel history</option>
                </NativeSelect>
              </label>
              <label>
                Retention in days
                <Input
                  required
                  type="number"
                  min={1}
                  max={3650}
                  name="retentionDays"
                  defaultValue={365}
                />
              </label>
              <label>
                <Input type="checkbox" name="export" />
                Allow channel exports
              </label>
              <label>
                <Input type="checkbox" name="agents" />
                Allow host agents to participate
              </label>
              <p>
                Recording is disabled. All organizations must accept identical terms. Policy changes
                require a fresh invitation.
              </p>
              <label>
                <Input type="checkbox" required />I reviewed the channel audience and authorize
                sharing the agreed history.
              </label>
              <Button className="primary" disabled={busy}>
                Create external invitation
              </Button>
            </form>
            {invitation && (
              <p>
                Share this invitation token with the external organization administrator:{' '}
                <output className="one-time-secret">{invitation}</output>
                <Button variant="outline" onClick={() => setInvitation('')}>
                  Hide token
                </Button>
              </p>
            )}
          </section>
          <section className="platform-card">
            <h3>Accept an organization invitation</h3>
            <label>
              Invitation token
              <Input
                value={token}
                autoComplete="off"
                onChange={(e) => {
                  setToken(e.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <Button
              variant="outline"
              disabled={busy || !token}
              onClick={() =>
                void run(async () =>
                  setPreview(await post<Preview>('/shared-channels/preview', { token })),
                )
              }
            >
              Review proposed agreement
            </Button>
            {preview && (
              <>
                <h4>
                  {preview.name} · {preview.host_organization_name}
                </h4>
                <p>
                  {preview.policy.history === 'retained'
                    ? 'All retained history'
                    : 'History after joining'}{' '}
                  · {preview.policy.retentionDays} days · exports{' '}
                  {preview.policy.export ? 'allowed' : 'disabled'} · agents{' '}
                  {preview.policy.agents ? 'allowed' : 'disabled'} · recording disabled
                </p>
                <fieldset>
                  <legend>Explicit participants from this workspace</legend>
                  {boot.members
                    .filter((m) => m.kind === 'human')
                    .map((m) => (
                      <label key={m.id}>
                        <Input
                          type="checkbox"
                          checked={members.includes(m.id)}
                          onChange={(e) =>
                            setMembers((current) =>
                              e.target.checked
                                ? [...current, m.id]
                                : current.filter((id) => id !== m.id),
                            )
                          }
                        />
                        {m.name}
                      </label>
                    ))}
                </fieldset>
                <Button
                  className="primary"
                  disabled={busy || !members.length}
                  onClick={() =>
                    void run(async () => {
                      const result = await post<{ id: string }>('/shared-channels/accept', {
                        token,
                        policy: preview.policy,
                        membershipIds: members,
                      });
                      setSelected(result.id);
                      setToken('');
                      setPreview(null);
                    })
                  }
                >
                  Accept agreement and grant participation
                </Button>
              </>
            )}
          </section>
        </>
      )}
      <section className="platform-card">
        <h3>Participating channels</h3>
        {grants.length === 0 && <p>No shared channels.</p>}
        {grants.map((g) => (
          <Button
            variant="outline"
            key={g.id}
            className={selected === g.id ? 'selected' : ''}
            onClick={() => {
              setSelected(g.id);
              setThread(null);
            }}
          >
            {g.name} · {g.host_organization_name} ↔ {g.external_organization_name} · {g.state}
          </Button>
        ))}
      </section>
      {grant && (
        <section className="platform-card">
          <h3>{grant.name}</h3>
          <p>
            {grant.policy.retentionDays} days ·{' '}
            {grant.policy.history === 'retained' ? 'Retained history' : 'Join-time history'} ·
            exports {grant.policy.export ? 'allowed' : 'disabled'} · recording disabled
          </p>
          {admin && (
            <Button
              variant="outline"
              disabled={busy || grant.state === 'revoked'}
              onClick={() =>
                void run(() =>
                  post('/shared-channels/' + grant.id + '/revoke', { version: grant.version }),
                )
              }
            >
              Revoke organization participation
            </Button>
          )}
          {participants.length > 0 && (
            <p>
              External participants:{' '}
              {participants.map((p) => p.name + (p.current ? '' : ' (access inactive)')).join(', ')}
            </p>
          )}
          {admin && grant.workspace_id !== boot.workspace.id && grant.state === 'active' && (
            <fieldset>
              <legend>Manage this organization's participants</legend>
              {boot.members
                .filter((m) => m.kind === 'human')
                .map((m) => (
                  <label key={m.id}>
                    <Input
                      type="checkbox"
                      checked={members.includes(m.id)}
                      onChange={(e) =>
                        setMembers((current) =>
                          e.target.checked
                            ? [...current, m.id]
                            : current.filter((id) => id !== m.id),
                        )
                      }
                    />
                    {m.name}
                  </label>
                ))}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api('/shared-channels/' + grant.id + '/participants', {
                      method: 'PUT',
                      body: JSON.stringify({ version: grant.version, membershipIds: members }),
                    }),
                  )
                }
              >
                Update participation grants
              </Button>
            </fieldset>
          )}
          {grant.workspace_id === boot.workspace.id ? (
            <Button variant="outline" onClick={() => onOpen(grant.conversation_id)}>
              Open host channel
            </Button>
          ) : (
            grant.state === 'active' && (
              <>
                {thread && (
                  <Button variant="outline" onClick={() => setThread(null)}>
                    Back to channel
                  </Button>
                )}
                {older && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const rows = await api<Message[]>(
                          '/shared-channels/' +
                            selected +
                            '/messages?before=' +
                            older +
                            (thread ? '&threadId=' + thread : ''),
                        );
                        loadedLow.current = rows.at(-1)?.sequence ?? loadedLow.current;
                        setMessages((current) => [...rows.slice().reverse(), ...current]);
                        setOlder(rows.length === 100 ? rows.at(-1)!.sequence : null);
                      }, false)
                    }
                  >
                    Load older messages
                  </Button>
                )}
                <div className="shared-message-list" aria-live="polite">
                  {messages.map((m) => (
                    <article key={m.id}>
                      <strong>{m.author_name}</strong>
                      {m.external_organization && (
                        <span> · {m.external_organization.organizationName} (external)</span>
                      )}
                      <time dateTime={m.created_at}>
                        {' '}
                        · {new Date(m.created_at).toLocaleString()}
                      </time>
                      {m.deleted_at ? (
                        <p>Message deleted</p>
                      ) : (
                        <RichMessage body={m.body} format={m.format} />
                      )}
                      {!m.deleted_at &&
                        m.attachments?.map((file) => (
                          <p key={file.id}>
                            <a
                              href={
                                '/api/v1/shared-channels/' +
                                selected +
                                '/files/' +
                                file.id +
                                '/content'
                              }
                              download
                            >
                              {file.name}
                            </a>
                          </p>
                        ))}
                      {!thread && (
                        <Button variant="outline" onClick={() => setThread(m.id)}>
                          {m.reply_count} replies
                        </Button>
                      )}
                    </article>
                  ))}
                </div>
                <SharedChannelComposer
                  key={selected + ':' + (thread ?? 'root')}
                  grantId={selected}
                  threadId={thread}
                  onSent={() => setRevision((v) => v + 1)}
                  onError={setError}
                />
              </>
            )
          )}
        </section>
      )}
    </div>
  );
}
