'use client';
import { WorkspaceHeading } from './workspace-heading';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus, ShieldCheck, Users, X } from 'lucide-react';
import type { Bootstrap, Invitation, TeamMember, WorkspaceMembership } from '@ao/contracts';
import { api, post } from '../lib/api';
import { Avatar } from './primitives';
import { Dialog } from './dialog';
import { MemberAccessEditor } from './member-access-editor';
export function TeamView({ boot, onChange }: { boot: Bootstrap; onChange: () => Promise<void> }) {
  const memberPage = useCursorPage<TeamMember>(
    `${boot.workspace.id}:${boot.me.id}`,
    '/collections/members',
  );
  const invitationPage = useCursorPage<Invitation>(
    ['owner', 'admin'].includes(boot.me.role) ? `${boot.workspace.id}:${boot.me.id}` : null,
    '/collections/invitations',
  );
  const members = memberPage.items,
    invites = invitationPage.items;
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [inviteOpen, setInviteOpen] = useState(false),
    [link, setLink] = useState(''),
    [copied, setCopied] = useState(false),
    [edit, setEdit] = useState<TeamMember | null>(null);
  const canManage = boot.me.kind === 'human' && ['owner', 'admin'].includes(boot.me.role),
    owner = boot.me.role === 'owner';
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const options = signal ? { signal } : {};
        const [, , spaces] = await Promise.all([
          memberPage.refresh(),
          canManage ? invitationPage.refresh() : Promise.resolve(),
          api<WorkspaceMembership[]>('/workspaces', options),
        ]);
        if (!signal?.aborted) {
          setWorkspaces(spaces);
        }
      } catch (error) {
        if (!signal?.aborted)
          setError(error instanceof Error ? error.message : 'Unable to load the team.');
      }
    },
    [canManage, memberPage.refresh, invitationPage.refresh],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, boot]);
  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const result = await post<{ token: string }>('/invitations', {
        email: form.get('email'),
        role: form.get('role'),
        accessType: form.get('accessType'),
        conversationIds: form.getAll('conversationIds'),
      });
      setLink(`${window.location.origin}/invite#${result.token}`);
      setCopied(false);
      setInviteOpen(false);
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to create invitation.');
    } finally {
      setBusy(false);
    }
  }
  async function update(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api(`/members/${edit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          role: form.get('role'),
          status: form.get('status'),
          version: edit.version,
        }),
      });
      setEdit(null);
      await Promise.all([refresh(), onChange()]);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update member.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function resend(id: string) {
    setBusy(true);
    setError('');
    try {
      await post(`/invitations/${id}/resend`, {});
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to resend invitation.');
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError('');
    try {
      await post(`/invitations/${id}/revoke`, {});
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to revoke invitation.');
    } finally {
      setBusy(false);
    }
  }
  async function switchWorkspace(membershipId: string) {
    setBusy(true);
    setError('');
    try {
      await post('/workspaces/switch', { membershipId });
      window.location.assign('/app');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to switch workspace.');
      setBusy(false);
    }
  }
  return (
    <section className="page-content team-view">
      <div className="execution-heading">
        <WorkspaceHeading
          icon={Users}
          eyebrow="Good work is a team effort"
          title="Members & invitations"
          description="Bring people together, manage roles, and keep workspace access clear."
        />
        {canManage && (
          <Button
            size="sm"
            className="primary small"
            onClick={() => {
              setInviteOpen(true);
              setError('');
            }}
          >
            <Plus size={15} />
            Invite teammate
          </Button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {workspaces.length > 1 && (
        <label className="workspace-switcher">
          Current workspace
          <NativeSelect
            aria-label="Current workspace"
            value={boot.me.id}
            disabled={busy}
            onChange={(event) => void switchWorkspace(event.target.value)}
          >
            {workspaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name} · {space.role}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
      <Card asChild>
        <div className="team-list">
          {members.map((member) => (
            <article className="team-row" key={member.id}>
              <Avatar name={member.name} agent={member.kind === 'agent'} />
              <div>
                <strong>
                  {member.name}
                  {member.id === boot.me.id ? ' (you)' : ''}
                </strong>
                <small>
                  {member.kind === 'agent' ? 'Agent' : member.role} · {member.status}
                </small>
              </div>
              <Badge variant="outline" className={`state ${member.status}`}>
                {member.status}
              </Badge>
              {canManage && member.kind === 'human' && (owner || member.role === 'member') && (
                <Button
                  variant="outline"
                  className="subtle-button"
                  aria-label={`Manage ${member.name}`}
                  onClick={() => {
                    setEdit(member);
                    setError('');
                  }}
                >
                  Manage
                </Button>
              )}
            </article>
          ))}
        </div>
      </Card>
      <PageControls {...memberPage} onMore={memberPage.more} />
      {canManage && (
        <>
          <h3 className="section-title">Invitations</h3>
          <p className="muted team-caption">
            Invitations expire after seven days. Share the private link with the intended recipient.
            An email is queued automatically. Resending replaces the previous link.
          </p>
          <Card asChild>
            <div className="team-list">
              {invites.length === 0 ? (
                <div className="team-empty">
                  <Users size={21} />
                  <p>No invitations yet.</p>
                </div>
              ) : (
                invites.map((invite) => (
                  <article key={invite.id} className="team-row">
                    <div>
                      <strong>{invite.email}</strong>
                      <small>
                        {invite.role} · expires {new Date(invite.expires_at).toLocaleDateString()}
                        {' · email '}
                        {invite.delivery_status === 'sent'
                          ? 'accepted by provider'
                          : invite.delivery_status === 'outcome_unknown'
                            ? 'delivery uncertain; resend to replace the link'
                            : (invite.delivery_status ?? 'not queued')}
                      </small>
                    </div>
                    <Badge variant="outline" className="state">
                      {invite.status === 'pending' &&
                      new Date(invite.expires_at).getTime() <= Date.now()
                        ? 'expired'
                        : invite.status}
                    </Badge>
                    {invite.status === 'pending' && (owner || invite.role === 'member') && (
                      <Button
                        variant="outline"
                        className="subtle-button"
                        disabled={busy}
                        onClick={() => void resend(invite.id)}
                      >
                        Resend email
                      </Button>
                    )}
                    {invite.status === 'pending' && (owner || invite.role === 'member') && (
                      <Button
                        variant="outline"
                        className="subtle-button"
                        disabled={busy}
                        onClick={() => void revoke(invite.id)}
                      >
                        <X size={13} />
                        Revoke
                      </Button>
                    )}
                  </article>
                ))
              )}
            </div>
          </Card>
        </>
      )}
      {canManage && <PageControls {...invitationPage} onMore={invitationPage.more} />}
      {inviteOpen && (
        <Dialog title="Invite a teammate" onClose={() => setInviteOpen(false)}>
          <form onSubmit={invite}>
            <label>
              Email address
              <Input type="email" name="email" required maxLength={254} />
            </label>
            <label>
              Workspace role
              <NativeSelect name="role" aria-label="Workspace role">
                <option value="member">Member</option>
                {owner && <option value="admin">Administrator</option>}
              </NativeSelect>
            </label>
            <label>
              Account access
              <NativeSelect name="accessType">
                <option value="member">Full member</option>
                <option value="guest">Guest</option>
              </NativeSelect>
            </label>
            <fieldset>
              <legend>Share conversations with guest</legend>
              {boot.channels
                .filter((c) => c.kind === 'channel')
                .map((c) => (
                  <label className="checkbox-label" key={c.id}>
                    <Input name="conversationIds" type="checkbox" value={c.id} />
                    {c.name}
                  </label>
                ))}
            </fieldset>
            <p className="muted">
              A private invitation link is shown once. The recipient joins with the email and role
              recorded here.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button disabled={busy} className="primary">
              {busy ? 'Creating…' : 'Create invitation'}
              <Plus size={15} />
            </Button>
          </form>
        </Dialog>
      )}
      {link && (
        <Dialog title="Your invitation is ready" onClose={() => setLink('')}>
          <p className="muted">
            An invitation email has been queued. You can also share this link securely with the
            intended recipient. Anyone with the link can start the acceptance flow. It is shown only
            here and expires after seven days.
          </p>
          <label>
            Private invitation link
            <Textarea readOnly value={link} rows={3} />
          </label>
          <Button
            className="primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                setError('Clipboard access was denied. You can select and copy the link above.');
              }
            }}
          >
            <Copy size={15} />
            {copied ? 'Copied' : 'Copy invitation link'}
          </Button>
        </Dialog>
      )}
      {edit && (
        <Dialog title={`Manage ${edit.name}`} onClose={() => setEdit(null)}>
          <form onSubmit={update}>
            <label>
              Role
              <NativeSelect
                name="role"
                aria-label="Role"
                defaultValue={edit.role}
                disabled={!owner}
              >
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
                <option value="owner">Owner</option>
              </NativeSelect>
              {!owner && <Input name="role" type="hidden" value={edit.role} />}
            </label>
            <label>
              Access
              <NativeSelect name="status" aria-label="Access" defaultValue={edit.status}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </NativeSelect>
            </label>
            <div className="runtime-notice">
              <ShieldCheck size={18} />
              <p>
                Suspension revokes this workspace’s sessions and stops the person’s open hosted
                work. Messages and attribution remain. The workspace must retain an active owner.
              </p>
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button disabled={busy} className="primary">
              {busy ? 'Saving…' : 'Save member changes'}
            </Button>
          </form>
          <MemberAccessEditor
            member={edit}
            boot={boot}
            onChange={async () => {
              setEdit(null);
              await Promise.all([refresh(), onChange()]);
            }}
          />
        </Dialog>
      )}
    </section>
  );
}
