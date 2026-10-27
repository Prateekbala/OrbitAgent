'use client';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { NativeSelect } from '../../../components/ui/native-select';
import { useEffect, useRef, useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import { api, post } from '../../../lib/api';
interface Authorization {
  client: { id: string; name: string };
  requestedScopes: string[];
  resource: string;
  workspaceId: string;
  memberId: string;
}
interface Workspace {
  membershipId: string;
  workspaceId: string;
  name: string;
  organization: string;
}
export default function AuthorizePage() {
  const [authorization, setAuthorization] = useState<Authorization | null>(null),
    [boot, setBoot] = useState<Bootstrap | null>(null),
    [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [query, setQuery] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const q = Object.fromEntries(new URLSearchParams(window.location.search));
    setQuery(q);
    const c = new AbortController();
    active.current = c;
    setAuthorization(null);
    setBoot(null);
    setError('');
    void Promise.all([
      api<Authorization>('/developer/oauth/authorization?' + new URLSearchParams(q), {
        signal: c.signal,
      }),
      api<Bootstrap>('/bootstrap', { signal: c.signal }),
      api<Workspace[]>('/developer/oauth/workspaces', { signal: c.signal }),
    ])
      .then(([a, b, w]) => {
        if (!c.signal.aborted) {
          setAuthorization(a);
          setBoot(b);
          setWorkspaces(w);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : 'Authorization unavailable.');
      });
    return () => c.abort();
  }, [revision]);
  async function switchWorkspace(membershipId: string) {
    active.current?.abort();
    setAuthorization(null);
    setBoot(null);
    setBusy(true);
    try {
      await post('/workspaces/switch', { membershipId });
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Workspace switch failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="platform-view" style={{ maxWidth: 760, margin: '40px auto' }}>
      <h1>Connect to Orbit</h1>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <a href="/" target="_blank" rel="noreferrer">
            Sign in to Orbit
          </a>
          <Button variant="outline" onClick={() => setRevision((n) => n + 1)}>
            Reload authorization
          </Button>
        </div>
      )}
      {authorization && boot && (
        <>
          <p>
            <strong>{authorization.client.name}</strong> requests access to{' '}
            <strong>{boot.workspace.name}</strong> as {boot.me.name}.
          </p>
          <p>
            {authorization.resource.endsWith('/mcp') ? 'MCP server' : 'REST API'} access expires in
            one hour. You can revoke this grant from Developer settings.
          </p>
          <label>
            Choose authorization workspace
            <NativeSelect
              aria-label="Choose authorization workspace"
              value={authorization.memberId}
              disabled={busy}
              onChange={(e) => void switchWorkspace(e.target.value)}
            >
              {workspaces.map((w) => (
                <option value={w.membershipId} key={w.membershipId}>
                  {w.organization} / {w.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <form
            className="platform-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget);
              setBusy(true);
              setError('');
              try {
                const r = await post<{ redirect_uri: string }>('/developer/oauth/consent', {
                  authorization: query,
                  workspaceId: authorization.workspaceId,
                  grants: {
                    scopes: v.getAll('scopes'),
                    conversationIds: v.getAll('conversationIds'),
                    workspaceResources: v.get('workspaceResources') === 'on',
                  },
                });
                window.location.assign(r.redirect_uri);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Consent could not be saved.');
                setBusy(false);
              }
            }}
          >
            <fieldset>
              <legend>Requested permissions</legend>
              {authorization.requestedScopes.map((scope) => (
                <label key={scope}>
                  <Input type="checkbox" name="scopes" value={scope} defaultChecked />
                  {scope}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Conversations this application may access</legend>
              {boot.channels
                .filter((c) => !c.archived_at)
                .map((c) => (
                  <label key={c.id}>
                    <Input type="checkbox" name="conversationIds" value={c.id} />
                    {c.name}
                  </label>
                ))}
            </fieldset>
            <label>
              <Input type="checkbox" name="workspaceResources" />
              Include content without a conversation
            </label>
            <p>
              Access always follows your current membership and the conversations selected above.
              Credentials are never shared with agents.
            </p>
            <Button className="primary" disabled={busy}>
              Allow selected access
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => {
                const redirect = new URL(query.redirect_uri!);
                redirect.searchParams.set('error', 'access_denied');
                redirect.searchParams.set('state', query.state!);
                window.location.assign(redirect.toString());
              }}
            >
              Decline access
            </Button>
          </form>
        </>
      )}
    </main>
  );
}
