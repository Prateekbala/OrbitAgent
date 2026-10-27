'use client';
import { Textarea } from './ui/textarea';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { useEffect, useRef, useState } from 'react';
import { post } from '../lib/api';
export function SharedChannelComposer({
  grantId,
  threadId,
  onSent,
  onError,
}: {
  grantId: string;
  threadId: string | null;
  onSent: () => void;
  onError: (message: string) => void;
}) {
  const [body, setBody] = useState(''),
    [files, setFiles] = useState<{ id: string; name: string }[]>([]),
    [busy, setBusy] = useState(false);
  const request = useRef<{ fingerprint: string; clientId: string } | null>(null),
    controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function upload(file: File) {
    if (busy || files.length >= 10) return;
    if (file.size > 25 * 1024 * 1024) {
      onError('Choose a file smaller than 25 MB.');
      return;
    }
    setBusy(true);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
      )
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const reserved = await post<{ id: string }>('/shared-channels/' + grantId + '/files', {
        clientId: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        sha256: hash,
      });
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(
        '/api/v1/shared-channels/' + grantId + '/files/' + reserved.id + '/content',
        { method: 'PUT', body: form, signal: abort.signal },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error?.message ?? 'The upload failed.');
      }
      if (!abort.signal.aborted)
        setFiles((current) => [...current, { id: reserved.id, name: file.name }]);
    } catch (e) {
      if (!abort.signal.aborted) onError(e instanceof Error ? e.message : 'The upload failed.');
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  async function send() {
    if (busy || (!body.trim() && !files.length)) return;
    setBusy(true);
    const input = {
        body,
        attachmentIds: files.map((f) => f.id),
        ...(threadId ? { threadId } : {}),
      },
      fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, clientId: crypto.randomUUID() };
    try {
      await post('/shared-channels/' + grantId + '/messages', {
        ...input,
        clientId: request.current.clientId,
      });
      setBody('');
      setFiles([]);
      request.current = null;
      onSent();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Sending failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="platform-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label>
        Message shared channel
        <Textarea
          maxLength={12000}
          required={!files.length}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <label>
        Attach a file
        <Input
          type="file"
          disabled={busy || files.length >= 10}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
      </label>
      {files.map((file) => (
        <p key={file.id}>
          {file.name}
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => setFiles((current) => current.filter((f) => f.id !== file.id))}
          >
            Remove attachment
          </Button>
        </p>
      ))}
      {busy && <p role="status">Sending or scanning attachment…</p>}
      <Button disabled={busy || (!body.trim() && !files.length)} className="primary">
        Send to shared channel
      </Button>
    </form>
  );
}
