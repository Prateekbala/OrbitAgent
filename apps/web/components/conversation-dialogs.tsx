'use client';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
import { useEffect, useState } from 'react';
import type { Bootstrap, Channel, ConversationDetails } from '@ao/contracts';
import type { HistoryProposal } from '@ao/contracts/personal';
import type { ActivitySnapshot } from '@ao/contracts';
import { PresenceDot } from './activity';
import { Dialog } from './dialog';
import { api, post } from '../lib/api';
export function NewConversationDialog({
  boot,
  onClose,
  onCreated,
}: {
  boot: Bootstrap;
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<'direct' | 'group'>('direct'),
    [selected, setSelected] = useState<string[]>([]),
    [historyPolicy, setHistoryPolicy] = useState<'retained' | 'join_time'>('join_time'),
    [title, setTitle] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const members = boot.members.filter((member) => member.id !== boot.me.id);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await post<{ id: string }>(
        `/conversations/${kind === 'direct' ? 'direct' : 'groups'}`,
        kind === 'direct'
          ? { membershipId: selected[0] }
          : { title, membershipIds: selected, historyPolicy },
      );
      await onCreated(result.id);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to create conversation.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="New conversation" onClose={onClose}>
      <form className="conversation-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy}>
          <legend>Conversation type</legend>
          <label>
            <Input
              type="radio"
              name="kind"
              checked={kind === 'direct'}
              onChange={() => {
                setKind('direct');
                setSelected([]);
              }}
            />{' '}
            Direct message
          </label>
          <label>
            <Input
              type="radio"
              name="kind"
              checked={kind === 'group'}
              onChange={() => {
                setKind('group');
                setSelected([]);
              }}
            />{' '}
            Private group
          </label>
        </fieldset>
        {kind === 'group' && (
          <label>
            Group name
            <Input
              required
              maxLength={100}
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        )}
        <fieldset className="participant-picker" disabled={busy}>
          <legend>{kind === 'direct' ? 'Choose a teammate' : 'Choose participants'}</legend>
          {members.map((member) => (
            <label key={member.id}>
              <Input
                type={kind === 'direct' ? 'radio' : 'checkbox'}
                name="participant"
                checked={selected.includes(member.id)}
                onChange={(event) =>
                  setSelected(
                    kind === 'direct'
                      ? [member.id]
                      : event.target.checked
                        ? [...selected, member.id]
                        : selected.filter((id) => id !== member.id),
                  )
                }
              />
              <span>
                {member.name}
                {member.kind === 'agent' ? ' · Agent' : ''}
              </span>
            </label>
          ))}
          {!members.length && <p>Invite a teammate or add an agent to start a conversation.</p>}
        </fieldset>
        {kind === 'group' ? (
          <label>
            History for new participants
            <NativeSelect
              value={historyPolicy}
              onChange={(e) => setHistoryPolicy(e.target.value as typeof historyPolicy)}
            >
              <option value="join_time">From join time</option>
              <option value="retained">Earlier history, with participant consent</option>
            </NativeSelect>
          </label>
        ) : null}
        <p className="muted">
          Only participants can access this conversation. Sharing earlier private group history
          requires existing participants’ consent.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button
          className="primary"
          disabled={
            busy || !selected.length || selected.length > 49 || (kind === 'group' && !title.trim())
          }
        >
          {busy ? 'Opening…' : 'Start conversation'}
        </Button>
      </form>
    </Dialog>
  );
}
export function ConversationDetailsDialog({
  channel,
  presence,
  boot,
  onClose,
  onChanged,
}: {
  channel: Channel;
  presence: ActivitySnapshot['presence'];
  boot: Bootstrap;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [details, setDetails] = useState<ConversationDetails | null>(null),
    [title, setTitle] = useState(''),
    [newMember, setNewMember] = useState(''),
    [historyAccess, setHistoryAccess] = useState<'retained' | 'join_time'>('join_time'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<ConversationDetails>(`/conversations/${channel.id}`, { signal: controller.signal })
      .then((result) => {
        setDetails(result);
        setTitle(result.title ?? '');
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Unable to load participants.');
      });
    return () => controller.abort();
  }, [channel]);
  const proposalPage = useCursorPage<HistoryProposal>(
    channel.kind === 'group' ? `${boot.workspace.id}:${boot.me.id}` : null,
    `/conversations/${channel.id}/history-proposals`,
    channel.version,
  );
  const proposals = proposalPage.items;
  useEffect(() => {
    if (channel.kind !== 'group') return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void proposalPage.refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [channel.id, channel.kind, proposalPage.refresh]);
  async function consent(decision: 'approve' | 'reject', proposal: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/conversations/${channel.id}/history-proposals/${proposal}/vote`, {
        method: 'PUT',
        body: JSON.stringify({ decision }),
      });
      await proposalPage.refresh();
      setDetails(await api<ConversationDetails>(`/conversations/${channel.id}`));
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to record consent.');
    } finally {
      setBusy(false);
    }
  }
  const isOwner = details?.participants.some(
    (member) => member.id === boot.me.id && member.role === 'owner',
  );
  async function change(
    input:
      | { title: string }
      | { historyPolicy: 'retained' | 'join_time' }
      | {
          member: {
            membershipId: string;
            action: 'add' | 'remove' | 'promote' | 'demote';
            historyAccess?: 'retained' | 'join_time';
          };
        },
  ) {
    if (!details || busy) return;
    setBusy(true);
    setError('');
    try {
      if (
        'member' in input &&
        input.member.action === 'add' &&
        input.member.historyAccess === 'retained'
      ) {
        await post(`/conversations/${channel.id}/history-proposals`, {
          version: details.version,
          membershipId: input.member.membershipId,
        });
        await proposalPage.refresh();
      } else
        await api(`/conversations/${channel.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ version: details.version, ...input }),
        });
      if (
        'member' in input &&
        input.member.action === 'remove' &&
        input.member.membershipId === boot.me.id
      ) {
        onClose();
        await onChanged();
        return;
      }
      const result = await api<ConversationDetails>(`/conversations/${channel.id}`);
      setDetails(result);
      setTitle(result.title ?? '');
      setNewMember('');
      await onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update group.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={channel.kind === 'group' ? 'Group details' : 'Conversation participants'}
      onClose={onClose}
    >
      {details && (
        <div className="conversation-form">
          {channel.kind === 'group' && isOwner && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void change({ title });
              }}
            >
              <label>
                Group name
                <Input
                  required
                  disabled={busy}
                  maxLength={100}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <Button
                variant="outline"
                className="subtle-button"
                disabled={busy || !title.trim() || title === details.title}
              >
                Save group name
              </Button>
            </form>
          )}
          <ul className="group-participants" aria-label="Conversation participants">
            {details.participants.map((member) => (
              <li key={member.id}>
                <span>
                  <strong>
                    {member.name}{' '}
                    {member.kind === 'human' && (
                      <PresenceDot
                        name={member.name}
                        state={
                          presence.find((person) => person.membership_id === member.id)?.state ??
                          'offline'
                        }
                      />
                    )}
                  </strong>
                  <small>
                    {member.kind === 'agent'
                      ? 'Agent'
                      : member.role === 'owner'
                        ? 'Group owner'
                        : 'Participant'}
                    {member.status !== 'active' ? ' · Suspended' : ''}
                  </small>
                </span>
                {channel.kind === 'group' && isOwner && (
                  <div>
                    {member.kind === 'human' && member.status === 'active' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        aria-label={`${member.role === 'owner' ? 'Remove owner role from' : 'Make group owner'} ${member.name}`}
                        onClick={() =>
                          void change({
                            member: {
                              membershipId: member.id,
                              action: member.role === 'owner' ? 'demote' : 'promote',
                            },
                          })
                        }
                      >
                        {member.role === 'owner' ? 'Demote' : 'Make owner'}
                      </Button>
                    )}
                    {member.id !== boot.me.id && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        aria-label={`Remove ${member.name} from group`}
                        onClick={() =>
                          void change({ member: { membershipId: member.id, action: 'remove' } })
                        }
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {channel.kind === 'group' && isOwner && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void change({ member: { membershipId: newMember, action: 'add', historyAccess } });
              }}
            >
              <label>
                Add participant
                <NativeSelect
                  required
                  disabled={busy}
                  value={newMember}
                  onChange={(event) => setNewMember(event.target.value)}
                >
                  <option value="">Choose a teammate</option>
                  {boot.members
                    .filter(
                      (member) =>
                        !details.participants.some((existing) => existing.id === member.id),
                    )
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                </NativeSelect>
              </label>
              <label>
                History access
                <NativeSelect
                  value={historyAccess}
                  onChange={(e) => setHistoryAccess(e.target.value as typeof historyAccess)}
                >
                  <option value="join_time">New messages from joining</option>
                  <option value="retained">Share earlier history with consent</option>
                </NativeSelect>
              </label>
              <p className="muted">
                Sharing earlier context, including messages, tasks and files, requires every active
                human participant to approve. Audience changes cancel pending agent execution.
              </p>
              <Button
                disabled={busy || !newMember || details.participants.length >= 50}
                className="primary"
              >
                {historyAccess === 'retained' ? 'Request history consent' : 'Add participant'}
              </Button>
            </form>
          )}
          {channel.kind === 'group' && isOwner ? (
            <label>
              Default history for future participants
              <NativeSelect
                value={details.history_policy ?? 'join_time'}
                disabled={busy}
                onChange={(event) =>
                  void change({ historyPolicy: event.target.value as 'retained' | 'join_time' })
                }
              >
                <option value="join_time">From joining</option>
                <option value="retained">Earlier history with consent</option>
              </NativeSelect>
            </label>
          ) : null}
          {proposals.map((proposal) => (
            <Card key={proposal.id} asChild>
              <article className="personal-message-card">
                <strong>Share earlier history with {proposal.target_name}</strong>
                <p>
                  {proposal.approved} of {proposal.required} approvals · {proposal.status}
                </p>
                {proposal.status === 'pending' && !proposal.my_decision ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void consent('approve', proposal.id)}
                    >
                      Approve history sharing
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void consent('reject', proposal.id)}
                    >
                      Reject history sharing
                    </Button>
                  </>
                ) : null}
              </article>
            </Card>
          ))}
          {channel.kind === 'group' && (
            <PageControls {...proposalPage} onMore={proposalPage.more} />
          )}
          {channel.kind === 'group' && (
            <Button
              variant="outline"
              className="danger-button"
              disabled={busy}
              onClick={() =>
                void change({ member: { membershipId: boot.me.id, action: 'remove' } })
              }
            >
              Leave group
            </Button>
          )}
          {channel.kind === 'direct' && (
            <p className="muted">
              Direct messages are shared only between these two teammates. Start a private group to
              include more people.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
