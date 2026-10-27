'use client';

import { ArrowUpRight, LoaderCircle, Orbit } from 'lucide-react';
import { AuthShell } from './auth-shell';
import { Reveal } from './landing/landing-motion';
import { Button } from './ui/button';
import styles from './auth.module.css';

export function WorkspaceTransition({
  checking = false,
  error,
  onRetry,
}: {
  checking?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <AuthShell>
      <Reveal className={styles.formWrap}>
        <span className={styles.formMark} aria-hidden="true">
          <Orbit size={23} />
        </span>
        <div className={styles.intro}>
          <p>{error ? 'LET’S GET YOU CONNECTED' : 'YOUR TEAM, IN SYNC'}</p>
          <h1 id="auth-title">
            {error
              ? 'A small interruption.'
              : checking
                ? 'Finding your orbit.'
                : 'Opening your workspace.'}
          </h1>
          <p role={error ? 'alert' : 'status'}>
            {error ||
              (checking
                ? 'Checking your account so you land in the right place.'
                : 'Bringing your conversations, projects, and shared context together.')}
          </p>
        </div>
        {error ? (
          <>
            <Button className={styles.submit} onClick={onRetry}>
              Try again
              <ArrowUpRight size={17} />
            </Button>
            <div className={styles.switch}>
              <a className={styles.returnLink} href="/sign-in?reauth=1">
                Back to sign in
              </a>
            </div>
          </>
        ) : (
          <div className={styles.notice} role="status">
            <LoaderCircle size={18} className={styles.spinner} aria-hidden="true" />
            <p>{checking ? 'Checking your session…' : 'Getting everything ready…'}</p>
          </div>
        )}
      </Reveal>
    </AuthShell>
  );
}
