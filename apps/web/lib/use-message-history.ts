'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { MessageHistory } from '@ao/contracts';
import { api, HttpError } from './api';

const empty: MessageHistory = { items: [], older: null, newer: null };
function merge(a: MessageHistory, b: MessageHistory): MessageHistory {
  const items = [...new Map([...a.items, ...b.items].map((item) => [item.id, item])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  );
  return {
    items,
    older: items[0]?.id === b.items[0]?.id ? b.older : a.older,
    newer: items.at(-1)?.id === b.items.at(-1)?.id ? b.newer : a.newer,
  };
}
export function useMessageHistory(
  identity: string | null,
  conversation: string,
  thread: string | null,
  around: string | null,
  enabled: boolean,
) {
  const scope = `${identity}:${conversation}:${thread}:${around}`;
  const [value, setValue] = useState<MessageHistory>(empty),
    [busy, setBusy] = useState(false),
    [paging, setPaging] = useState(false),
    [error, setError] = useState('');
  const state = useRef({
    scope,
    value: empty,
    generation: 0,
    running: false,
    dirty: false,
    pending: [] as ('older' | 'newer')[],
    controller: null as AbortController | null,
  });
  useLayoutEffect(() => {
    state.current.controller?.abort();
    state.current = {
      scope,
      value: empty,
      generation: state.current.generation + 1,
      running: false,
      dirty: false,
      pending: [],
      controller: null,
    };
    setValue(empty);
    setBusy(false);
    setPaging(false);
    setError('');
    return () => {
      state.current.controller?.abort();
      state.current.generation++;
    };
  }, [scope]);
  const clear = useCallback(() => {
    state.current.controller?.abort();
    state.current.generation++;
    state.current.running = false;
    state.current.pending = [];
    state.current.dirty = false;
    state.current.value = empty;
    setValue(empty);
    setBusy(false);
    setPaging(false);
    setError('');
  }, []);
  const run = useCallback(
    async (kind: 'refresh' | 'older' | 'newer'): Promise<boolean> => {
      if (!enabled || !identity || !conversation || state.current.scope !== scope) return true;
      const current = state.current;
      if (kind !== 'refresh') setPaging(true);
      if (current.running) {
        if (kind === 'refresh') current.dirty = true;
        else if (!current.pending.includes(kind)) current.pending.push(kind);
        return true;
      }
      current.running = true;
      setBusy(true);
      setError('');
      const generation = current.generation,
        controller = new AbortController();
      current.controller = controller;
      const valid = () =>
        state.current === current &&
        current.generation === generation &&
        !controller.signal.aborted;
      const get = (position: Record<string, string>) => {
        const params = new URLSearchParams({
          limit: '100',
          ...(thread ? { threadId: thread } : {}),
          ...position,
        });
        return api<MessageHistory>(`/conversations/${conversation}/messages/history?${params}`, {
          signal: controller.signal,
        });
      };
      let success = true,
        again = false;
      try {
        do {
          if (kind === 'refresh') current.dirty = false;
          const boundary = kind === 'older' ? current.value.older : current.value.newer;
          let next: MessageHistory;
          if (kind === 'refresh') {
            const low = current.value.items[0]?.sequence,
              high = current.value.items.at(-1)?.sequence;
            next = await get(around ? { around } : {});
            while (
              valid() &&
              low !== undefined &&
              next.older !== null &&
              next.items[0]!.sequence > low
            )
              next = merge(next, await get({ before: String(next.older) }));
            while (
              valid() &&
              around &&
              high !== undefined &&
              next.newer !== null &&
              next.items.at(-1)!.sequence < high
            )
              next = merge(next, await get({ after: String(next.newer) }));
          } else if (boundary === null) next = current.value;
          else
            next = merge(
              current.value,
              await get({ [kind === 'older' ? 'before' : 'after']: String(boundary) }),
            );
          if (valid()) {
            current.value = next;
            setValue(next);
          }
          const queued = current.pending.shift();
          again = queued !== undefined || current.dirty;
          kind = queued ?? 'refresh';
        } while (valid() && again);
      } catch (e) {
        if (valid()) {
          current.pending = [];
          current.dirty = false;
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            current.value = empty;
            setValue(empty);
          }
          setError(e instanceof Error ? e.message : 'Unable to load history.');
          success = false;
        }
      } finally {
        if (valid()) {
          current.running = false;
          setBusy(false);
          setPaging(false);
        }
      }
      return success;
    },
    [scope, identity, conversation, thread, around, enabled],
  );
  const refresh = useCallback(() => run('refresh'), [run]);
  return {
    ...value,
    busy,
    paging,
    error,
    clear,
    refresh,
    olderPage: () => run('older'),
    newerPage: () => run('newer'),
  };
}
