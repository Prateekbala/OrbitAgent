'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, post } from '../lib/api';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
interface ModelKey {
  id: string;
  label: string;
  generation: number;
  models: string[];
  expires_at: string;
  revoked_at: string | null;
}
export interface OrganizationErasure {
  id: string;
  state: string;
  database_deleted_at: string | null;
  storage_deleted_at: string | null;
  backup_not_before: string;
  error_code: string | null;
  completed_at: string | null;
}
export function EnterpriseControls({
  organizationId,
  organizationName,
  owner,
}: {
  organizationId: string;
  organizationName: string;
  owner: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card asChild>
      <details className="settings-card" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Model keys & organization deletion</summary>
        {open && (
          <Controls
            organizationId={organizationId}
            organizationName={organizationName}
            owner={owner}
          />
        )}
      </details>
    </Card>
  );
}
function Controls({
  organizationId,
  organizationName,
  owner,
}: {
  organizationId: string;
  organizationName: string;
  owner: boolean;
}) {
  const path = '/organizations/' + organizationId,
    router = useRouter(),
    requestKey = useRef<string | null>(null);
  const [keys, setKeys] = useState<ModelKey[]>([]),
    [configured, setConfigured] = useState(false),
    [loaded, setLoaded] = useState(false),
    [job, setJob] = useState<OrganizationErasure | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const [models, deletion] = await Promise.all([
        api<{ configured: boolean; keys: ModelKey[] }>(
          path + '/model-keys',
          signal ? { signal } : {},
        ),
        api<OrganizationErasure | null>(path + '/erasure', signal ? { signal } : {}),
      ]);
      setKeys(models.keys);
      setConfigured(models.configured);
      setJob(deletion);
      setLoaded(true);
    },
    [path],
  );
  useEffect(() => {
    const c = new AbortController();
    void refresh(c.signal).catch(() => {
      if (!c.signal.aborted) setError('Unable to load enterprise controls.');
    });
    return () => c.abort();
  }, [refresh]);
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The request could not be completed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="commercial-panel governance-panel"
      aria-label="Model keys and organization deletion"
    >
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {!loaded && !error && <p role="status">Loading controls…</p>}
      <h3>Customer model keys</h3>
      <p className="muted">
        Keys are sealed for the isolated model broker and are never added to agent instructions or
        checkpoints. OpenAI is currently supported; live provider acceptance is pending.
      </p>
      {!configured && (
        <p>The model broker’s public wrapping key must be configured before adding a key.</p>
      )}
      {!job && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              data = new FormData(form);
            void perform(async () => {
              const existing = keys[0];
              await api(path + '/model-keys', {
                method: 'PUT',
                body: JSON.stringify({
                  version: existing?.generation ?? 0,
                  label: data.get('label'),
                  provider: 'openai',
                  secret: data.get('secret'),
                  models: String(data.get('models'))
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                  expiresAt: new Date(String(data.get('expires'))).toISOString(),
                }),
              });
              form.reset();
              setMessage(
                'Model key saved. Existing run bindings are invalidated; restart affected runs.',
              );
            });
          }}
        >
          <fieldset disabled={!owner || busy || !configured}>
            <legend>Add or rotate OpenAI key</legend>
            <label>
              Key label
              <Input name="label" required minLength={2} maxLength={100} />
            </label>
            <label>
              API key
              <Input
                name="secret"
                type="password"
                autoComplete="off"
                required
                minLength={16}
                maxLength={512}
              />
            </label>
            <label>
              Allowed model IDs
              <Input name="models" required placeholder="openai/model-name" />
            </label>
            <label>
              Key expiry
              <Input name="expires" type="datetime-local" required />
            </label>
            <Button disabled={busy || !owner || !configured}>Save model key</Button>
          </fieldset>
        </form>
      )}
      <ul>
        {keys.map((key) => (
          <li key={key.id}>
            <strong>{key.label}</strong>
            <small>
              {key.models.join(', ')} · expires {new Date(key.expires_at).toLocaleString()}
            </small>
            {key.revoked_at ? (
              <span>Revoked</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!owner || busy || Boolean(job)}
                onClick={() =>
                  void perform(async () => {
                    await api(path + '/model-keys/' + key.id, { method: 'DELETE' });
                    setMessage(
                      'Model key revoked. No platform-key fallback will be used for its runs.',
                    );
                  })
                }
              >
                Revoke key
              </Button>
            )}
          </li>
        ))}
      </ul>
      <h3>Delete organization</h3>
      <p>
        Deletion immediately freezes all workspaces. Legal holds pause erasure. Completion requires
        storage cleanup and verified runtime, provider and backup-expiry evidence. Minimal audit,
        financial and identity records are retained.
      </p>
      {job ? (
        <>
          <ErasureProgress job={job} />
          <a href={'/organizations/' + organizationId + '/erasure'}>View deletion progress</a>
        </>
      ) : (
        loaded &&
        owner && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              requestKey.current ??= crypto.randomUUID();
              void perform(async () => {
                await post(path + '/erasure', {
                  requestKey: requestKey.current,
                  confirmation: data.get('confirmation'),
                  password: data.get('password'),
                  reason: data.get('reason'),
                });
                router.push('/organizations/' + organizationId + '/erasure');
              });
            }}
          >
            <fieldset disabled={busy}>
              <legend>Confirm organization deletion</legend>
              <label>
                Type organization name: {organizationName}
                <Input name="confirmation" required autoComplete="off" />
              </label>
              <label>
                Current password (or sign in with SSO within five minutes)
                <Input name="password" type="password" autoComplete="current-password" />
              </label>
              <label>
                Deletion reason
                <Input name="reason" required minLength={20} maxLength={1000} />
              </label>
              <Button variant="destructive" disabled={busy}>
                Permanently freeze and delete organization
              </Button>
            </fieldset>
          </form>
        )
      )}
    </section>
  );
}
export function ErasureProgress({ job }: { job: OrganizationErasure }) {
  const labels: Record<string, string> = {
    pending: 'Preparing deletion',
    held: 'Paused by legal preservation',
    purging: 'Deleting retained data',
    waiting_receipts: 'Awaiting independent deletion evidence',
    completed: 'Deletion complete with documented retained records',
    dead: 'Operator action required',
  };
  return (
    <div role="status">
      <strong>{labels[job.state] ?? job.state}</strong>
      <p>
        Database content: {job.database_deleted_at ? 'removed' : 'pending'}. Stored files:{' '}
        {job.storage_deleted_at ? 'removed' : 'pending'}.
      </p>
      <p>
        Backup expiry cannot be acknowledged before{' '}
        {new Date(job.backup_not_before).toLocaleString()}.
      </p>
      {job.error_code && <p>Component error: {job.error_code}. The organization remains frozen.</p>}
    </div>
  );
}
