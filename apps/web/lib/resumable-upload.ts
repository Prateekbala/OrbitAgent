import type { FileUpload } from '@ao/contracts';
import { api } from './api';
export async function sha256(bytes: ArrayBuffer) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
}
export async function resumableUpload(
  id: string,
  file: File,
  signal: AbortSignal,
  progress: (percent: number) => void,
): Promise<FileUpload> {
  const state = await api<{ offset: number; size: number; chunkBytes: number; complete: boolean }>(
    `/files/${id}/upload`,
    { signal },
  );
  if (state.complete) return api<FileUpload>(`/files/${id}`, { signal });
  if (state.size !== file.size || state.offset < 0 || state.offset > file.size)
    throw new Error('The server upload does not match this file.');
  for (let offset = state.offset; offset < file.size;) {
    const bytes = await file.slice(offset, offset + state.chunkBytes).arrayBuffer();
    signal.throwIfAborted();
    const next = await api<{ offset: number }>(`/files/${id}/upload`, {
      method: 'PATCH',
      signal,
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
        'Upload-Checksum': await sha256(bytes),
      },
      body: bytes,
    });
    if (next.offset !== offset + bytes.byteLength)
      throw new Error('The upload offset changed. Retry to resume.');
    offset = next.offset;
    progress(Math.floor((offset / file.size) * 95));
  }
  return api<FileUpload>(`/files/${id}/upload/complete`, { method: 'POST', signal });
}
