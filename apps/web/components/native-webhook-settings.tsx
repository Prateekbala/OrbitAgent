'use client';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
interface Hook {
  provider: string;
  enabled: boolean;
  version: number;
  expires_at: string;
}
export function NativeWebhookSettings({
  connectionId,
  provider,
  version,
}: {
  connectionId: string;
  provider: string;
  version: number;
}) {
  const [hook, setHook] = useState<Hook | null>(null),
    [secret, setSecret] = useState(''),
    [path, setPath] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSecret('');
    void api<Hook | null>(`/connections/${connectionId}/native-webhook`, {
      signal: controller.signal,
    })
      .then(setHook)
      .catch((e) => {
        if (!controller.signal.aborted) {
          setHook(null);
          setError(e instanceof Error ? e.message : 'Webhook settings unavailable.');
        }
      });
    return () => controller.abort();
  }, [connectionId, version, revision]);
  return (
    <Card asChild>
      <section className="settings-card" aria-label="Native webhook settings">
        <h4>Native {provider} events</h4>
        <p className="muted">
          Verify provider signatures and refresh only previously imported resources. Configure the
          returned callback in the provider’s webhook settings. Native events do not grant resource
          access.
        </p>
        {provider === 'github' && (
          <p className="muted">
            GitHub has no signed delivery timestamp. Its generated secret expires after 30 days;
            rotate it here and update the provider before expiry.
          </p>
        )}
        {hook && (
          <p>
            {hook.enabled ? 'Enabled' : 'Disabled'} · version {hook.version} · expires{' '}
            {new Date(hook.expires_at).toLocaleString()}
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              data = new FormData(form);
            setBusy(true);
            setError('');
            setSecret('');
            void api<{
              incomingPath: string;
              incomingSecret?: string;
              version: number;
              expiresAt: string;
            }>(`/connections/${connectionId}/native-webhook`, {
              method: 'PUT',
              body: JSON.stringify(provider === 'github' ? {} : { secret: data.get('secret') }),
            })
              .then((result) => {
                form.reset();
                setPath(result.incomingPath);
                setSecret(result.incomingSecret ?? '');
                setHook({
                  provider,
                  enabled: true,
                  version: result.version,
                  expires_at: result.expiresAt,
                });
              })
              .catch((e) =>
                setError(e instanceof Error ? e.message : 'Native webhook configuration failed.'),
              )
              .finally(() => setBusy(false));
          }}
        >
          {provider !== 'github' && (
            <label>
              Provider signing secret
              {provider === 'gitlab' ? ' (whsec_ signing token, not the legacy secret token)' : ''}
              <Input
                type="password"
                name="secret"
                autoComplete="off"
                required
                minLength={16}
                maxLength={500}
              />
            </label>
          )}
          <Button variant="outline" disabled={busy}>
            {hook ? 'Rotate native webhook secret' : 'Configure native webhook'}
          </Button>
        </form>
        {path && (
          <p>
            Provider callback path: <code>{path}</code>
          </p>
        )}
        {secret && (
          <div role="status">
            <p>
              Copy this generated signing secret into the provider’s webhook settings. It is shown
              only here.
            </p>
            <pre>{secret}</pre>
            <Button variant="outline" onClick={() => setSecret('')}>
              Dismiss signing secret
            </Button>
          </div>
        )}
        {hook?.enabled && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setSecret('');
              void api(`/connections/${connectionId}/native-webhook`, { method: 'DELETE' })
                .then(() => setRevision((n) => n + 1))
                .catch((e) => setError(e instanceof Error ? e.message : 'Revocation failed.'))
                .finally(() => setBusy(false));
            }}
          >
            Disable native webhook
          </Button>
        )}
      </section>
    </Card>
  );
}
