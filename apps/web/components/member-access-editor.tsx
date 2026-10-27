'use client';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { useState } from 'react';
import type { Bootstrap, TeamMember } from '@ao/contracts';
import { permissions } from '@ao/contracts/identity';
import { api, post } from '../lib/api';
export function MemberAccessEditor({
  member,
  boot,
  onChange,
}: {
  member: TeamMember;
  boot: Bootstrap;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await onChange();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update access.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="member-access-editor">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {boot.me.role === 'owner' && member.role === 'member' && (
        <details>
          <summary>Guest access & granular permissions</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action(() =>
                api('/members/' + member.id + '/access', {
                  method: 'PUT',
                  body: JSON.stringify({
                    accessType: form.get('accessType'),
                    permissions: Object.fromEntries(
                      permissions.map((p) => [p, form.getAll('permissions').includes(p)]),
                    ),
                    conversationIds: form.getAll('conversations'),
                    version: member.version,
                  }),
                }),
              );
            }}
          >
            <label>
              Account access
              <NativeSelect
                name="accessType"
                aria-label="Account access"
                defaultValue={member.access_type ?? 'member'}
              >
                <option value="member">Full workspace member</option>
                <option value="guest">Guest: shared conversations only</option>
              </NativeSelect>
            </label>
            <fieldset>
              <legend>Capabilities</legend>
              {permissions.map((permission) => (
                <label className="checkbox-label" key={permission}>
                  <Input
                    type="checkbox"
                    name="permissions"
                    value={permission}
                    defaultChecked={
                      member.permissions?.[permission] ??
                      !['people.manage', 'agents.manage', 'workspace.manage'].includes(permission)
                    }
                  />
                  {permission}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Share conversations</legend>
              {boot.channels
                .filter((c) => c.kind !== 'direct')
                .map((c) => (
                  <label className="checkbox-label" key={c.id}>
                    <Input type="checkbox" name="conversations" value={c.id} />
                    {c.name}
                  </label>
                ))}
            </fieldset>
            <p className="muted">
              Access changes revoke current sessions. Guests need at least one shared conversation.
              Existing resource ownership rules also apply.
            </p>
            <Button size="sm" className="primary small" disabled={busy}>
              Save access policy
            </Button>
          </form>
        </details>
      )}
      {boot.me.role === 'owner' &&
        member.id !== boot.me.id &&
        member.kind === 'human' &&
        member.status === 'active' && (
          <details>
            <summary>Transfer workspace ownership</summary>
            <p className="muted">
              Make {member.name} a workspace owner and change your workspace role to administrator.
            </p>
            <Button
              variant="outline"
              className="subtle-button"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  post('/workspaces/transfer-ownership', { membershipId: member.id }),
                )
              }
            >
              Transfer workspace ownership
            </Button>
          </details>
        )}
      <details>
        <summary>Complete offboarding</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void action(() =>
              post('/members/' + member.id + '/offboard', {
                version: member.version,
                ...(form.get('successor') ? { successorId: form.get('successor') } : {}),
              }),
            );
          }}
        >
          <label>
            Task and project successor
            <NativeSelect name="successor">
              <option value="">Unassign tasks; no project successor</option>
              {boot.members
                .filter((m) => m.id !== member.id && m.kind === 'human')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </NativeSelect>
          </label>
          <p className="muted">
            Revoke sessions and conversation shares, stop pending agent work, pause recurring work,
            and preserve history. A successor is required for projects and the last workspace owner.
          </p>
          <Button variant="outline" className="subtle-button" disabled={busy}>
            Offboard workspace member
          </Button>
        </form>
      </details>
    </div>
  );
}
