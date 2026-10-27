'use client';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '@ao/contracts';
import type { RetrievalResult, RetrievalHit } from '@ao/contracts/retrieval';
import { EvidenceInspector } from './evidence-inspector';
import { api } from '../lib/api';
export function RetrievalPanel({
  query,
  revision,
  onOpen,
}: {
  query: string;
  revision: number;
  onOpen: (hit: RetrievalHit) => Promise<void>;
}) {
  const [result, setResult] = useState<RetrievalResult | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [agents, setAgents] = useState<Agent[]>([]),
    [selected, setSelected] = useState<RetrievalHit | null>(null),
    [inspection, setInspection] = useState<RetrievalHit | null>(null);
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0);
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setResult(null);
    setSelected(null);
    setInspection(null);
    setBusy(false);
    setError('');
  }, [query]);
  useEffect(() => {
    const request = new AbortController();
    void api<Agent[]>('/agents', { signal: request.signal })
      .then(setAgents)
      .catch(() => setAgents([]));
    return () => {
      request.abort();
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!result) return;
    const request = new AbortController();
    const timer = setInterval(() => {
      void api(`/search/contexts/${result.contextId}`, { signal: request.signal }).catch(() => {
        if (!request.signal.aborted) {
          setResult(null);
          setInspection(null);
          setSelected(null);
          setError('Evidence changed or expired. Run retrieval again.');
        }
      });
    }, 30000);
    return () => {
      clearInterval(timer);
      request.abort();
    };
  }, [result]);
  useEffect(() => {
    if (!result) return;
    const request = new AbortController();
    void api(`/search/contexts/${result.contextId}`, { signal: request.signal }).catch(() => {
      if (!request.signal.aborted) {
        setResult(null);
        setInspection(null);
        setSelected(null);
        setError('Evidence changed or expired. Run retrieval again.');
      }
    });
    return () => request.abort();
  }, [revision, result?.contextId]);
  async function search(form: HTMLFormElement) {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = ++generation.current,
      data = new FormData(form);
    setBusy(true);
    setError('');
    setSelected(null);
    try {
      const response = await api<RetrievalResult & { answer?: string }>(
        '/search/' + (data.get('answer') || data.get('modelAnswer') ? 'answer' : 'retrieve'),
        {
          method: 'POST',
          signal: request.signal,
          body: JSON.stringify({
            q: String(data.get('q')),
            semantic: data.get('semantic') === 'on',
            ...(data.get('modelAnswer') ? { answerMode: 'model' } : {}),
            ...(data.get('kind') ? { kinds: [data.get('kind')] } : {}),
          }),
        },
      );
      if (current === generation.current) setResult(response);
    } catch (e) {
      if (!request.signal.aborted && current === generation.current) {
        setResult(null);
        setError(e instanceof Error ? e.message : 'Retrieval failed.');
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <Card asChild>
      <details className="settings-card" open>
        <summary>
          <strong>Search all content and cited evidence</strong>
        </summary>
        <form
          className="search-filters"
          onSubmit={(e) => {
            e.preventDefault();
            void search(e.currentTarget);
          }}
        >
          <label className="wide-field">
            Evidence query
            <Input
              name="q"
              aria-label="Evidence query"
              key={query}
              defaultValue={query}
              required
              maxLength={500}
            />
          </label>
          <label>
            Content
            <NativeSelect name="kind" aria-label="Evidence content">
              <option value="">All accessible content</option>
              {['message', 'knowledge', 'task', 'file', 'document', 'transcript', 'memory'].map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ),
              )}
            </NativeSelect>
          </label>
          <label className="checkbox-field">
            <Input type="checkbox" name="semantic" />
            Include semantic ranking
          </label>
          <label className="checkbox-field">
            <Input type="checkbox" name="answer" />
            Show a cited extractive answer
          </label>
          <label className="checkbox-field">
            <Input type="checkbox" name="modelAnswer" />
            Model-written answer (requires operator configuration)
          </label>
          <Button size="sm" className="primary small" disabled={busy}>
            {busy ? 'Retrieving…' : 'Find evidence'}
          </Button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {result && (
          <div aria-live="polite">
            <p className="muted">
              {result.items.length} cited sources · {result.mode}
              {result.truncated ? ' · Candidate limit reached; narrow your query' : ''}
            </p>
            {result.indicators.missingEvidence && <p>No accessible evidence was found.</p>}
            {result.indicators.staleEvidence && <p>Some evidence needs a freshness review.</p>}
            {result.indicators.conflictingEvidence && (
              <p>Some evidence is marked as conflicting. Review the source before relying on it.</p>
            )}
            {'answer' in result && typeof result.answer === 'string' && (
              <blockquote className="retrieval-answer">{result.answer}</blockquote>
            )}
            {'answerMode' in result && result.answerMode === 'model' && (
              <p className="muted">
                Model-written synthesis. Supporting quotations are checked against these excerpts;
                review the sources to confirm each interpretation.
              </p>
            )}
            {result.items.map((hit) => (
              <Card key={`${hit.kind}:${hit.id}`} asChild>
                <article className="settings-card">
                  <small>
                    {hit.citation} {hit.kind} · version {hit.version} · {hit.freshness}
                    {hit.conflict ? ' · Conflict reported' : ''}
                  </small>
                  <h3>{hit.title}</h3>
                  <p className="retrieval-excerpt">{hit.excerpt}</p>
                  <div className="button-row">
                    <Button
                      variant="outline"
                      className="subtle-button"
                      onClick={() => setInspection(hit)}
                    >
                      Inspect evidence
                    </Button>
                    {['message', 'knowledge', 'task', 'file'].includes(hit.kind) && (
                      <Button
                        variant="outline"
                        className="subtle-button"
                        onClick={() => {
                          void onOpen(hit).catch((e) =>
                            setError(e instanceof Error ? e.message : 'Source unavailable.'),
                          );
                        }}
                      >
                        Open source
                      </Button>
                    )}
                    {agents.length > 0 && (
                      <Button
                        variant="outline"
                        className="subtle-button"
                        onClick={() => setSelected(hit)}
                      >
                        Retain as agent memory
                      </Button>
                    )}
                  </div>
                </article>
              </Card>
            ))}
          </div>
        )}
        {inspection && (
          <EvidenceInspector
            key={`${inspection.kind}:${inspection.id}:${inspection.version}`}
            hit={inspection}
            onClose={() => setInspection(null)}
          />
        )}
        {selected && (
          <Card asChild>
            <form
              className="settings-card"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  data = new FormData(form);
                setBusy(true);
                setError('');
                try {
                  await api('/memory', {
                    method: 'POST',
                    body: JSON.stringify({
                      agentId: data.get('agent'),
                      boundary: data.get('boundary'),
                      title: data.get('title'),
                      body: data.get('body'),
                      sources: [
                        { kind: selected.kind, id: selected.id, version: selected.version },
                      ],
                      expiresAt: new Date(
                        Date.now() + Number(data.get('days')) * 86400000,
                      ).toISOString(),
                    }),
                  });
                  setSelected(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Memory could not be saved.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <h3>Retain cited memory</h3>
              <label>
                Agent
                <NativeSelect name="agent">
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label>
                Audience
                <NativeSelect name="boundary">
                  <option value="private">You and the agent</option>
                  <option value="workspace">Workspace members with source access</option>
                </NativeSelect>
              </label>
              <label>
                Title
                <Input name="title" required defaultValue={selected.title} maxLength={200} />
              </label>
              <label>
                Memory
                <Textarea
                  aria-label="Memory"
                  name="body"
                  required
                  defaultValue={selected.excerpt}
                  maxLength={20000}
                />
              </label>
              <label>
                Expire after
                <NativeSelect name="days">
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </NativeSelect>
              </label>
              <p className="muted">
                Source permissions continue to apply. Forwarding retains this provenance.
              </p>
              <Button size="sm" className="primary small" disabled={busy}>
                Save memory
              </Button>
              <Button variant="outline" type="button" onClick={() => setSelected(null)}>
                Cancel
              </Button>
            </form>
          </Card>
        )}
      </details>
    </Card>
  );
}
