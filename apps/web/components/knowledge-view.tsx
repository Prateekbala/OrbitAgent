'use client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { KnowledgeGovernancePanel } from './knowledge-governance';
import { RichMessage } from './rich-message';
import { BookOpen, Plus } from 'lucide-react';
import type {
  Bootstrap,
  Page,
  KnowledgeHistory,
  KnowledgeSnapshot,
  KnowledgeVersion,
} from '@ao/contracts';
import { api, HttpError, post } from '../lib/api';
import { Empty } from './primitives';
import { WorkspaceHeading, CollectionSkeleton } from './workspace-heading';
import { Dialog } from './dialog';

const KnowledgeCollaboration = dynamic(
  () => import('./knowledge-collaboration').then((m) => m.KnowledgeCollaboration),
  { ssr: false },
);

type Draft = { title: string; body: string; summary: string; version: number; clientId: string };
type SaveResult = { page: Page; applied_version: number; replayed: boolean };
export function KnowledgeView({
  pages,
  boot,
  selectedPage,
  setSelectedPage,
  onCreate,
  onChanged,
  loading = false,
}: {
  pages: Page[];
  boot: Bootstrap;
  selectedPage: Page | null;
  setSelectedPage: (page: Page | null) => void;
  onCreate: () => void;
  onChanged: () => Promise<unknown>;
  loading?: boolean;
}) {
  const [current, setCurrent] = useState<Page | null>(selectedPage),
    [draft, setDraft] = useState<Draft | null>(null),
    [history, setHistory] = useState<KnowledgeVersion[] | null>(null),
    [before, setBefore] = useState<number | null>(null),
    [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(false),
    [collaborating, setCollaborating] = useState(false),
    [governance, setGovernance] = useState(false),
    [uncertainSave, setUncertainSave] = useState(false);
  const pageId = selectedPage?.id,
    epoch = useRef(0),
    requests = useRef(new Set<AbortController>());
  const get = useCallback(async <T,>(path: string) => {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      return await api<T>(path, { signal: controller.signal });
    } finally {
      requests.current.delete(controller);
    }
  }, []);
  useLayoutEffect(() => {
    epoch.current++;
    setCurrent(selectedPage);
    setCollaborating(false);
    setGovernance(false);
    setDraft(null);
    setHistory(null);
    setSnapshot(null);
    setError('');
    setConflict(false);
    setUncertainSave(false);
    setBusy(false);
    return () => {
      epoch.current++;
      for (const request of requests.current) request.abort();
      requests.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  useEffect(() => {
    if (!pageId) return;
    const version = epoch.current;
    let live = true;
    void get<Page>(`/knowledge/${pageId}`)
      .then((page) => {
        if (live && version === epoch.current) setCurrent(page);
      })
      .catch((e) => {
        if (live && version === epoch.current) {
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            setCurrent(null);
            setDraft(null);
            setHistory(null);
            setSnapshot(null);
          }
          setError(e instanceof Error ? e.message : 'Unable to load page.');
        }
      });
    return () => {
      live = false;
    };
  }, [pageId, pages, get]);
  const failure = (e: unknown) => {
    setError(e instanceof Error ? e.message : 'Unable to save changes.');
    if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
      setCurrent(null);
      setDraft(null);
      setHistory(null);
      setSnapshot(null);
    }
  };
  async function versions(append = false) {
    if (!current || busy) return;
    const version = epoch.current;
    setBusy(true);
    setError('');
    try {
      const rows = await get<KnowledgeHistory>(
        `/knowledge/${current.id}/versions${append && before ? `?before=${before}` : ''}`,
      );
      if (version === epoch.current) {
        setHistory((old) => (append ? [...(old ?? []), ...rows.items] : rows.items));
        setBefore(rows.next_before);
      }
    } catch (e) {
      if (version === epoch.current) failure(e);
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  async function preview(versionNumber: number) {
    if (!current || busy) return;
    const version = epoch.current;
    setBusy(true);
    setError('');
    try {
      const row = await get<KnowledgeSnapshot>(
        `/knowledge/${current.id}/versions/${versionNumber}`,
      );
      if (version === epoch.current) setSnapshot(row);
    } catch (e) {
      if (version === epoch.current) failure(e);
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  async function save() {
    if (!current || !draft || busy) return;
    const version = epoch.current;
    setBusy(true);
    setError('');
    try {
      const result = await api<SaveResult>(`/knowledge/${current.id}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      if (version === epoch.current) {
        setCurrent(result.page);
        setSelectedPage(result.page);
        setDraft(null);
        setUncertainSave(false);
        setConflict(false);
        setHistory(null);
        await onChanged();
      }
    } catch (e) {
      if (version === epoch.current) {
        setUncertainSave(!(e instanceof HttpError) || e.status >= 500);
        failure(e);
        if (e instanceof HttpError && e.code === 'VERSION_CONFLICT') {
          setConflict(true);
          try {
            const latest = await get<Page>(`/knowledge/${current.id}`);
            if (version === epoch.current) setCurrent(latest);
          } catch (readError) {
            if (version === epoch.current) failure(readError);
          }
        }
      }
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  const restoreRequest = useRef<{
    page: string;
    target: number;
    version: number;
    clientId: string;
  } | null>(null);
  async function restore() {
    if (!current || !snapshot || busy) return;
    const version = epoch.current;
    setBusy(true);
    setError('');
    if (
      !restoreRequest.current ||
      restoreRequest.current.page !== current.id ||
      restoreRequest.current.target !== snapshot.version
    )
      restoreRequest.current = {
        page: current.id,
        target: snapshot.version,
        version: current.version,
        clientId: crypto.randomUUID(),
      };
    try {
      const result = await post<SaveResult>(`/knowledge/${current.id}/restore`, {
        version: restoreRequest.current.version,
        targetVersion: snapshot.version,
        clientId: restoreRequest.current.clientId,
        summary: `Restored version ${snapshot.version}`,
      });
      if (version === epoch.current) {
        setCurrent(result.page);
        setSelectedPage(result.page);
        setSnapshot(null);
        setHistory(null);
        restoreRequest.current = null;
        await onChanged();
      }
    } catch (e) {
      if (version === epoch.current) {
        failure(e);
        if (e instanceof HttpError && e.code === 'VERSION_CONFLICT') {
          restoreRequest.current = null;
          try {
            const latest = await get<Page>(`/knowledge/${current.id}`);
            if (version === epoch.current) setCurrent(latest);
          } catch (readError) {
            if (version === epoch.current) failure(readError);
          }
        }
      }
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  return (
    <section className="page-content knowledge-page">
      {!selectedPage && (
        <WorkspaceHeading
          icon={BookOpen}
          eyebrow="A shared source of truth"
          title="Workspace knowledge"
          description="Keep decisions, project context, and living documents close to the work."
        />
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {selectedPage ? (
        <article className="document">
          <div className="document-actions">
            <Button
              variant="link"
              className="text-button"
              disabled={busy || Boolean(draft) || collaborating}
              onClick={() => setSelectedPage(null)}
            >
              ← All pages
            </Button>
            {current && !draft && !collaborating && (
              <>
                <Button
                  variant="outline"
                  className="subtle-button"
                  onClick={() => {
                    setDraft({
                      title: current.title,
                      body: current.body,
                      summary: '',
                      version: current.version,
                      clientId: crypto.randomUUID(),
                    });
                    setError('');
                  }}
                >
                  Edit page
                </Button>
                <Button
                  variant="outline"
                  className="subtle-button"
                  onClick={() => setCollaborating(true)}
                >
                  Edit together
                </Button>
                <Button
                  variant="outline"
                  className="subtle-button"
                  onClick={() => setGovernance((v) => !v)}
                >
                  Ownership, sources and review
                </Button>
                <Button
                  variant="outline"
                  className="subtle-button"
                  disabled={busy}
                  onClick={() => void versions()}
                >
                  Version history
                </Button>
              </>
            )}
          </div>
          {!current ? (
            <p>This page is unavailable.</p>
          ) : collaborating ? (
            <KnowledgeCollaboration
              pageId={current.id}
              onClose={() => {
                setCollaborating(false);
                void get<Page>(`/knowledge/${current.id}`).then(setCurrent).catch(failure);
                void onChanged();
              }}
            />
          ) : draft ? (
            <form
              className="knowledge-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <p className="muted">
                Editing version {draft.version}. Your draft stays here if saving fails.
              </p>
              {(conflict || current.version !== draft.version) && (
                <div className="conflict-panel" role="status">
                  <strong>A newer version is available: v{current.version}</strong>
                  <p>
                    Review the latest text below and merge any changes into your draft. Saving
                    requires acknowledging this version.
                  </p>
                  <details open>
                    <summary>Latest saved page</summary>
                    <h3>{current.title}</h3>
                    <pre>{current.body}</pre>
                  </details>
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDraft({
                        ...draft,
                        version: current.version,
                        clientId: crypto.randomUUID(),
                      });
                      setConflict(false);
                      setError('');
                    }}
                  >
                    I reviewed v{current.version}; keep my draft
                  </Button>
                </div>
              )}
              <label>
                Page title
                <Input
                  required
                  minLength={2}
                  maxLength={200}
                  value={draft.title}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value, clientId: crypto.randomUUID() })
                  }
                />
              </label>
              <label>
                Page content
                <Textarea
                  aria-label="Page content"
                  required
                  maxLength={50000}
                  rows={18}
                  value={draft.body}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, body: e.target.value, clientId: crypto.randomUUID() })
                  }
                />
              </label>
              <label>
                Change summary
                <Input
                  maxLength={500}
                  value={draft.summary}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, summary: e.target.value, clientId: crypto.randomUUID() })
                  }
                />
              </label>
              <div className="document-actions">
                <Button
                  size="sm"
                  type="submit"
                  className="primary small"
                  disabled={busy || (current.version !== draft.version && !uncertainSave)}
                >
                  {busy ? 'Saving…' : uncertainSave ? 'Retry save' : 'Save new version'}
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setConflict(false);
                    setError('');
                  }}
                >
                  Discard draft
                </Button>
              </div>
            </form>
          ) : (
            <>
              <h2>{current.title}</h2>
              <p className="muted">
                By {current.author_name} · version {current.version} ·{' '}
                {new Date(current.updated_at).toLocaleString()}
              </p>
              <div className="document-body">
                <RichMessage body={current.body} format="markdown" />
              </div>
            </>
          )}
          {governance && current && !draft && !collaborating && (
            <KnowledgeGovernancePanel
              page={current}
              boot={boot}
              pages={pages}
              onChanged={async () => {
                await onChanged();
                setCurrent(await get<Page>(`/knowledge/${current.id}`));
              }}
              onDeleted={() => setSelectedPage(null)}
            />
          )}
        </article>
      ) : loading && !pages.length ? (
        <CollectionSkeleton label="Loading knowledge…" />
      ) : pages.length === 0 ? (
        <Empty
          icon={BookOpen}
          title="A shared source of understanding"
          description="Start with a team guide, a project brief, or a decision worth remembering."
          action={
            <Button size="sm" className="primary small" onClick={onCreate}>
              Write a page <Plus size={16} />
            </Button>
          }
        />
      ) : (
        <div className="card-grid">
          {pages.map((page) => (
            <Button
              variant="outline"
              className="knowledge-card"
              key={page.id}
              onClick={() => setSelectedPage(page)}
            >
              <BookOpen size={22} />
              <h3>{page.title}</h3>
              <p>{page.body.slice(0, 130)}</p>
              <small>
                {page.author_name} · v{page.version}
              </small>
            </Button>
          ))}
        </div>
      )}
      {history && current && (
        <Dialog
          title="Version history"
          onClose={() => {
            if (!busy) {
              setHistory(null);
              setSnapshot(null);
            }
          }}
        >
          <div className="revision-layout">
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <ol className="revision-list">
              {history.map((row) => (
                <li key={row.version}>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void preview(row.version)}
                  >
                    <strong>
                      Version {row.version}
                      {row.version === current.version ? ' · Current' : ''}
                    </strong>
                    <span>
                      {row.author_name} · {new Date(row.created_at).toLocaleString()}
                    </span>
                    <span>
                      {row.summary || 'Page saved'}
                      {row.restored_from ? ` · From v${row.restored_from}` : ''}
                    </span>
                  </Button>
                </li>
              ))}
            </ol>
            {before && (
              <Button variant="outline" disabled={busy} onClick={() => void versions(true)}>
                Load older versions
              </Button>
            )}
            {snapshot && (
              <div className="revision-preview">
                <p>
                  Comparing saved v{snapshot.version} with current v{current.version}
                </p>
                <div className="revision-comparison">
                  <section>
                    <h3>
                      Version {snapshot.version}: {snapshot.title}
                    </h3>
                    <pre>{snapshot.body}</pre>
                  </section>
                  <section>
                    <h3>
                      Current version {current.version}: {current.title}
                    </h3>
                    <pre>{current.body}</pre>
                  </section>
                </div>
                {snapshot.version !== current.version && (
                  <>
                    <p>
                      Restoring publishes this text as version {current.version + 1}. All existing
                      revisions remain in history.
                    </p>
                    <Button
                      size="sm"
                      className="primary small"
                      disabled={busy}
                      onClick={() => void restore()}
                    >
                      Restore version {snapshot.version} as a new version
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
