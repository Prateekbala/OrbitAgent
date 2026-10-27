'use client';
import { WorkspaceHeading } from './workspace-heading';
import { Search } from 'lucide-react';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Button } from './ui/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Channel, Member, SearchPage, SearchResult } from '@ao/contracts';
import { RetrievalPanel } from './retrieval-panel';
import type { RetrievalHit } from '@ao/contracts/retrieval';
import { api, HttpError } from '../lib/api';

type Filters = {
  q: string;
  scope: 'messages' | 'knowledge';
  conversationId: string;
  authorId: string;
  from: string;
  to: string;
  attachments: boolean;
  threads: string;
  sort: string;
};
const initial = (q: string): Filters => ({
  q,
  scope: 'messages',
  conversationId: '',
  authorId: '',
  from: '',
  to: '',
  attachments: false,
  threads: '',
  sort: 'relevance',
});
export function SearchView({
  query,
  revision,
  channels,
  members,
  onMessage,
  onPage,
  onEvidence,
}: {
  query: string;
  revision: number;
  channels: Channel[];
  members: Member[];
  onMessage: (id: string) => Promise<void>;
  onPage: (id: string) => Promise<void>;
  onEvidence: (hit: RetrievalHit) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => initial(query)),
    [filters, setFilters] = useState(() => initial(query));
  const [items, setItems] = useState<SearchResult[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setDraft(initial(query));
    setFilters(initial(query));
  }, [query]);
  const load = useCallback(
    async (next: string | null, append = false) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      const version = ++generation.current;
      setBusy(true);
      setError('');
      try {
        const params = new URLSearchParams({
          q: filters.q,
          scope: filters.scope,
          sort: filters.sort,
          limit: '30',
        });
        for (const key of ['conversationId', 'authorId'] as const)
          if (filters[key]) params.set(key, filters[key]);
        if (filters.from) params.set('from', new Date(`${filters.from}T00:00:00`).toISOString());
        if (filters.to) {
          const end = new Date(`${filters.to}T00:00:00`);
          end.setDate(end.getDate() + 1);
          params.set('to', end.toISOString());
        }
        if (filters.scope === 'messages') {
          if (filters.attachments) params.set('attachments', 'true');
          if (filters.threads) params.set('threads', filters.threads);
        }
        if (next) params.set('cursor', next);
        const page = await api<SearchPage>(`/search/advanced?${params}`, {
          signal: request.signal,
        });
        if (version === generation.current) {
          setItems((old) =>
            append
              ? [...new Map([...old, ...page.items].map((item) => [item.id, item])).values()]
              : page.items,
          );
          setCursor(page.next_cursor);
        }
      } catch (e) {
        if (!request.signal.aborted && version === generation.current) {
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            setItems([]);
            setCursor(null);
          }
          setError(e instanceof Error ? e.message : 'Search failed.');
        }
      } finally {
        if (version === generation.current) setBusy(false);
      }
    },
    [filters],
  );
  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load(null);
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [load, revision]);
  async function open(item: SearchResult) {
    try {
      setError('');
      await (filters.scope === 'messages' ? onMessage(item.id) : onPage(item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This result is no longer available.');
    }
  }
  return (
    <section className="page-content search-page">
      <WorkspaceHeading
        icon={Search}
        eyebrow="Find the context"
        title="Search"
        description="Find conversations, decisions, and source material. Use quoted phrases, OR, and -excluded words to narrow your results."
      />
      <RetrievalPanel query={query} revision={revision} onOpen={onEvidence} />
      <form
        className="search-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ ...draft, q: draft.q.trim() });
        }}
      >
        <label className="wide-field">
          Search terms
          <Input
            aria-label="Advanced search terms"
            value={draft.q}
            maxLength={300}
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            placeholder="Words, phrases, or leave blank to filter"
          />
        </label>
        <label>
          Search in
          <NativeSelect
            aria-label="Search in"
            value={draft.scope}
            onChange={(e) => setDraft({ ...draft, scope: e.target.value as Filters['scope'] })}
          >
            <option value="messages">Messages</option>
            <option value="knowledge">Knowledge pages</option>
          </NativeSelect>
        </label>
        <label>
          Conversation
          <NativeSelect
            aria-label="Conversation"
            value={draft.conversationId}
            onChange={(e) => setDraft({ ...draft, conversationId: e.target.value })}
          >
            <option value="">All accessible conversations</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          Author
          <NativeSelect
            aria-label="Author"
            value={draft.authorId}
            onChange={(e) => setDraft({ ...draft, authorId: e.target.value })}
          >
            <option value="">Anyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          From date
          <Input
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </label>
        <label>
          Through date
          <Input
            type="date"
            min={draft.from}
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </label>
        <label>
          Sort
          <NativeSelect
            aria-label="Sort"
            value={draft.sort}
            onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
          >
            <option value="relevance">Most relevant</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </NativeSelect>
        </label>
        {draft.scope === 'messages' && (
          <>
            <label>
              Message type
              <NativeSelect
                aria-label="Message type"
                value={draft.threads}
                onChange={(e) => setDraft({ ...draft, threads: e.target.value })}
              >
                <option value="">Messages and replies</option>
                <option value="main">Main messages</option>
                <option value="replies">Thread replies</option>
              </NativeSelect>
            </label>
            <label className="checkbox-field">
              <Input
                type="checkbox"
                checked={draft.attachments}
                onChange={(e) => setDraft({ ...draft, attachments: e.target.checked })}
              />
              Has file attachments
            </label>
          </>
        )}
        <Button size="sm" className="primary small" type="submit">
          Apply search
        </Button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <Button variant="outline" onClick={() => void load(null)}>
            Run search again
          </Button>
        </p>
      )}
      <p role="status" className="muted">
        {busy
          ? 'Searching…'
          : `${items.length}${cursor ? '+' : ''} ${items.length === 1 && !cursor ? 'result' : 'results'}`}
      </p>
      {!busy && !error && items.length === 0 && <p>No results match these terms and filters.</p>}
      {items.map((item) => (
        <Button
          variant="outline"
          className="search-result"
          key={item.id}
          onClick={() => void open(item)}
        >
          <small>
            {item.channel_name ?? 'Workspace knowledge'} · {item.author_name} ·{' '}
            {new Date(item.created_at).toLocaleString()}
            {item.thread_id ? ' · Thread reply' : ''}
          </small>
          {item.title && <h3>{item.title}</h3>}
          <p>{item.body || 'File attachment'}</p>
        </Button>
      ))}
      {cursor && (
        <Button
          variant="outline"
          className="history-button"
          disabled={busy}
          onClick={() => void load(cursor, true)}
        >
          Load more results
        </Button>
      )}
    </section>
  );
}
