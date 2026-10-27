'use client';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceReference } from '@ao/contracts/retrieval';
import { api } from '../lib/api';
import { EvidenceInspector } from './evidence-inspector';
interface RequestRow {
  id: string;
  state: string;
  reason: string;
  expires_at: string;
}
interface Review {
  id: string;
  state: string;
  requesterId: string;
  conversationId: string | null;
  reason: string;
  bodyHash: string;
  expiresAt: string;
  ownSources: SourceReference[];
  ownDecision: string | null;
  consents: { owner_id: string; decision: string }[];
}
export function MemoryConsentPanel({
  memberId,
  revision,
  destinations,
}: {
  memberId: string;
  revision: number;
  destinations: { id: string; name: string }[];
}) {
  const [items, setItems] = useState<RequestRow[]>([]),
    [next, setNext] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [review, setReview] = useState<Review | null>(null),
    [source, setSource] = useState<SourceReference | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (after: string | null = null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      const current = ++generation.current;
      try {
        const [page, detail] = await Promise.all([
          api<{ items: RequestRow[]; next_after: string | null }>(
            '/memory-release-requests' + (after ? '?after=' + after : ''),
            { signal: request.signal },
          ),
          selected
            ? api<Review>('/memory-release-requests/' + selected, { signal: request.signal })
            : Promise.resolve(null),
        ]);
        if (current !== generation.current) return;
        setItems((old) => (after ? [...old, ...page.items] : page.items));
        setNext(page.next_after);
        setReview(detail);
        setError('');
      } catch (e) {
        if (!request.signal.aborted) {
          setReview(null);
          setSource(null);
          setItems([]);
          setNext(null);
          setError(e instanceof Error ? e.message : 'Consent requests are unavailable.');
        }
      }
    },
    [selected],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      clearInterval(timer);
      generation.current++;
      controller.current?.abort();
    };
  }, [load, revision, refresh]);
  async function mutate(path: string, body?: unknown, method = 'POST') {
    setBusy(true);
    setError('');
    try {
      await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      setSource(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The consent action failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card asChild>
      <section className="settings-card" aria-label="Source-owner consent inbox">
        <h3>Source-owner consent</h3>
        <p className="muted">
          Each owner approves only their own exact evidence for the named audience and
          composed-memory fingerprint. Other owners’ private sources are not included in this
          review.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {items.map((item) => (
          <article key={item.id}>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setSource(null);
                setReview(null);
                setSelected(item.id);
              }}
            >
              {item.reason}
            </Button>
            <span className="muted">
              {' '}
              · {item.state} · review by {new Date(item.expires_at).toLocaleString()}
            </span>
          </article>
        ))}
        {next && (
          <Button variant="outline" disabled={busy} onClick={() => void load(next)}>
            Load more consent requests
          </Button>
        )}
        {review && (
          <Card key={review.id} asChild>
            <div className="settings-card">
              <p>
                <strong>Destination:</strong>{' '}
                {review.conversationId
                  ? (destinations.find((channel) => channel.id === review.conversationId)?.name ??
                      'Selected conversation (access required)') +
                    ' and its current/future authorized members'
                  : 'All authorized workspace members'}
              </p>
              <p>{review.reason}</p>
              <p className="muted">
                Composed-memory SHA-256: <code>{review.bodyHash}</code>
              </p>
              <p>
                {review.consents.filter((c) => c.decision === 'approved').length} of{' '}
                {review.consents.length} owners approved · {review.state}
              </p>
              <ul>
                {review.ownSources.map((ref) => (
                  <li key={ref.kind + ref.id}>
                    <Button variant="outline" onClick={() => setSource(ref)}>
                      Inspect my {ref.kind} source, version {ref.version}
                    </Button>
                  </li>
                ))}
              </ul>
              {source && (
                <EvidenceInspector
                  key={source.kind + source.id + source.version}
                  hit={{ ...source, citation: 'Owned' }}
                  onClose={() => setSource(null)}
                />
              )}
              {review.state === 'pending' && review.ownDecision === 'pending' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    void mutate('/memory-release-requests/' + review.id + '/decision', {
                      decision: data.get('decision'),
                      bodyHash: review.bodyHash,
                      acknowledgeAudienceExpansion: data.get('acknowledge') === 'on',
                    });
                  }}
                >
                  <label>
                    Decision
                    <NativeSelect name="decision">
                      <option value="approved">Approve my evidence for this audience</option>
                      <option value="rejected">Reject publication</option>
                    </NativeSelect>
                  </label>
                  <label className="checkbox-field">
                    <Input type="checkbox" name="acknowledge" required />I reviewed my exact
                    evidence and authorize its use in the fingerprinted memory for this audience.
                  </label>
                  <Button variant="outline" disabled={busy}>
                    Record source consent
                  </Button>
                </form>
              )}
              {review.ownDecision === 'approved' && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void mutate('/memory-release-requests/' + review.id + '/decision', {
                      decision: 'withdrawn',
                      bodyHash: review.bodyHash,
                      acknowledgeAudienceExpansion: true,
                    })
                  }
                >
                  Withdraw my source consent
                </Button>
              )}
              {review.requesterId === memberId && review.state === 'pending' && (
                <>
                  <Button
                    variant="outline"
                    disabled={busy || review.consents.some((c) => c.decision !== 'approved')}
                    onClick={() =>
                      void mutate('/memory-release-requests/' + review.id + '/publish', {
                        acknowledgeAudienceExpansion: true,
                      })
                    }
                  >
                    Publish approved memory
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void mutate('/memory-release-requests/' + review.id, undefined, 'DELETE')
                    }
                  >
                    Cancel consent request
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  setSelected(null);
                  setReview(null);
                  setSource(null);
                }}
              >
                Close consent review
              </Button>
            </div>
          </Card>
        )}
      </section>
    </Card>
  );
}
