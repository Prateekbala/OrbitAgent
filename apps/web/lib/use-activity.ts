'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivitySnapshot, PresenceMode } from '@ao/contracts/activity';
import { api } from './api';
const empty: ActivitySnapshot = { own_mode: 'automatic', presence: [], typing: [] };
export function useActivity(identity: string | null) {
  const [snapshot, setSnapshot] = useState<{
    identity: string | null;
    data: ActivitySnapshot;
    received: number;
  }>({ identity: null, data: empty, received: 0 });
  const transport = useRef<{
    identity: string;
    client: string;
    presenceRevision: number;
    typingRevision: number;
    ready: Promise<void>;
  } | null>(null);
  const lastInput = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!identity) return;
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, [identity]);
  const receive = useCallback(
    (data: ActivitySnapshot) => {
      setSnapshot({ identity, data, received: Date.now() });
    },
    [identity],
  );
  useEffect(() => {
    if (!identity) return;
    let active = true,
      sending = false,
      dirty = false;
    const controller = new AbortController();
    const state = {
      identity,
      client: crypto.randomUUID(),
      presenceRevision: 0,
      typingRevision: 0,
      ready: Promise.resolve(),
    };
    transport.current = state;
    lastInput.current = Date.now();
    async function heartbeat() {
      if (sending) {
        dirty = true;
        return;
      }
      sending = true;
      dirty = false;
      const visible = document.visibilityState === 'visible' && document.hasFocus();
      try {
        await api('/presence', {
          method: 'PUT',
          body: JSON.stringify({
            clientId: state.client,
            revision: ++state.presenceRevision,
            state: visible && Date.now() - lastInput.current < 300000 ? 'active' : 'away',
          }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
      } catch {
      } finally {
        sending = false;
        if (active && dirty) state.ready = heartbeat();
      }
    }
    function wake() {
      if (sending) {
        dirty = true;
        return;
      }
      state.ready = heartbeat();
    }
    const onInput = () => {
      const wasIdle = Date.now() - lastInput.current >= 300000;
      lastInput.current = Date.now();
      if (wasIdle) wake();
    };
    const onFocus = () => {
      lastInput.current = Date.now();
      wake();
    };
    function leave() {
      void fetch('/api/v1/presence', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: state.client }),
        keepalive: true,
      }).catch(() => {});
    }
    wake();
    const timer = setInterval(wake, 20000);
    window.addEventListener('pointerdown', onInput, { passive: true });
    window.addEventListener('keydown', onInput);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pagehide', leave);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      leave();
      if (transport.current === state) transport.current = null;
      window.removeEventListener('pointerdown', onInput);
      window.removeEventListener('keydown', onInput);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pagehide', leave);
    };
  }, [identity]);
  const typing = useCallback(
    async (conversation: string, thread: string | undefined, active: boolean) => {
      const state = transport.current;
      if (!identity || state?.identity !== identity) return;
      const revision = ++state.typingRevision;
      await state.ready;
      if (transport.current !== state) return;
      try {
        await api(`/conversations/${conversation}/typing`, {
          method: 'PUT',
          body: JSON.stringify({
            clientId: state.client,
            revision,
            active,
            ...(thread ? { threadId: thread } : {}),
          }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {}
    },
    [identity],
  );
  async function preference(mode: PresenceMode) {
    await api('/presence/preferences', { method: 'PUT', body: JSON.stringify({ mode }) });
    const data = await api<ActivitySnapshot>('/activity');
    receive(data);
  }
  const current =
    snapshot.identity === identity ? snapshot : { identity, data: empty, received: 0 };
  return {
    snapshot:
      now - current.received > 65000
        ? {
            ...current.data,
            ...(current.received ? { presence_complete: false } : {}),
            presence: [],
            typing: [],
          }
        : current.data,
    received: current.received,
    receive,
    typing,
    preference,
  };
}
