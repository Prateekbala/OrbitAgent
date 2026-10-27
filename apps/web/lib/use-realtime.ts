'use client';
import { activitySnapshot, type ActivitySnapshot } from '@ao/contracts/activity';
import { useEffect, useRef, useState } from 'react';
import { realtimeBatch } from '@ao/contracts/messaging';
import type { RealtimeBatch } from '@ao/contracts/messaging';

export function useRealtime(
  workspace: string | null,
  onChange: (events?: RealtimeBatch['events']) => Promise<void>,
  onAuthChange: () => Promise<void>,
  onActivity?: (snapshot: ActivitySnapshot) => void,
  onRevoked?: (conversationIds: string[]) => void,
) {
  const [state, setState] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const handlers = useRef({ onChange, onAuthChange, onActivity, onRevoked });
  useEffect(() => {
    handlers.current = { onChange, onAuthChange, onActivity, onRevoked };
  }, [onChange, onAuthChange, onActivity, onRevoked]);
  useEffect(() => {
    if (!workspace) return;
    let active = true,
      source: EventSource | null = null,
      reconnectTimer: ReturnType<typeof setTimeout> | undefined,
      refreshTimer: ReturnType<typeof setTimeout> | undefined,
      refreshing = false,
      dirty = false,
      fullRefresh = false;
    const events = new Map<string, RealtimeBatch['events'][number]>();
    async function flush() {
      if (!active || refreshing || !dirty) return;
      refreshing = true;
      dirty = false;
      const changes = fullRefresh ? undefined : [...events.values()];
      fullRefresh = false;
      events.clear();
      try {
        await handlers.current.onChange(changes);
      } catch {
        dirty = true;
        fullRefresh = true;
      } finally {
        refreshing = false;
        if (active && dirty) refreshTimer = setTimeout(() => void flush(), 1000);
      }
    }
    function refresh(changes?: RealtimeBatch['events']) {
      dirty = true;
      if (!changes) fullRefresh = true;
      else if (!fullRefresh)
        for (const event of changes) {
          events.set(
            `${event.event_type}:${event.resource_id}:${event.conversation_id ?? ''}`,
            event,
          );
          if (events.size > 100) {
            events.clear();
            fullRefresh = true;
            break;
          }
        }
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void flush(), 75);
    }
    function connect() {
      if (!active) return;
      source = new EventSource('/api/v1/events/stream');
      source.addEventListener('ready', () => {
        if (active) {
          setState('live');
          refresh();
        }
      });
      source.addEventListener('changes', (event) => {
        if (!active) return;
        try {
          const batch = realtimeBatch.parse(JSON.parse((event as MessageEvent<string>).data));
          const revoked = batch.events
            .filter((change) => change.event_type === 'conversation.access_revoked')
            .map((change) => change.resource_id);
          if (revoked.length) handlers.current.onRevoked?.([...new Set(revoked)]);
          if (batch.events.length) refresh(batch.events);
        } catch {
          source?.close();
          setState('reconnecting');
          reconnectTimer = setTimeout(connect, 1500);
        }
      });
      source.addEventListener('activity', (event) => {
        if (!active) return;
        try {
          const parsed = activitySnapshot.safeParse(
            JSON.parse((event as MessageEvent<string>).data),
          );
          if (parsed.success) handlers.current.onActivity?.(parsed.data);
        } catch {}
      });
      source.addEventListener('auth-required', () => {
        source?.close();
        if (active) {
          setState('reconnecting');
          void handlers.current.onAuthChange();
        }
      });
      source.onerror = () => {
        if (!active) return;
        setState('reconnecting');
        if (source?.readyState === EventSource.CLOSED) {
          void handlers.current.onAuthChange();
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const onOnline = () => refresh();
    setState('connecting');
    connect();
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      source?.close();
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [workspace]);
  return state;
}
