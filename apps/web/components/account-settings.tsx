'use client';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';
import { clearPrivateStorage } from '../lib/private-storage';
import { useCallback, useEffect, useState } from 'react';
import type { AccountProfile, AccountSession } from '@ao/contracts/identity';
import { api, post } from '../lib/api';
function SecurityProofFields({ mfa = false }: { mfa?: boolean }) {
  return (
    <>
      <label>
        Current password
        <Input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          maxLength={128}
        />
      </label>
      {mfa && (
        <label>
          Authenticator or recovery code
          <Input name="code" required autoComplete="one-time-code" maxLength={64} />
        </label>
      )}
    </>
  );
}
function proof(form: FormData) {
  return {
    password: String(form.get('password') ?? ''),
    ...(form.get('code') ? { code: String(form.get('code')) } : {}),
  };
}
export function AccountSettings({ onChange }: { onChange?: () => Promise<void> }) {
  const [account, setAccount] = useState<AccountProfile | null>(null),
    [sessions, setSessions] = useState<AccountSession[]>([]),
    [events, setEvents] = useState<Array<{ id: string; event_type: string; created_at: string }>>(
      [],
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [enrollment, setEnrollment] = useState<{ secret: string; uri: string } | null>(null),
    [recovery, setRecovery] = useState<string[]>([]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [profile, devices, history] = await Promise.all([
      api<AccountProfile>('/account', { ...(signal ? { signal } : {}) }),
      api<AccountSession[]>('/account/sessions', { ...(signal ? { signal } : {}) }),
      api<typeof events>('/account/security-events', { ...(signal ? { signal } : {}) }),
    ]);
    if (!signal?.aborted) {
      setAccount(profile);
      setSessions(devices);
      setEvents(history);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Unable to load account.');
    });
    return () => controller.abort();
  }, [refresh]);
  async function action(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await refresh();
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update account.');
    } finally {
      setBusy(false);
    }
  }
  function submit(
    event: React.FormEvent<HTMLFormElement>,
    work: (form: FormData) => Promise<unknown>,
    message: string,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action(() => work(form), message);
  }
  if (!account)
    return (
      <Card asChild>
        <section className="settings-card">
          <h2>Account & security</h2>
          <p role={error ? 'alert' : 'status'}>{error || 'Loading account…'}</p>
        </section>
      </Card>
    );
  return (
    <section className="identity-settings" aria-label="Account and security">
      <div className="execution-heading">
        <div>
          <span className="eyebrow">YOUR IDENTITY</span>
          <h2>Account & security</h2>
          <p className="muted">{account.email}</p>
        </div>
        <Button
          variant="outline"
          className="subtle-button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await clearPrivateStorage().catch(() => {});
              await post('/auth/signout', {});
              window.location.assign('/sign-in');
            }, '')
          }
        >
          Sign out
        </Button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="runtime-notice" role="status">
          {notice}
        </p>
      )}
      <div className="settings-grid">
        <Card asChild>
          <article className="settings-card">
            <h3>Profile</h3>
            <form
              key={account.name + account.time_zone + account.locale}
              onSubmit={(e) =>
                submit(
                  e,
                  async (f) => {
                    await api('/account', {
                      method: 'PATCH',
                      body: JSON.stringify({
                        name: f.get('name'),
                        timeZone: f.get('timeZone'),
                        locale: f.get('locale'),
                      }),
                    });
                    await onChange?.();
                  },
                  'Profile updated.',
                )
              }
            >
              <label>
                Display name
                <Input
                  name="name"
                  defaultValue={account.name}
                  required
                  maxLength={80}
                  autoComplete="name"
                />
              </label>
              <label>
                Time zone
                <Input
                  name="timeZone"
                  defaultValue={account.time_zone}
                  required
                  maxLength={80}
                  placeholder="Asia/Kolkata"
                />
              </label>
              <label>
                Language
                <NativeSelect name="locale" defaultValue={account.locale}>
                  {['en', 'en-GB', 'fr', 'de', 'es', 'hi', 'ja'].map((locale) => (
                    <option key={locale}>{locale}</option>
                  ))}
                </NativeSelect>
              </label>
              <Button size="sm" className="primary small" disabled={busy}>
                Save profile
              </Button>
            </form>
          </article>
        </Card>
        <Card asChild>
          <article className="settings-card">
            <h3>Email address</h3>
            <p className="muted">
              Your current address stays active until you confirm the new address. Confirmation
              signs out every device.
            </p>
            {account.pending_email && (
              <p role="status">Waiting for confirmation: {account.pending_email}</p>
            )}
            <form
              onSubmit={(e) =>
                submit(
                  e,
                  (f) => post('/account/email', { ...proof(f), email: f.get('email') }),
                  'A confirmation email was queued to your new address.',
                )
              }
            >
              <label>
                New email address
                <Input name="email" type="email" required maxLength={254} autoComplete="email" />
              </label>
              <SecurityProofFields mfa={account.mfa_enabled} />
              <Button size="sm" className="primary small" disabled={busy}>
                Request email change
              </Button>
            </form>
          </article>
        </Card>
        <Card asChild>
          <article className="settings-card">
            <h3>Change password</h3>
            <p className="muted">Updating your password signs out every device.</p>
            <form
              onSubmit={(e) =>
                submit(
                  e,
                  async (f) => {
                    await post('/account/password', {
                      ...proof(f),
                      newPassword: f.get('newPassword'),
                    });
                    window.location.assign('/sign-in');
                  },
                  '',
                )
              }
            >
              <SecurityProofFields mfa={account.mfa_enabled} />
              <label>
                New password
                <Input
                  name="newPassword"
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                />
              </label>
              <Button size="sm" className="primary small" disabled={busy}>
                Update password
              </Button>
            </form>
          </article>
        </Card>
        <Card asChild>
          <article className="settings-card">
            <h3>Two-factor authentication</h3>
            <p className="muted">
              {account.mfa_enabled
                ? 'An authenticator code or a one-use recovery code is required when you sign in.'
                : 'Use an authenticator app to protect your account.'}
            </p>
            {!account.mfa_enabled && !enrollment && (
              <form
                onSubmit={(e) =>
                  submit(
                    e,
                    async (f) => setEnrollment(await post('/account/mfa/enroll', proof(f))),
                    'Add the secret to your authenticator, then enter its code.',
                  )
                }
              >
                <SecurityProofFields />
                <Button size="sm" className="primary small" disabled={busy}>
                  Set up authenticator
                </Button>
              </form>
            )}
            {enrollment && (
              <>
                <label>
                  Authenticator setup key
                  <Input readOnly value={enrollment.secret} />
                </label>
                <details>
                  <summary>Authenticator URI</summary>
                  <Textarea readOnly value={enrollment.uri} rows={3} />
                </details>
                <form
                  onSubmit={(e) =>
                    submit(
                      e,
                      async (f) => {
                        const result = await post<{ recoveryCodes: string[] }>(
                          '/account/mfa/confirm',
                          { code: f.get('code') },
                        );
                        setRecovery(result.recoveryCodes);
                        setEnrollment(null);
                      },
                      'Two-factor authentication enabled. Save your recovery codes now.',
                    )
                  }
                >
                  <label>
                    Six-digit code
                    <Input
                      name="code"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      required
                      autoComplete="one-time-code"
                    />
                  </label>
                  <Button size="sm" className="primary small" disabled={busy}>
                    Enable two-factor authentication
                  </Button>
                </form>
                <Button variant="link" className="text-button" onClick={() => setEnrollment(null)}>
                  Cancel setup
                </Button>
              </>
            )}
            {account.mfa_enabled && (
              <>
                <form
                  onSubmit={(e) =>
                    submit(
                      e,
                      async (f) => {
                        setRecovery(
                          (
                            await post<{ recoveryCodes: string[] }>(
                              '/account/mfa/recovery-codes',
                              proof(f),
                            )
                          ).recoveryCodes,
                        );
                      },
                      'Previous recovery codes are invalid. Save the replacement codes.',
                    )
                  }
                >
                  <SecurityProofFields mfa />
                  <Button variant="outline" className="subtle-button" disabled={busy}>
                    Replace recovery codes
                  </Button>
                </form>
                <details>
                  <summary>Disable two-factor authentication</summary>
                  <form
                    onSubmit={(e) =>
                      submit(
                        e,
                        async (f) => {
                          await post('/account/mfa/disable', proof(f));
                          window.location.assign('/sign-in');
                        },
                        '',
                      )
                    }
                  >
                    <SecurityProofFields mfa />
                    <Button variant="outline" className="subtle-button" disabled={busy}>
                      Disable and sign out
                    </Button>
                  </form>
                </details>
              </>
            )}
          </article>
        </Card>
      </div>
      {recovery.length > 0 && (
        <Card asChild>
          <article className="settings-card recovery-panel">
            <h3>Save your recovery codes</h3>
            <p>
              Each code works once. These codes are only shown here; keep them somewhere private.
            </p>
            <Textarea aria-label="Recovery codes" readOnly rows={10} value={recovery.join('\n')} />
            <Button variant="outline" className="subtle-button" onClick={() => setRecovery([])}>
              I saved these codes
            </Button>
          </article>
        </Card>
      )}
      <Card asChild>
        <article className="settings-card">
          <h3>Devices & sessions</h3>
          <Card asChild>
            <div className="team-list">
              {sessions.map((session) => (
                <div className="team-row" key={session.id}>
                  <div>
                    <strong>
                      {session.current ? 'This session' : session.user_agent || 'Browser session'}
                    </strong>
                    <small>
                      {session.workspace_name} · {session.authentication_method}
                      {session.mfa_verified_at ? ' + MFA' : ''}
                    </small>
                    <small>
                      {session.ip_address || 'Address unavailable'} · last seen{' '}
                      {new Date(session.last_seen_at).toLocaleString()} · expires{' '}
                      {new Date(session.expires_at).toLocaleString()}
                    </small>
                  </div>
                  <Button
                    variant="outline"
                    className="subtle-button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api('/account/sessions/' + session.id, { method: 'DELETE' });
                        if (session.current) window.location.assign('/sign-in');
                      }, 'Session revoked.')
                    }
                  >
                    Revoke session
                  </Button>
                </div>
              ))}
            </div>
          </Card>
          <details>
            <summary>Sign out other devices</summary>
            <form
              onSubmit={(e) =>
                submit(
                  e,
                  (f) => post('/account/sessions/revoke-others', proof(f)),
                  'Other sessions were signed out.',
                )
              }
            >
              <SecurityProofFields mfa={account.mfa_enabled} />
              <Button variant="outline" className="subtle-button" disabled={busy}>
                Revoke other sessions
              </Button>
            </form>
          </details>
        </article>
      </Card>
      <Card asChild>
        <details className="settings-card">
          <summary>Security activity</summary>
          <div className="audit-list">
            {events.map((event) => (
              <div key={event.id}>
                <span>{event.event_type.replaceAll('.', ' ')}</span>
                <time>{new Date(event.created_at).toLocaleString()}</time>
              </div>
            ))}
          </div>
        </details>
      </Card>
    </section>
  );
}
