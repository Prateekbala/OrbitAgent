'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ExternalLink, LoaderCircle, Mail, Send } from 'lucide-react';
import type { AccountStatus } from '@ao/contracts';
import { Button } from './ui/button';
import { AuthShell } from './auth-shell';
import { Reveal } from './landing/landing-motion';
import { api, post } from '../lib/api';
import styles from './auth.module.css';

type PendingAction = 'check' | 'resend' | 'signout' | null;

export function VerificationGate({ onContinue }: { onContinue: () => Promise<void> }) {
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<PendingAction>(null);
  const busy = pending !== null;

  useEffect(() => {
    const controller = new AbortController();
    void api<AccountStatus>('/auth/status', { signal: controller.signal })
      .then(setAccount)
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Unable to load your account.');
      });
    return () => controller.abort();
  }, []);

  async function resend() {
    if (busy || !account?.email) return;
    setPending('resend');
    setError('');
    setNotice('');
    try {
      await post('/auth/verification/request', { email: account.email });
      setNotice(
        'If your address is eligible, a verification email will arrive shortly. You can request another after one minute.',
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to request verification.');
    } finally {
      setPending(null);
    }
  }

  async function check() {
    if (busy) return;
    setPending('check');
    setError('');
    setNotice('');
    try {
      const current = await api<AccountStatus>('/auth/status');
      setAccount(current);
      if (!current.signedIn) {
        window.location.assign('/sign-in');
        return;
      }
      if (current.verified) await onContinue();
      else setError('Your email has not been verified yet. Open the email and confirm the link.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to check verification.');
    } finally {
      setPending(null);
    }
  }

  async function signOut() {
    if (busy) return;
    setPending('signout');
    setError('');
    setNotice('');
    try {
      await post('/auth/signout', {});
      window.location.assign('/sign-in');
    } catch {
      setError('Unable to sign out. Try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <AuthShell>
      <Reveal className={styles.formWrap}>
        <span className={styles.formMark} aria-hidden="true">
          <Mail size={23} />
        </span>
        <Reveal className={styles.intro}>
          <p>ONE MORE STEP</p>
          <h1 id="auth-title">Verify your email.</h1>
          <p>
            Your next chapter is almost ready. Open your verification email and follow the link to
            access your workspace.
          </p>
        </Reveal>
        <div className={styles.emailCard}>
          <Send size={18} aria-hidden="true" />
          <div>
            <span>Look for your verification email at</span>
            <strong>{account?.email ?? 'your email address'}</strong>
          </div>
        </div>
        {account?.developmentInbox ? (
          <div className={styles.notice}>
            <Mail size={18} aria-hidden="true" />
            <div>
              <p>
                Development mode: messages stay in your local inbox. Nothing is sent externally.
              </p>
              <a
                className={styles.inlineLink}
                href={account.developmentInbox}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open development inbox
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
          </div>
        ) : (
          <p className={styles.deliveryHint}>Can’t see it? Check your spam folder too.</p>
        )}
        {account && !account.deliveryAvailable && (
          <p className={styles.error}>
            Email delivery needs to be configured by the workspace operator.
          </p>
        )}
        <Button
          className={styles.submit}
          type="button"
          disabled={busy}
          onClick={() => void check()}
        >
          {pending === 'check' ? 'Checking your email…' : 'I’ve verified my email'}
          {pending === 'check' ? (
            <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" />
          ) : (
            <ArrowUpRight size={17} aria-hidden="true" />
          )}
        </Button>
        <div className={styles.resendRow}>
          <span>Need another email?</span>
          <Button
            variant="link"
            className={styles.switchButton}
            type="button"
            disabled={busy || !account?.deliveryAvailable}
            onClick={() => void resend()}
          >
            {pending === 'resend' ? 'Requesting email…' : 'Resend verification email'}
          </Button>
        </div>
        {notice && (
          <div className={styles.notice} role="status">
            <Mail size={18} aria-hidden="true" />
            <p>{notice}</p>
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.switch}>
          <Button
            variant="link"
            className={styles.switchButton}
            disabled={busy}
            type="button"
            onClick={() => void signOut()}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            {pending === 'signout' ? 'Signing out…' : 'Use another account'}
          </Button>
        </div>
      </Reveal>
    </AuthShell>
  );
}
