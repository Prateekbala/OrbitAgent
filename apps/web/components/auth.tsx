'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { entryPath } from '../lib/auth-navigation';
import {
  ArrowUpRight,
  Building2,
  ChevronDown,
  Eye,
  EyeOff,
  LoaderCircle,
  Orbit,
} from 'lucide-react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { AuthShell } from './auth-shell';
import { Reveal } from './landing/landing-motion';
import { post, HttpError } from '../lib/api';
import styles from './auth.module.css';

type IdentityProvider = { id: string; name: string; protocol: string };

export function Auth({
  onComplete,
  initialRegister = true,
  navigation = 'inline',
}: {
  onComplete: () => void | Promise<void>;
  initialRegister?: boolean;
  navigation?: 'inline' | 'routes';
}) {
  const [ready, setReady] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [providers, setProviders] = useState<IdentityProvider[]>([]);
  const [register, setRegister] = useState(initialRegister);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [ssoOpen, setSsoOpen] = useState(false);
  const [entrySearch, setEntrySearch] = useState('');
  const fieldId = useId();
  const passwordId = `${fieldId}-password`;
  const hintId = `${fieldId}-password-hint`;
  const errorId = `${fieldId}-error`;

  useEffect(() => {
    setReady(true);
    setEntrySearch(window.location.search);
    setMfa(new URLSearchParams(window.location.search).get('mfa') === '1');
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const body = register
      ? {
          name: form.get('name'),
          workspace: form.get('workspace'),
          email: form.get('email'),
          password: form.get('password'),
        }
      : { email: form.get('email'), password: form.get('password') };
    try {
      const result = await post<{ mfaRequired?: boolean }>(
        mfa ? '/auth/mfa' : `/auth/${register ? 'signup' : 'signin'}`,
        mfa ? { code: form.get('code') } : body,
      );
      if (result.mfaRequired) {
        setMfa(true);
        setShowPassword(false);
        return;
      }
      await onComplete();
    } catch (e) {
      if (e instanceof HttpError && e.code === 'SSO_REQUIRED') {
        setMfa(false);
        setRegister(false);
        setSsoOpen(true);
      }
      setError(e instanceof Error ? e.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  }

  async function findProviders(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setProviders([]);
    try {
      const value = String(form.get('email')).trim();
      const result = await post<IdentityProvider[]>(
        '/auth/providers',
        value.includes('@') ? { email: value } : { organizationId: value },
      );
      setProviders(result);
      if (!result.length) setError('No federated provider is configured for this email domain.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to find identity providers.');
    } finally {
      setBusy(false);
    }
  }

  const mode = mfa ? 'mfa' : register ? 'register' : 'signin';
  return (
    <AuthShell>
      <Reveal className={styles.formWrap}>
        <span className={styles.formMark} aria-hidden="true">
          <Orbit size={23} />
        </span>
        <Reveal className={styles.intro} key={mode}>
          <p>
            {mfa
              ? 'ONE MORE STEP'
              : register
                ? 'YOUR NEXT CHAPTER STARTS HERE'
                : 'WELCOME BACK TO ORBIT'}
          </p>
          <h1 id="auth-title">
            {mfa
              ? 'Two-factor authentication'
              : register
                ? 'Make room for great work.'
                : 'Back to your orbit.'}
          </h1>
          <p>
            {mfa
              ? 'Enter a fresh authenticator code or a one-use recovery code.'
              : register
                ? 'A fresh space for your team, your ideas, and what comes next.'
                : 'Your people, projects, and next big idea are right where you left them.'}
          </p>
        </Reveal>
        <form
          className={styles.accountForm}
          method="post"
          onSubmit={submit}
          aria-label={mfa ? 'Verify your identity' : register ? 'Create workspace' : 'Sign in'}
          aria-busy={busy}
          aria-describedby={error ? errorId : undefined}
        >
          <fieldset className={styles.fields} disabled={busy} aria-label="Account details">
            {register && !mfa && (
              <>
                <label>
                  Your name
                  <Input
                    name="name"
                    autoComplete="name"
                    placeholder="Alex Morgan"
                    required
                    maxLength={80}
                  />
                </label>
                <label>
                  Workspace name
                  <Input
                    name="workspace"
                    placeholder="e.g. Acme Studio"
                    autoComplete="organization"
                    required
                    minLength={2}
                    maxLength={80}
                  />
                </label>
              </>
            )}
            {mfa ? (
              <label>
                Authenticator or recovery code
                <Input name="code" required autoComplete="one-time-code" maxLength={64} autoFocus />
              </label>
            ) : (
              <>
                <label>
                  Email address
                  <Input
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    required
                  />
                </label>
                <div>
                  <div className={styles.passwordHeader}>
                    <label htmlFor={passwordId}>Password</label>
                    {!register && <a href="/forgot-password">Forgot your password?</a>}
                  </div>
                  <div className={styles.passwordInput}>
                    <Input
                      id={passwordId}
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete={register ? 'new-password' : 'current-password'}
                      required
                      minLength={12}
                      maxLength={128}
                      aria-describedby={register ? hintId : undefined}
                    />
                    <Button
                      className={styles.passwordToggle}
                      type="button"
                      variant="ghost"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </Button>
                  </div>
                  {register && (
                    <small className={styles.passwordHint} id={hintId}>
                      At least 12 characters. Make it uniquely yours.
                    </small>
                  )}
                </div>
              </>
            )}
          </fieldset>
          <Button className={styles.submit} disabled={!ready || busy} type="submit">
            {busy ? 'One moment…' : mfa ? 'Verify code' : register ? 'Create workspace' : 'Sign in'}
            {busy ? (
              <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" />
            ) : (
              <ArrowUpRight size={17} aria-hidden="true" />
            )}
          </Button>
        </form>
        {register && !mfa && (
          <p className={styles.signupNote}>Start with Free. No credit card required.</p>
        )}
        {!register && !mfa && (
          <details
            className={styles.sso}
            open={ssoOpen}
            onToggle={(event) => setSsoOpen(event.currentTarget.open)}
          >
            <summary>
              <Building2 size={17} aria-hidden="true" /> Continue with single sign-on{' '}
              <ChevronDown size={16} aria-hidden="true" />
            </summary>
            <form onSubmit={findProviders} aria-label="Find your organization" aria-busy={busy}>
              <fieldset className={styles.fields} disabled={busy} aria-label="Organization sign-in">
                <label>
                  Organization email or ID
                  <Input name="email" required autoComplete="email" placeholder="you@company.com" />
                </label>
                <Button
                  variant="outline"
                  className={styles.ssoButton}
                  disabled={!ready || busy}
                  type="submit"
                >
                  Find single sign-on
                </Button>
              </fieldset>
            </form>
            {providers.map((provider) => (
              <a
                className={styles.providerLink}
                key={provider.id}
                href={`/api/v1/auth/federation/${provider.id}/start`}
              >
                Continue with {provider.name}
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            ))}
          </details>
        )}
        {error && (
          <p role="alert" id={errorId} className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.switch}>
          {navigation === 'routes' && !mfa ? (
            <Link
              className={styles.switchButton}
              href={entryPath(register ? '/sign-in' : '/sign-up', entrySearch)}
            >
              {register ? (
                <>
                  <span>Already have a workspace?</span> Sign in
                </>
              ) : (
                'Create a new workspace'
              )}
              <ArrowUpRight size={14} />
            </Link>
          ) : (
            <Button
              variant="link"
              className={styles.switchButton}
              disabled={busy}
              type="button"
              onClick={() => {
                setRegister(mfa ? false : !register);
                setMfa(false);
                setProviders([]);
                setError('');
                setShowPassword(false);
                setSsoOpen(false);
              }}
            >
              {mfa ? (
                'Use another sign-in method'
              ) : register ? (
                <>
                  <span>Already have a workspace?</span> Sign in <ArrowUpRight size={14} />
                </>
              ) : (
                <>
                  Create a new workspace <ArrowUpRight size={14} />
                </>
              )}
            </Button>
          )}
        </div>
      </Reveal>
    </AuthShell>
  );
}
