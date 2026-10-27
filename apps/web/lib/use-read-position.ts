'use client';
import { useCallback, useEffect, useRef } from 'react';
import type { Message } from '@ao/contracts';
import { api } from './api';

export function useReadPosition(channel: string, enabled: boolean) {
  const dispatch = useRef<(message: Message) => void>(() => {});
  useEffect(() => {
    if (!enabled || !channel) {
      dispatch.current = () => {};
      return;
    }
    const controller = new AbortController(),
      confirmed = new Map<string, number>(),
      pending = new Map<string, Message>();
    let timer: ReturnType<typeof setTimeout> | undefined,
      sending = false;
    async function flush() {
      if (sending || controller.signal.aborted) return;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      sending = true;
      const batch = [...pending.entries()];
      pending.clear();
      let failed = false;
      await Promise.all(
        batch.map(async ([scope, message]) => {
          try {
            await api(`/conversations/${channel}/read`, {
              method: 'PUT',
              body: JSON.stringify({ messageId: message.id }),
              signal: controller.signal,
            });
            confirmed.set(scope, Math.max(confirmed.get(scope) ?? 0, message.sequence));
          } catch {
            failed = true;
            if ((pending.get(scope)?.sequence ?? 0) < message.sequence) pending.set(scope, message);
          }
        }),
      );
      sending = false;
      if (pending.size && !controller.signal.aborted)
        timer = setTimeout(() => void flush(), failed ? 5000 : 350);
    }
    dispatch.current = (message) => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const scope = message.thread_id ?? 'main';
      if (
        message.sequence <= Math.max(confirmed.get(scope) ?? 0, pending.get(scope)?.sequence ?? 0)
      )
        return;
      pending.set(scope, message);
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), 350);
    };
    const onFocus = () => {
      if (pending.size) void flush();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      controller.abort();
      clearTimeout(timer);
      dispatch.current = () => {};
      window.removeEventListener('focus', onFocus);
    };
  }, [channel, enabled]);
  return useCallback((message: Message) => dispatch.current(message), []);
}
