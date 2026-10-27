'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { AuthShell } from './auth-shell';
import { Reveal } from './landing/landing-motion';
import { post } from '../lib/api';
import styles from './auth.module.css';

type Mode = 'forgot-password' | 'verify-email' | 'reset-password' | 'change-email';
const copy = {
  'forgot-password': {
    eyebrow: 'A FRESH WAY BACK',
    title: 'Find your way back.',
    description: 'It happens. Share your email and we’ll help you get back to your team.',
    completeTitle: 'Check your inbox.',
    completeDescription:
      'If this address is eligible, a recovery email will arrive shortly. Check your spam folder too.',
    action: 'Send recovery email',
    icon: KeyRound,
  },
  'reset-password': {
    eyebrow: 'YOUR NEXT FRESH START',
    title: 'Choose a new password.',
    description: 'Make it strong, make it yours, and get back to the work that matters.',
    completeTitle: 'Password updated.',
    completeDescription:
      'Your previous sessions have been signed out. Sign in with your new password.',
    action: 'Update password',
    icon: KeyRound,
  },
  'verify-email': {
    eyebrow: 'ONE SMALL STEP FORWARD',
    title: 'Confirm your email.',
    description: 'Confirm that this email address belongs to you to unlock your workspace.',
    completeTitle: 'Email verified.',
    completeDescription: 'You’re all set. Return to your workspace and pick up what comes next.',
    action: 'Verify email address',
    icon: Mail,
  },
  'change-email': {
    eyebrow: 'KEEP YOUR ACCOUNT CONNECTED',
    title: 'Confirm your new email.',
    description: 'Confirm this email address to complete your requested account email change.',
    completeTitle: 'Email address updated.',
    completeDescription:
      'Your email address was updated and all devices were signed out. Sign in with your new email address.',
    action: 'Confirm email change',
    icon: Mail,
  },
} as const;

export function AccountFlow({ mode }: { mode: Mode }) {
  const initialized = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);
  const fieldId = useId();
  const passwordId = `${fieldId}-password`;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const content = copy[mode];
  const Icon = complete ? (mode === 'forgot-password' ? Mail : Check) : content.icon;

  useEffect(() => {
    setReady(true);
    if (initialized.current || mode === 'forgot-password') return;
    initialized.current = true;
    const value = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname);
    setToken(value);
    if (!value) setError('Open the complete link from your email, or request a new one.');
  }, [mode]);
  useEffect(() => {
    if (complete) heading.current?.focus();
  }, [complete]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ready || (mode !== 'forgot-password' && !token)) return;
    setError('');
    const data = new FormData(event.currentTarget);
    if (mode === 'reset-password' && data.get('password') !== data.get('confirmation')) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'forgot-password')
        await post('/auth/password/forgot', { email: data.get('email') });
      else if (mode === 'verify-email') await post('/auth/verification/confirm', { token });
      else if (mode === 'change-email') await post('/auth/email/confirm', { token });
      else await post('/auth/password/reset', { token, password: data.get('password') });
      setComplete(true);
      setToken('');
      setShowPasswords(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to complete this request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <Reveal className={styles.formWrap}>
        <Reveal key={complete ? 'complete' : mode}>
          <span className={styles.formMark} aria-hidden="true">
            <Icon size={23} />
          </span>
          <div className={styles.intro}>
            <p>{complete ? 'ON TO YOUR NEXT CHAPTER' : content.eyebrow}</p>
            <h1 id="auth-title" ref={heading} tabIndex={-1}>
              {complete ? content.completeTitle : content.title}
            </h1>
            <p role={complete ? 'status' : undefined}>
              {complete ? content.completeDescription : content.description}
            </p>
          </div>
        </Reveal>
        {complete ? (
          <>
            <div className={styles.notice}>
              {mode === 'forgot-password' ? (
                <>
                  <Mail size={18} aria-hidden="true" />
                  <p>Open the recovery email and follow the link to choose a new password.</p>
                </>
              ) : (
                <>
                  <ShieldCheck size={18} aria-hidden="true" />
                  <p>
                    {mode === 'verify-email'
                      ? 'Your workspace is ready when you are.'
                      : 'Use your updated details the next time you sign in.'}
                  </p>
                </>
              )}
            </div>
            <a className={styles.submit} href={mode === 'verify-email' ? '/app' : '/sign-in'}>
              {mode === 'verify-email' ? 'Continue to workspace' : 'Go to sign in'}
              <ArrowUpRight size={17} aria-hidden="true" />
            </a>
          </>
        ) : (
          <>
            <form
              className={styles.accountForm}
              method="post"
              onSubmit={submit}
              aria-label={content.action}
              aria-busy={busy}
              aria-describedby={error ? errorId : undefined}
            >
              <fieldset
                className={styles.fields}
                disabled={busy}
                aria-label="Account recovery details"
              >
                {mode === 'forgot-password' ? (
                  <label>
                    Email address
                    <Input
                      name="email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@company.com"
                      maxLength={254}
                      required
                    />
                  </label>
                ) : mode === 'reset-password' ? (
                  <>
                    <div>
                      <label htmlFor={passwordId}>New password</label>
                      <div className={styles.passwordInput}>
                        <Input
                          id={passwordId}
                          name="password"
                          type={showPasswords ? 'text' : 'password'}
                          autoComplete="new-password"
                          minLength={12}
                          maxLength={128}
                          aria-describedby={hintId}
                          required
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          className={styles.passwordToggle}
                          aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}
                          aria-pressed={showPasswords}
                          onClick={() => setShowPasswords((value) => !value)}
                        >
                          {showPasswords ? <EyeOff size={18} /> : <Eye size={18} />}
                        </Button>
                      </div>
                      <small id={hintId} className={styles.passwordHint}>
                        At least 12 characters. Make it uniquely yours.
                      </small>
                    </div>
                    <label>
                      Confirm password
                      <Input
                        name="confirmation"
                        type={showPasswords ? 'text' : 'password'}
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={128}
                        required
                      />
                    </label>
                  </>
                ) : (
                  <div className={styles.notice}>
                    <ShieldCheck size={18} aria-hidden="true" />
                    <p>
                      {mode === 'change-email'
                        ? 'Only confirm if you requested this email change.'
                        : 'One confirmation connects your email to your account.'}
                    </p>
                  </div>
                )}
              </fieldset>
              {error && (
                <p id={errorId} className={styles.error} role="alert">
                  {error}
                </p>
              )}
              <Button
                className={styles.submit}
                type="submit"
                disabled={!ready || busy || (mode !== 'forgot-password' && !token)}
              >
                {busy ? 'One moment…' : content.action}
                {busy ? (
                  <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" />
                ) : (
                  <ArrowUpRight size={17} aria-hidden="true" />
                )}
              </Button>
            </form>
            {mode === 'reset-password' && (
              <p className={styles.signupNote}>
                Updating your password signs out your previous sessions.
              </p>
            )}
          </>
        )}
        {!complete && (
          <div className={styles.switch}>
            <a
              className={styles.returnLink}
              href={mode === 'reset-password' ? '/forgot-password' : '/sign-in'}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              {mode === 'reset-password' ? 'Request a new recovery link' : 'Back to sign in'}
            </a>
          </div>
        )}
      </Reveal>
    </AuthShell>
  );
}
