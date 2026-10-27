'use client';
import { useCallback, useEffect, useState } from 'react';
import type { FileUpload } from '@ao/contracts';
import { api, post } from '../lib/api';
import { sha256, resumableUpload } from '../lib/resumable-upload';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
interface Metadata extends FileUpload {
  version: number;
  can_manage: boolean;
  conversation_id: string;
  task_id: string | null;
  dlp_status: string;
}
interface Version {
  version: number;
  name: string;
  size: number;
  created_at: string;
  dlp_status: string;
}
interface Share {
  id: string;
  file_version: number;
  expires_at: string;
  downloads: number;
  max_downloads: number;
  revoked_at: string | null;
}
export function FileDetails({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="File versions and sharing">
          Manage file
        </Button>
      </DialogTrigger>
      {open && <FileDetailContent id={id} />}
    </Dialog>
  );
}
function FileDetailContent({ id }: { id: string }) {
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [file, setFile] = useState<Metadata>(),
    [versions, setVersions] = useState<Version[]>([]),
    [shares, setShares] = useState<Share[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState(''),
    [message, setMessage] = useState('');
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const options = signal ? { signal } : {};
      const [metadata, history, links, people] = await Promise.all([
        api<Metadata>(`/files/${id}`, options),
        api<Version[]>(`/files/${id}/versions`, options),
        api<Share[]>(`/files/${id}/shares`, options),
        api<{ id: string; name: string }[]>('/members', options).catch(() => []),
      ]);
      setMembers(people);
      setFile(metadata);
      setVersions(history);
      setShares(links);
    },
    [id],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Unable to load this file.');
    });
    return () => controller.abort();
  }, [refresh]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update this file.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogContent className="file-details">
      <DialogTitle>{file?.name ?? 'File details'}</DialogTitle>
      <DialogDescription>
        Version history and expiring links. Recipients must retain access to the original
        conversation or task.
      </DialogDescription>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {file && (
        <>
          <p>
            Current version {file.version} · Inspection: {file.dlp_status}
          </p>
          <a href={`/api/v1/files/${id}/content`}>Download current version</a>
          <h3>Version history</h3>
          {!versions.length && <p className="muted">No previous versions.</p>}
          <ul>
            {versions.map((v) => (
              <li key={v.version}>
                <a href={`/api/v1/files/${id}/content?version=${v.version}`}>
                  Version {v.version} · {v.name}
                </a>
                <small>
                  {' '}
                  · {new Date(v.created_at).toLocaleString()} · {v.dlp_status}
                </small>
              </li>
            ))}
          </ul>
          {file.can_manage && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget,
                    upload = new FormData(form).get('file');
                  if (!(upload instanceof File) || !upload.size) return;
                  void perform(async () => {
                    const child = await post<FileUpload>(
                      `/${file.task_id ? 'tasks' : 'conversations'}/${file.task_id ?? file.conversation_id}/files`,
                      {
                        name: upload.name,
                        size: upload.size,
                        sha256: await sha256(await upload.arrayBuffer()),
                        clientId: crypto.randomUUID(),
                      },
                    );
                    await resumableUpload(child.id, upload, AbortSignal.timeout(120000), () => {});
                    await post(`/files/${id}/versions`, {
                      fileId: child.id,
                      expectedVersion: file.version,
                      clientId: crypto.randomUUID(),
                    });
                    form.reset();
                    setMessage('New version published.');
                  });
                }}
              >
                <label>
                  Publish a new version
                  <Input name="file" type="file" required disabled={busy} />
                </label>
                <Button disabled={busy}>Upload version</Button>
              </form>
              <h3>Expiring sharing links</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void perform(async () => {
                    const result = await post<{ path: string }>(`/files/${id}/shares`, {
                      recipientIds: data.getAll('recipients'),
                      expiresInHours: Number(data.get('hours')),
                      maxDownloads: Number(data.get('downloads')),
                    });
                    setLink(new URL(result.path, location.origin).href);
                  });
                }}
              >
                <fieldset>
                  <legend>Recipients</legend>
                  {members.map((member) => (
                    <label key={member.id}>
                      <input type="checkbox" name="recipients" value={member.id} />
                      {member.name}
                    </label>
                  ))}
                </fieldset>
                <div className="commercial-actions">
                  <label>
                    Expires in hours
                    <Input
                      name="hours"
                      type="number"
                      min={1}
                      max={168}
                      defaultValue={24}
                      required
                    />
                  </label>
                  <label>
                    Download limit
                    <Input
                      name="downloads"
                      type="number"
                      min={1}
                      max={100}
                      defaultValue={10}
                      required
                    />
                  </label>
                </div>
                <Button disabled={busy}>Create expiring link</Button>
              </form>
              {link && (
                <label>
                  Copy this link; it is shown only once
                  <Input value={link} readOnly onFocus={(e) => e.currentTarget.select()} />
                </label>
              )}
              <ul>
                {shares.map((s) => (
                  <li key={s.id}>
                    Version {s.file_version} · {s.downloads}/{s.max_downloads} downloads ·{' '}
                    {new Date(s.expires_at).toLocaleString()}{' '}
                    {s.revoked_at ? (
                      'Revoked'
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await api(`/files/${id}/shares/${s.id}`, { method: 'DELETE' });
                          })
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </DialogContent>
  );
}
export function SharedFileLink() {
  const [proof, setProof] = useState<{ id: string; token: string }>(),
    [file, setFile] = useState<{ name: string; version: number }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const read = () => {
      const match = /^#share=([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(location.hash);
      if (!match) return;
      const p = { id: match[1]!, token: match[2]! };
      history.replaceState(history.state, '', location.pathname + location.search);
      setProof(p);
      void post<{ name: string; version: number }>('/file-shares/resolve', p)
        .then(setFile)
        .catch((e) =>
          setError(e instanceof Error ? e.message : 'This sharing link is unavailable.'),
        );
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  return (
    <Dialog
      open={Boolean(proof)}
      onOpenChange={(open) => {
        if (!open) {
          setProof(undefined);
          setFile(undefined);
          setError('');
        }
      }}
    >
      <DialogContent>
        <DialogTitle>{file?.name ?? 'Shared file'}</DialogTitle>
        <DialogDescription>
          Downloads require a current grant and access to the source conversation or task.
        </DialogDescription>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {file && (
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const response = await fetch('/api/v1/file-shares/content', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(proof),
                });
                if (!response.ok)
                  throw new Error(
                    'This link expired, reached its download limit, or access changed.',
                  );
                const url = URL.createObjectURL(await response.blob()),
                  a = document.createElement('a');
                a.href = url;
                a.download = file.name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Download failed.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Download version {file.version}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
