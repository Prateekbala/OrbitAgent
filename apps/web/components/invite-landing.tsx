'use client';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { useEffect, useRef, useState } from 'react';
import { Orbit, ArrowUpRight } from 'lucide-react';
import { api, post } from '../lib/api';
import { Auth } from './auth';
export function InviteLanding() {
  const initialized = useRef(false);
  const [token, setToken] = useState(''),
    [preview, setPreview] = useState<{ workspace: string; role: string; emailHint: string } | null>(
      null,
    ),
    [error, setError] = useState(''),
    [signedIn, setSignedIn] = useState(false),
    [signIn, setSignIn] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const value = window.location.hash.slice(1);
    window.history.replaceState(null, '', '/invite');
    if (!value) {
      setError('Open the complete invitation link to join.');
      return;
    }
    setToken(value);
    void post<typeof preview>('/invitations/preview', { token: value })
      .then(setPreview)
      .catch((error) =>
        setError(error instanceof Error ? error.message : 'This invitation is unavailable.'),
      );
    void api('/bootstrap')
      .then(() => setSignedIn(true))
      .catch(() => {});
  }, []);
  async function accept(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await post('/invitations/accept', {
        token,
        ...(!signedIn ? { name: form.get('name'), password: form.get('password') } : {}),
      });
      window.location.assign('/app');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to join this workspace.');
    } finally {
      setBusy(false);
    }
  }
  if (signIn)
    return (
      <Auth
        initialRegister={false}
        onComplete={() => {
          setSignIn(false);
          setSignedIn(true);
          setError('');
        }}
      />
    );
  return (
    <main className="invite-landing">
      <section className="invite-card">
        <div className="brand">
          <Orbit size={30} />
          orbit
        </div>
        <span className="eyebrow">A PLACE ON THE TEAM</span>
        <h1>{preview ? `Join ${preview.workspace}` : 'Your workspace invitation'}</h1>
        {preview && (
          <>
            <p className="muted">
              You’re invited as a {preview.role}. This invitation is for {preview.emailHint}.
            </p>
            <form method="post" onSubmit={accept}>
              {!signedIn && (
                <>
                  <label>
                    Your name
                    <Input name="name" autoComplete="name" required minLength={1} maxLength={80} />
                  </label>
                  <label>
                    Create a password
                    <Input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={128}
                    />
                  </label>
                </>
              )}
              <p className="muted">
                {signedIn
                  ? 'Continue with your signed-in account. The invitation must match that account’s email.'
                  : 'The invitation supplies your account email. If you already have an account, sign in first.'}
              </p>
              <Button className="primary" disabled={busy}>
                {busy ? 'Joining…' : 'Join workspace'}
                <ArrowUpRight size={16} />
              </Button>
            </form>
            <Button
              variant="link"
              className="text-button"
              onClick={() => {
                setSignIn(true);
                setError('');
              }}
            >
              {signedIn ? 'Sign in with another account' : 'Already have an account? Sign in'}
            </Button>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
