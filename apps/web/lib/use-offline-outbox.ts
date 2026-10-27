'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import { api, HttpError } from './api';
import { readPrivate, writePrivate, removePrivate } from './private-storage';
export interface OutboxMessage {
  clientId: string;
  conversationId: string;
  authorId: string;
  membershipVersion?: number;
  accessInterval?: string | null;
  body: string;
  format: 'markdown';
  attachmentIds: string[];
  mentionIds: string[];
  threadId?: string;
  sendAt?: string;
  status: 'sending' | 'queued' | 'blocked';
  error?: string;
  createdAt: number;
  attemptedAt: number;
}
export async function saveOutbox(scope: string, item: OutboxMessage) {
  await writePrivate(scope, 'outbox', item.clientId, item.conversationId, item);
}
export function useOfflineOutbox(identity: string | null, onDelivered: () => Promise<unknown>) {
  const [items, setItems] = useState<OutboxMessage[]>([]),
    [online, setOnline] = useState(true),
    [error, setError] = useState('');
  const current = useRef(identity),
    draining = useRef(false),
    delivered = useRef(onDelivered);
  current.current = identity;
  delivered.current = onDelivered;
  const refresh = useCallback(async () => {
    if (!identity) return;
    try {
      const rows = await readPrivate<OutboxMessage>(identity, 'outbox');
      if (current.current === identity)
        setItems(rows.map((r) => r.value).sort((a, b) => a.createdAt - b.createdAt));
    } catch (e) {
      if (current.current === identity)
        setError(e instanceof Error ? e.message : 'Local message storage is unavailable.');
    }
  }, [identity]);
  const drain = useCallback(async () => {
    if (!identity || draining.current || !navigator.onLine) return;
    draining.current = true;
    try {
      const rows = (await readPrivate<OutboxMessage>(identity, 'outbox'))
        .filter(
          ({ value: item }) =>
            item.status !== 'blocked' &&
            !(item.status === 'sending' && Date.now() - item.attemptedAt < 30000),
        )
        .sort((a, b) => a.value.createdAt - b.value.createdAt)
        .slice(0, 50);
      if (!rows.length) return;
      const boot = await api<Bootstrap>('/bootstrap');
      if (`${boot.workspace.id}:${boot.me.id}` !== identity) return;
      let sent = false;
      for (const { value: item } of rows) {
        if (current.current !== identity || !navigator.onLine) break;
        if (
          item.status === 'blocked' ||
          (item.status === 'sending' && Date.now() - item.attemptedAt < 30000)
        )
          continue;
        try {
          if (boot.me.id !== item.authorId) break;
          if (Date.now() - item.createdAt > 7 * 86400000)
            throw new HttpError(410, 'This queued message expired. Review and send a new message.');
          const { body, format, clientId, attachmentIds, mentionIds, threadId } = item;
          await api(
            `/conversations/${item.conversationId}/${item.sendAt ? 'scheduled-messages' : 'messages'}`,
            {
              method: 'POST',
              body: JSON.stringify({
                body,
                format,
                clientId,
                attachmentIds,
                mentionIds,
                expectedAuthorId: item.authorId,
                ...(item.membershipVersion
                  ? { expectedMembershipVersion: item.membershipVersion }
                  : {}),
                ...(item.accessInterval !== undefined
                  ? { expectedAccessInterval: item.accessInterval }
                  : {}),
                ...(threadId ? { threadId } : {}),
                ...(item.sendAt ? { sendAt: item.sendAt } : {}),
              }),
            },
          );
          if (current.current !== identity) break;
          await removePrivate(identity, 'outbox', item.clientId);
          sent = true;
        } catch (e) {
          if (current.current !== identity) break;
          if (e instanceof HttpError && [408, 429].includes(e.status)) break;
          if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
            await saveOutbox(identity, {
              ...item,
              status: 'blocked',
              error: e.message,
              attemptedAt: Date.now(),
            });
            if (e.status === 401) break;
          } else break;
        }
      }
      if (sent && current.current === identity) await delivered.current();
    } catch (e) {
      if (current.current === identity)
        setError(e instanceof Error ? e.message : 'Unable to send queued messages.');
    } finally {
      draining.current = false;
      await refresh();
    }
  }, [identity, refresh]);
  useEffect(() => {
    setItems([]);
    setError('');
    setOnline(navigator.onLine);
    if (!identity) return;
    let disposed = false;
    const update = () => {
        if (!disposed) void refresh();
      },
      connected = () => {
        setOnline(true);
        void drain();
      },
      disconnected = () => setOnline(false);
    window.addEventListener('orbit:private-messaging', update);
    window.addEventListener('online', connected);
    window.addEventListener('offline', disconnected);
    void refresh();
    void drain();
    const timer = setInterval(() => void drain(), 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('orbit:private-messaging', update);
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', disconnected);
    };
  }, [identity, refresh, drain]);
  return {
    items,
    online,
    error,
    refresh,
    retry: async (item: OutboxMessage) => {
      if (identity) {
        await saveOutbox(identity, { ...item, status: 'queued', attemptedAt: 0, error: '' });
        await drain();
      }
    },
    remove: async (id: string) => {
      if (identity) await removePrivate(identity, 'outbox', id);
    },
  };
}
