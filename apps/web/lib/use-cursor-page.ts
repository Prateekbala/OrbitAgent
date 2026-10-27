'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CursorPage } from '@ao/contracts/personal';
import { api, HttpError } from './api';
export function useCursorPage<T extends { id: string }>(
  scope: string | null,
  path: string,
  revision = 0,
) {
  const [page, setPage] = useState<CursorPage<T>>({ items: [], next: null }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const state = useRef({
    scope,
    path,
    generation: 0,
    controller: null as AbortController | null,
    count: 1,
    page: { items: [], next: null } as CursorPage<T>,
  });
  const fetchPage = useCallback(
    async (more = false) => {
      if (!scope) return;
      const current = state.current;
      if (current.scope !== scope || current.path !== path) return;
      current.controller?.abort();
      const controller = new AbortController(),
        generation = ++current.generation;
      current.controller = controller;
      setBusy(true);
      setError('');
      const valid = () =>
        state.current === current &&
        current.generation === generation &&
        !controller.signal.aborted;
      try {
        const get = async (after: string | null) => {
          const response = await api<CursorPage<T> & { next_after?: string | null }>(
            path +
              (path.includes('?') ? '&' : '?') +
              'limit=40' +
              (after ? '&after=' + encodeURIComponent(after) : ''),
            { signal: controller.signal },
          );
          return { items: response.items, next: response.next ?? response.next_after ?? null };
        };
        let next: CursorPage<T>;
        if (more) {
          if (!current.page.next) return;
          const loaded = await get(current.page.next);
          next = {
            items: [
              ...new Map([...current.page.items, ...loaded.items].map((v) => [v.id, v])).values(),
            ],
            next: loaded.next,
          };
          current.count++;
        } else {
          next = await get(null);
          for (let i = 1; i < current.count && next.next && valid(); i++) {
            const loaded = await get(next.next);
            next = { items: [...next.items, ...loaded.items], next: loaded.next };
          }
        }
        if (valid()) {
          current.page = next;
          setPage(next);
        }
      } catch (e) {
        if (valid()) {
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            current.page = { items: [], next: null };
            setPage(current.page);
          }
          setError(e instanceof Error ? e.message : 'Unable to load this view.');
        }
      } finally {
        if (valid()) setBusy(false);
      }
    },
    [scope, path],
  );
  useEffect(() => {
    state.current.controller?.abort();
    state.current = {
      scope,
      path,
      generation: state.current.generation + 1,
      controller: null,
      count: 1,
      page: { items: [], next: null },
    };
    setPage({ items: [], next: null });
    void fetchPage();
    return () => state.current.controller?.abort();
  }, [scope, path, fetchPage]);
  useEffect(() => {
    if (revision) void fetchPage();
  }, [revision, fetchPage]);
  const visible =
    state.current.scope === scope && state.current.path === path ? page : { items: [], next: null };
  return { ...visible, busy, error, refresh: fetchPage, more: () => fetchPage(true) };
}
