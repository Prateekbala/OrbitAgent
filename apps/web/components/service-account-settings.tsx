'use client';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { useCallback, useEffect, useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import { servicePermissions } from '@ao/contracts/identity';
import { api, post } from '../lib/api';
interface Credential {
  id: string;
  name: string;
  permissions: Record<string, boolean>;
  expires_at: string;
  revoked_at: string | null;
}
export function ServiceAccountSettings({ boot }: { boot: Bootstrap }) {
  const [credentials, setCredentials] = useState<Credential[]>([]),
    [secret, setSecret] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const data = await api<Credential[]>('/service-accounts', { ...(signal ? { signal } : {}) });
    if (!signal?.aborted) setCredentials(data);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Unable to load service accounts.');
    });
    return () => controller.abort();
  }, [refresh]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to manage service accounts.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="identity-settings">
      <h2>Service accounts</h2>
      <p className="muted">
        Dedicated, expiring bearer credentials with explicit capabilities and conversation access.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Card asChild>
        <article className="settings-card">
          <Card asChild>
            <div className="team-list">
              {credentials.map((key) => (
                <div className="team-row" key={key.id}>
                  <div>
                    <strong>{key.name}</strong>
                    <small>
                      {Object.entries(key.permissions)
                        .filter(([, enabled]) => enabled)
                        .map(([permission]) => permission)
                        .join(', ')}
                    </small>
                    <small>
                      {key.revoked_at
                        ? 'Revoked'
                        : 'Expires ' + new Date(key.expires_at).toLocaleDateString()}
                    </small>
                  </div>
                  {!key.revoked_at && (
                    <Button
                      variant="outline"
                      className="subtle-button"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api('/service-accounts/' + key.id, { method: 'DELETE' });
                        })
                      }
                    >
                      Revoke service account
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
          <details>
            <summary>Create service account</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void action(async () => {
                  const result = await post<{ token: string }>('/service-accounts', {
                    name: form.get('name'),
                    permissions: form.getAll('permissions'),
                    conversationIds: form.getAll('conversations'),
                    expiresInDays: Number(form.get('days')),
                  });
                  setSecret(result.token);
                });
              }}
            >
              <label>
                Service account name
                <Input name="name" required minLength={2} maxLength={80} />
              </label>
              <label>
                Expires in days
                <Input name="days" type="number" defaultValue={90} min={1} max={365} required />
              </label>
              <fieldset>
                <legend>Capabilities</legend>
                {servicePermissions.map((permission) => (
                  <label className="checkbox-label" key={permission}>
                    <Input name="permissions" type="checkbox" value={permission} />
                    {permission}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Shared conversations</legend>
                {boot.channels
                  .filter((c) => c.kind === 'channel')
                  .map((c) => (
                    <label className="checkbox-label" key={c.id}>
                      <Input name="conversations" type="checkbox" value={c.id} />
                      {c.name}
                    </label>
                  ))}
              </fieldset>
              <Button size="sm" className="primary small" disabled={busy}>
                Create service account
              </Button>
            </form>
          </details>
        </article>
      </Card>
      {secret && (
        <Card asChild>
          <article className="settings-card">
            <h3>Save this credential</h3>
            <p className="muted">
              This token is only shown once. Store it in your service’s secret manager.
            </p>
            <Textarea aria-label="Service account token" readOnly value={secret} rows={2} />
            <Button variant="outline" className="subtle-button" onClick={() => setSecret('')}>
              I saved the credential
            </Button>
          </article>
        </Card>
      )}
    </section>
  );
}
