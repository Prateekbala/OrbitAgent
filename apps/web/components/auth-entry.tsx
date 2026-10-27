'use client';

import { useEffect, useState } from 'react';
import type { AccountStatus } from '@ao/contracts';
import { api } from '../lib/api';
import { entryPath } from '../lib/auth-navigation';
import { Auth } from './auth';
import { WorkspaceTransition } from './workspace-transition';

export function AuthEntry({ register = false }: { register?: boolean }) {
  const [phase, setPhase] = useState<'checking' | 'form' | 'opening'>('checking');
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(window.location.search);
    if (params.get('mfa') === '1' || params.get('reauth') === '1') {
      setPhase('form');
      return;
    }
    void api<AccountStatus>('/auth/status', { signal: controller.signal })
      .then((status) => {
        if (controller.signal.aborted) return;
        if (status.signedIn) {
          setPhase('opening');
          window.location.replace(entryPath('/app', window.location.search));
        } else setPhase('form');
      })
      .catch(() => {
        if (!controller.signal.aborted) setPhase('form');
      });
    return () => controller.abort();
  }, []);
  if (phase !== 'form') return <WorkspaceTransition checking={phase === 'checking'} />;
  return (
    <Auth
      key={register ? 'signup' : 'signin'}
      initialRegister={register}
      navigation="routes"
      onComplete={() => {
        setPhase('opening');
        window.location.replace(entryPath('/app', window.location.search));
      }}
    />
  );
}
