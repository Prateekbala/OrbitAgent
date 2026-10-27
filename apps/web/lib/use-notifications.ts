'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationPage } from '@ao/contracts';
import { api } from './api';
export function useNotifications(identity: string | null) {
  const [state, setState] = useState({ identity: null as string | null, count: 0, revision: 0 });
  const current = useRef<{ identity: string; controller: AbortController; version: number } | null>(
    null,
  );
  const refresh = useCallback(async () => {
    const scope = current.current;
    if (!identity || scope?.identity !== identity) return;
    const version = ++scope.version;
    const result = await api<NotificationPage>('/notifications?limit=1', {
      signal: scope.controller.signal,
    });
    if (current.current === scope && scope.version === version)
      setState((previous) => ({
        identity,
        count: result.unread_count,
        revision: previous.revision + 1,
      }));
  }, [identity]);
  useEffect(() => {
    if (!identity) return;
    const scope = { identity, controller: new AbortController(), version: 0 };
    current.current = scope;
    void refresh().catch(() => {});
    return () => {
      scope.controller.abort();
      if (current.current === scope) current.current = null;
    };
  }, [identity, refresh]);
  const invalidate = useCallback(() => {
    if (current.current?.identity === identity) current.current.version++;
    setState((previous) => ({ identity, count: 0, revision: previous.revision + 1 }));
  }, [identity]);
  return {
    count: state.identity === identity ? state.count : 0,
    revision: state.revision,
    refresh,
    invalidate,
  };
}
