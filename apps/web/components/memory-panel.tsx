'use client';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceReference } from '@ao/contracts/retrieval';
import { api } from '../lib/api';
import { MemoryConsentPanel } from './memory-consent-panel';
interface Memory {
  id: string;
  title: string;
  body: string;
  owner_id: string;
  agent_id: string;
  version: number;
  boundary: string;
  sources: SourceReference[];
  expires_at: string;
}
export function MemoryPanel({
  memberId,
  revision,
  destinations,
}: {
  memberId: string;
  revision: number;
  destinations: { id: string; name: string }[];
}) {
  const [items, setItems] = useState<Memory[]>([]),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [mutating, setMutating] = useState(false),
    [edit, setEdit] = useState<Memory | null>(null),
    [release, setRelease] = useState<Memory | null>(null);
  const [consentRevision, setConsentRevision] = useState(0);
  const busy = loading || mutating;
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0);
  const load = useCallback(async (after: string | null = null) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = ++generation.current;
    setLoading(true);
    try {
      const page = await api<{ items: Memory[]; next_after: string | null }>(
        '/memory' + (after ? '?after=' + after : ''),
        { signal: request.signal },
      );
      if (current !== generation.current) return;
      setItems((old) => (after ? [...old, ...page.items] : page.items));
      setNext(page.next_after);
      setError('');
    } catch (e) {
      if (!request.signal.aborted) {
        setItems([]);
        setNext(null);
        setEdit(null);
        setRelease(null);
        setError(e instanceof Error ? e.message : 'Memory could not be loaded.');
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 30000);
    return () => {
      clearInterval(timer);
      generation.current++;
      controller.current?.abort();
    };
  }, [load, revision]);
  async function action(work: () => Promise<unknown>) {
    setError('');
    setMutating(true);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Memory action failed.');
    } finally {
      setMutating(false);
    }
  }
  return (
    <Card asChild>
      <details className="settings-card">
        <summary>
          <strong>Inspectable agent memory</strong>
        </summary>
        <p className="muted">
          Memory expires automatically and remains limited by its source audiences. Corrections
          retain provenance and an inspection history.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!items.length && !busy && <p>No accessible retained memories.</p>}
        {items.map((memory) => (
          <Card key={memory.id} asChild>
            <article className="settings-card">
              <small>
                {memory.boundary} · version {memory.version} · expires{' '}
                {new Date(memory.expires_at).toLocaleDateString()}
              </small>
              <h3>{memory.title}</h3>
              <p className="retrieval-excerpt">{memory.body}</p>
              <ul>
                {memory.sources.map((s) => (
                  <li key={`${s.kind}:${s.id}`}>
                    {s.kind} · {s.id} · version {s.version}
                  </li>
                ))}
              </ul>
              <div className="button-row">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const data = await api(`/memory/${memory.id}/export`),
                        url = URL.createObjectURL(
                          new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
                        );
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = `memory-${memory.id}.json`;
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  Export
                </Button>
                {memory.owner_id === memberId && (
                  <>
                    <Button variant="outline" disabled={busy} onClick={() => setEdit(memory)}>
                      Correct
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => setRelease(memory)}>
                      Share with source-owner consent
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void action(() => api(`/memory/${memory.id}`, { method: 'DELETE' }))
                      }
                    >
                      Delete memory and history
                    </Button>
                  </>
                )}
              </div>
            </article>
          </Card>
        ))}
        {next && (
          <Button variant="outline" disabled={busy} onClick={() => void load(next)}>
            Load more memories
          </Button>
        )}
        {release && (
          <Card asChild>
            <form
              className="settings-card"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void action(async () => {
                  await api(`/memory/${release.id}/release-requests`, {
                    method: 'POST',
                    body: JSON.stringify({
                      version: release.version,
                      reason: data.get('reason'),
                      ...(data.get('conversation')
                        ? { conversationId: data.get('conversation') }
                        : {}),
                      acknowledgeAudienceExpansion: data.get('acknowledge') === 'on',
                    }),
                  });
                  setRelease(null);
                  setConsentRevision((n) => n + 1);
                });
              }}
            >
              <h3>Request source-owner consent</h3>
              <p>
                Every source owner must approve the exact revisions and destination before
                publication. Source correction, deletion, expiry and consent withdrawal invalidate
                released copies.
              </p>
              <label>
                Publication audience
                <NativeSelect name="conversation" aria-label="Publication audience">
                  <option value="">Workspace</option>
                  {destinations.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      #{channel.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label>
                Reason
                <Input name="reason" required minLength={10} maxLength={1000} />
              </label>
              <label className="checkbox-field">
                <Input type="checkbox" name="acknowledge" required />I approve expanding this
                memory’s audience to the selected destination.
              </label>
              <Button size="sm" className="primary small" disabled={busy}>
                Request owner approvals
              </Button>
              <Button variant="outline" type="button" onClick={() => setRelease(null)}>
                Cancel
              </Button>
            </form>
          </Card>
        )}
        {edit && (
          <Card asChild>
            <form
              className="settings-card"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void action(async () => {
                  await api(`/memory/${edit.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({
                      version: edit.version,
                      title: data.get('title'),
                      body: data.get('body'),
                      reason: data.get('reason'),
                      sources: edit.sources,
                    }),
                  });
                  setEdit(null);
                });
              }}
            >
              <h3>Correct memory</h3>
              <label>
                Title
                <Input name="title" defaultValue={edit.title} required maxLength={200} />
              </label>
              <label>
                Memory
                <Textarea
                  aria-label="Memory"
                  name="body"
                  defaultValue={edit.body}
                  required
                  maxLength={20000}
                />
              </label>
              <label>
                Reason
                <Input name="reason" required maxLength={1000} />
              </label>
              <Button size="sm" className="primary small" disabled={busy}>
                Save correction
              </Button>
              <Button variant="outline" type="button" onClick={() => setEdit(null)}>
                Cancel
              </Button>
            </form>
          </Card>
        )}
        <MemoryConsentPanel
          memberId={memberId}
          revision={revision + consentRevision}
          destinations={destinations}
        />
      </details>
    </Card>
  );
}
