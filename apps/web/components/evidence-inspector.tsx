'use client';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { useEffect, useState } from 'react';
import type { RetrievalHit } from '@ao/contracts/retrieval';
import { api } from '../lib/api';
export function EvidenceInspector({
  hit,
  onClose,
}: {
  hit: Pick<RetrievalHit, 'kind' | 'id' | 'version' | 'citation'>;
  onClose: () => void;
}) {
  const [source, setSource] = useState<{
      title: string;
      body: string;
      version: number;
      hasMore: boolean;
    } | null>(null),
    [offset, setOffset] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    const request = new AbortController();
    setSource(null);
    setError('');
    void api<{ title: string; body: string; version: number; hasMore: boolean }>(
      `/search/sources/${hit.kind}/${hit.id}?version=${hit.version}&offset=${offset}`,
      { signal: request.signal },
    )
      .then(setSource)
      .catch((e) => {
        if (!request.signal.aborted)
          setError(e instanceof Error ? e.message : 'Evidence is no longer available.');
      });
    return () => request.abort();
  }, [hit.id, hit.kind, hit.version, offset]);
  return (
    <Card asChild>
      <section className="settings-card" aria-label="Source evidence">
        <div className="button-row">
          <strong>{hit.citation} Source inspection</strong>
          <Button variant="outline" onClick={onClose}>
            Close evidence
          </Button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {source ? (
          <>
            <h3>{source.title}</h3>
            <small>
              {hit.kind} · version {source.version}
            </small>
            <p className="retrieval-excerpt">{source.body}</p>
            <div className="button-row">
              {offset > 0 && (
                <Button variant="outline" onClick={() => setOffset(Math.max(0, offset - 10000))}>
                  Previous text
                </Button>
              )}
              {source.hasMore && (
                <Button variant="outline" onClick={() => setOffset(offset + 10000)}>
                  More source text
                </Button>
              )}
            </div>
          </>
        ) : (
          !error && <p role="status">Checking current source access…</p>
        )}
      </section>
    </Card>
  );
}
