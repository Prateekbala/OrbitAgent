'use client';
import { useEffect, useRef, useState } from 'react';
import type { FileUpload } from '@ao/contracts';
import { maxAttachments, maxFileBytes } from '@ao/contracts/files';
import { api, post } from './api';
import { resumableUpload } from './resumable-upload';
export interface UploadDraft {
  key: string;
  file: File;
  status: 'uploading' | 'ready' | 'failed';
  progress: number;
  remote?: FileUpload;
  error?: string;
}
function uploadContent(
  id: string,
  file: File,
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  return new Promise<FileUpload>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = () => signal.removeEventListener('abort', abort);
    xhr.open('PUT', `/api/v1/files/${id}/content`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      finish();
      try {
        const body = JSON.parse(xhr.responseText) as FileUpload & { error?: { message?: string } };
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error?.message ?? 'Upload failed.'));
      } catch {
        reject(new Error('The upload response was interrupted.'));
      }
    };
    xhr.onerror = () => {
      finish();
      reject(new Error('Upload connection lost.'));
    };
    xhr.onabort = () => {
      finish();
      reject(new DOMException('Upload cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      finish();
      reject(new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    const data = new FormData();
    data.append('file', file);
    xhr.send(data);
  });
}
export function useAttachments(
  conversationId: string,
  kind: 'conversation' | 'task' = 'conversation',
) {
  const [items, setItems] = useState<UploadDraft[]>([]),
    [error, setError] = useState('');
  const current = useRef<UploadDraft[]>([]),
    controllers = useRef(new Map<string, AbortController>()),
    alive = useRef(true),
    queue = useRef<UploadDraft[]>([]),
    running = useRef(0);
  function update(work: (items: UploadDraft[]) => UploadDraft[]) {
    current.current = work(current.current);
    if (alive.current) setItems(current.current);
  }
  useEffect(() => {
    alive.current = true;
    const active = controllers.current;
    return () => {
      alive.current = false;
      queue.current = [];
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, []);
  async function upload(item: UploadDraft) {
    const controller = new AbortController();
    controllers.current.set(item.key, controller);
    const patch = (value: Partial<UploadDraft>) =>
      update((items) => items.map((row) => (row.key === item.key ? { ...row, ...value } : row)));
    patch({ status: 'uploading', progress: 0, error: '' });
    let remote: FileUpload | undefined = item.remote;
    try {
      const bytes = await item.file.arrayBuffer();
      controller.signal.throwIfAborted();
      const checksum = await crypto.subtle.digest('SHA-256', bytes);
      controller.signal.throwIfAborted();
      const sha256 = Array.from(new Uint8Array(checksum), (v) =>
        v.toString(16).padStart(2, '0'),
      ).join('');
      remote ??= await post<FileUpload>(
        `/${kind === 'task' ? 'tasks' : 'conversations'}/${conversationId}/files`,
        {
          name: item.file.name,
          size: item.file.size,
          sha256,
          clientId: item.key,
        },
      );
      controller.signal.throwIfAborted();
      patch({ remote });
      try {
        remote = await (item.file.size > 1024 * 1024 ? resumableUpload : uploadContent)(
          remote.id,
          item.file,
          controller.signal,
          (progress) => patch({ progress }),
        );
      } catch (error) {
        controller.signal.throwIfAborted();
        const recovered = await api<FileUpload>(`/files/${remote.id}`, {
          signal: controller.signal,
        });
        if (recovered.status !== 'ready') throw error;
        remote = recovered;
      }
      controller.signal.throwIfAborted();
      patch({ status: 'ready', progress: 100, remote });
    } catch (error) {
      if (controller.signal.aborted) {
        if (remote) void api(`/files/${remote.id}`, { method: 'DELETE' }).catch(() => {});
        return;
      }
      patch({
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unable to upload file.',
      });
    } finally {
      controllers.current.delete(item.key);
    }
  }
  function add(files: FileList | null) {
    setError('');
    const added: UploadDraft[] = [];
    for (const file of Array.from(files ?? [])) {
      if (current.current.length + added.length >= maxAttachments) {
        setError(
          `Attach up to ${maxAttachments} files per ${kind === 'task' ? 'batch' : 'message'}.`,
        );
        break;
      }
      if (!file.size || file.size > maxFileBytes) {
        setError('Choose non-empty files up to 25 MB each.');
        continue;
      }
      added.push({ key: crypto.randomUUID(), file, status: 'uploading', progress: 0 });
    }
    update((items) => [...items, ...added]);
    queue.current.push(...added);
    pump();
  }
  function pump() {
    while (alive.current && running.current < 2) {
      const item = queue.current.shift();
      if (!item) return;
      if (!current.current.some((row) => row.key === item.key)) continue;
      running.current++;
      void upload(item).finally(() => {
        running.current--;
        pump();
      });
    }
  }
  function retry(item: UploadDraft) {
    if (current.current.find((row) => row.key === item.key)?.status !== 'failed') return;
    update((items) =>
      items.map((row) => (row.key === item.key ? { ...row, status: 'uploading', error: '' } : row)),
    );
    queue.current.push(item);
    pump();
  }

  function remove(key: string) {
    controllers.current.get(key)?.abort();
    const item = current.current.find((row) => row.key === key);
    update((items) => items.filter((row) => row.key !== key));
    if (item?.remote) void api(`/files/${item.remote.id}`, { method: 'DELETE' }).catch(() => {});
  }
  return {
    items,
    error,
    add,
    remove,
    retry,
    restore: async (ids: string[]) => {
      const restored = await Promise.all(
        ids.map(async (id) => {
          const remote = await api<FileUpload>(`/files/${id}`);
          if (remote.status !== 'ready')
            throw new Error(
              'A draft attachment expired or was already sent. Remove it before sending.',
            );
          return {
            key: id,
            file: new File([], remote.name, { type: remote.content_type }),
            status: 'ready' as const,
            progress: 100,
            remote,
          };
        }),
      );
      if (alive.current)
        update((items) => [
          ...items,
          ...restored.filter((row) => !items.some((i) => i.remote?.id === row.remote.id)),
        ]);
    },
    clear: () => update(() => []),
  };
}
