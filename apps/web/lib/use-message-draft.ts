'use client';
import { useEffect, useRef, useState } from 'react';
import { api, HttpError } from './api';
import { readPrivate, writePrivate } from './private-storage';
interface DraftSnapshot {
  body: string;
  attachmentIds: string[];
  version: number;
  dirty: boolean;
}
export function useMessageDraft(scope: string, conversation: string, thread: string | undefined) {
  const key = conversation + ':' + (thread ?? ''),
    [value, setValue] = useState<DraftSnapshot>({
      body: '',
      attachmentIds: [],
      version: 0,
      dirty: false,
    }),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState<DraftSnapshot | null>(null);
  const latest = useRef(value),
    alive = useRef(false),
    saving = useRef(false),
    needsSave = useRef(false);
  latest.current = value;
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const [cached] = await readPrivate<DraftSnapshot>(scope, 'draft', key);
        if (!alive.current || controller.signal.aborted) return;
        if (cached) setValue(cached.value);
        if (navigator.onLine) {
          try {
            const remote = await api<DraftSnapshot>(
              `/conversations/${conversation}/draft${thread ? '?threadId=' + thread : ''}`,
              { signal: controller.signal },
            );
            if (!alive.current || controller.signal.aborted) return;
            if (
              cached?.value.dirty &&
              cached.value.version !== remote.version &&
              (cached.value.body !== remote.body ||
                JSON.stringify(cached.value.attachmentIds) !== JSON.stringify(remote.attachmentIds))
            ) {
              setConflict(remote);
            } else if (!cached?.value.dirty || cached.value.version !== remote.version) {
              const next = { ...remote, dirty: false };
              setValue(next);
              void writePrivate(scope, 'draft', key, conversation, next).catch(() => {});
            }
          } catch (e) {
            if (e instanceof HttpError && [401, 403, 404].includes(e.status)) throw e;
          }
        }
        if (alive.current) setReady(true);
      } catch (e) {
        if (alive.current && !controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to restore your draft.');
      }
    })();
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [scope, key, conversation, thread]);
  useEffect(() => {
    if (!ready || !value.dirty) return;
    const snapshot = value;
    void writePrivate(scope, 'draft', key, conversation, snapshot).catch((e) => {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Your draft could not be saved locally.');
    });
    const timer = setTimeout(() => void sync(), 600);
    return () => clearTimeout(timer);
    async function sync() {
      if (!navigator.onLine || conflict) return;
      if (saving.current) {
        needsSave.current = true;
        return;
      }
      saving.current = true;
      try {
        const response = await api<{ version: number }>(`/conversations/${conversation}/draft`, {
          method: 'PUT',
          body: JSON.stringify({
            body: snapshot.body,
            format: 'markdown',
            attachmentIds: snapshot.attachmentIds,
            mentionIds: [],
            version: snapshot.version,
            ...(thread ? { threadId: thread } : {}),
          }),
        });
        if (!alive.current) return;
        const next = {
          ...latest.current,
          version: response.version,
          dirty:
            latest.current.body !== snapshot.body ||
            JSON.stringify(latest.current.attachmentIds) !==
              JSON.stringify(snapshot.attachmentIds) ||
            needsSave.current,
        };
        latest.current = next;
        setValue(next);
        needsSave.current = false;
        setError('');
        await writePrivate(scope, 'draft', key, conversation, next);
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof HttpError && e.code === 'DRAFT_CONFLICT') {
          try {
            const remote = await api<DraftSnapshot>(
              `/conversations/${conversation}/draft${thread ? '?threadId=' + thread : ''}`,
            );
            if (alive.current) {
              if (
                remote.body === snapshot.body &&
                JSON.stringify(remote.attachmentIds) === JSON.stringify(snapshot.attachmentIds)
              ) {
                const next = {
                  ...latest.current,
                  version: remote.version,
                  dirty:
                    latest.current.body !== remote.body ||
                    JSON.stringify(latest.current.attachmentIds) !==
                      JSON.stringify(remote.attachmentIds),
                };
                latest.current = next;
                setValue(next);
                await writePrivate(scope, 'draft', key, conversation, next);
              } else setConflict(remote);
            }
          } catch (cause) {
            if (alive.current)
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'Unable to retrieve the conflicting draft.',
              );
          }
        } else setError(e instanceof Error ? e.message : 'Your draft is saved on this device.');
      } finally {
        saving.current = false;
      }
    }
  }, [value, ready, conflict, scope, key, conversation, thread]);
  useEffect(() => {
    const online = () => setValue((v) => ({ ...v }));
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);
  return {
    value,
    ready,
    error,
    conflict,
    setBody: (body: string) => setValue((v) => ({ ...v, body, dirty: true })),
    setAttachments: (attachmentIds: string[]) =>
      setValue((v) =>
        JSON.stringify(v.attachmentIds) === JSON.stringify(attachmentIds)
          ? v
          : { ...v, attachmentIds, dirty: true },
      ),
    clear: async () => {
      const next = { ...latest.current, body: '', attachmentIds: [], dirty: true };
      latest.current = next;
      if (alive.current) setValue(next);
      await writePrivate(scope, 'draft', key, conversation, next);
    },
    resolve: (useRemote: boolean) => {
      if (!conflict) return;
      const next = useRemote
        ? { ...conflict, dirty: false }
        : { ...latest.current, version: conflict.version, dirty: true };
      latest.current = next;
      setValue(next);
      void writePrivate(scope, 'draft', key, conversation, next).catch(() => {});
      setConflict(null);
    },
  };
}
