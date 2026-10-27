'use client';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bootstrap, Page } from '@ao/contracts';
import { knowledgeKinds, type KnowledgeGovernance } from '@ao/contracts/knowledge';
import { api, post } from '../lib/api';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
import { RichMessage } from './rich-message';
export function KnowledgeGovernancePanel({
  page,
  boot,
  pages,
  onChanged,
  onDeleted,
}: {
  page: Page;
  boot: Bootstrap;
  pages: Page[];
  onChanged: () => Promise<unknown>;
  onDeleted: () => void;
}) {
  const [data, setData] = useState<KnowledgeGovernance | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const commentPage = useCursorPage<KnowledgeGovernance['comments'][number]>(
    `${boot.workspace.id}:${boot.me.id}:${page.id}`,
    `/knowledge/${page.id}/comments`,
  );
  const reviewPage = useCursorPage<{
    id: string;
    author_name: string;
    page_version: number;
    decision: string;
    evidence: string;
  }>(
    `${boot.workspace.id}:${boot.me.id}:${page.id}`,
    `/knowledge/${page.id}/reviews`,
    data?.version ?? 0,
  );
  const commentKey = useRef('');
  if (!commentKey.current) commentKey.current = crypto.randomUUID();
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const next = await api<KnowledgeGovernance>(
        `/knowledge/${page.id}/governance`,
        signal ? { signal } : {},
      );
      if (!signal?.aborted) setData(next);
    },
    [page.id],
  );
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    void load(abort.signal).catch((e) => {
      if (!abort.signal.aborted) setError(e.message);
    });
    return () => {
      abort.abort();
      controller.current = null;
    };
  }, [load]);
  async function action(work: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      if (!controller.current || controller.current.signal.aborted) return;
      await load(controller.current.signal);
      await commentPage.refresh();
      await onChanged();
      setNotice(message);
    } catch (e) {
      if (controller.current && !controller.current.signal.aborted)
        setError(e instanceof Error ? e.message : 'Unable to update knowledge.');
    } finally {
      if (controller.current && !controller.current.signal.aborted) setBusy(false);
    }
  }
  if (!data) return <p role="status">{error || 'Loading page governance…'}</p>;
  const owner = data.owner_id === boot.me.id,
    reviewer = owner || data.reviewers.some((r) => r.member_id === boot.me.id),
    sameAudience = pages.filter(
      (p) => p.id !== page.id && p.conversation_id === page.conversation_id,
    );
  return (
    <section className="knowledge-governance">
      <h3>Ownership and review</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <p>
        {data.owner_name} · {data.kind.replace('_', ' ')} · {data.state} · {data.review_state}
        {data.blocked ? ' · blocked by source changes' : ''}
      </p>
      {data.fresh_until && <p>Fresh until {new Date(data.fresh_until).toLocaleDateString()}</p>}
      {owner && (
        <form
          key={data.version}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void action(
              () =>
                api(`/knowledge/${page.id}/governance`, {
                  method: 'PUT',
                  body: JSON.stringify({
                    version: data.version,
                    ownerId: form.get('owner'),
                    kind: form.get('kind'),
                    reviewers: form.getAll('reviewer'),
                    freshUntil: form.get('fresh')
                      ? new Date(String(form.get('fresh'))).toISOString()
                      : null,
                    state: form.get('state'),
                    supersededBy: form.get('superseded') || null,
                  }),
                }),
              'Governance saved.',
            );
          }}
        >
          <fieldset disabled={busy}>
            <legend>Page governance</legend>
            <label>
              Page owner
              <NativeSelect aria-label="Page owner" name="owner" defaultValue={data.owner_id}>
                {boot.members
                  .filter((m) => m.kind === 'human' && m.status !== 'suspended')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            <label>
              Knowledge type
              <NativeSelect aria-label="Knowledge type" name="kind" defaultValue={data.kind}>
                {knowledgeKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind.replace('_', ' ')}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Page state
              <NativeSelect aria-label="Page state" name="state" defaultValue={data.state}>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </NativeSelect>
            </label>
            <label>
              Fresh until
              <Input name="fresh" type="date" defaultValue={data.fresh_until?.slice(0, 10) ?? ''} />
            </label>
            <label>
              Superseded by
              <NativeSelect
                aria-label="Superseded by"
                name="superseded"
                defaultValue={data.superseded_by ?? ''}
              >
                <option value="">No replacement</option>
                {sameAudience.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <fieldset>
              <legend>Reviewers</legend>
              {boot.members
                .filter((m) => m.kind === 'human' && m.status !== 'suspended')
                .map((m) => (
                  <label className="agent-checkrow" key={m.id}>
                    <Input
                      type="checkbox"
                      name="reviewer"
                      value={m.id}
                      defaultChecked={data.reviewers.some((r) => r.member_id === m.id)}
                    />
                    {m.name}
                  </label>
                ))}
            </fieldset>
            <Button size="sm" className="primary small">
              Save page governance
            </Button>
          </fieldset>
        </form>
      )}
      {reviewer && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget,
              values = new FormData(form);
            void action(
              () =>
                post(`/knowledge/${page.id}/reviews`, {
                  version: page.version,
                  reviewEpoch: data.review_epoch,
                  decision: values.get('decision'),
                  evidence: values.get('evidence'),
                }),
              'Review recorded.',
            );
          }}
        >
          <fieldset disabled={busy}>
            <legend>Review current version {page.version}</legend>
            <label>
              Decision
              <NativeSelect aria-label="Decision" name="decision">
                <option value="approved">Approve</option>
                <option value="changes_requested">Request changes</option>
                <option value="contradiction">Flag contradiction</option>
              </NativeSelect>
            </label>
            <label>
              Review evidence
              <Textarea name="evidence" required minLength={5} maxLength={4000} />
            </label>
            <Button variant="outline">Record page review</Button>
          </fieldset>
        </form>
      )}
      <h3>Provenance</h3>
      {data.sources.length === 0 ? (
        <p>No sources linked.</p>
      ) : (
        <ul>
          {data.sources.map((s) => (
            <li key={s.id}>
              {s.source_page_id
                ? (pages.find((p) => p.id === s.source_page_id)?.title ?? s.source_page_id)
                : 'Message ' + s.source_message_id}{' '}
              · v{s.source_version}
              {s.stale ? ' · needs review' : ''}
            </li>
          ))}
        </ul>
      )}
      {owner && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget),
                source = pages.find((p) => p.id === form.get('source'));
              if (source)
                void action(
                  () =>
                    post(`/knowledge/${page.id}/sources`, {
                      type: 'page',
                      id: source.id,
                      version: source.version,
                    }),
                  'Source linked.',
                );
            }}
          >
            <label>
              Link source page
              <NativeSelect aria-label="Link source page" name="source" required>
                <option value="">Choose a page in the same audience</option>
                {sameAudience.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Button variant="outline" disabled={busy}>
              Add provenance source
            </Button>
          </form>
          {(data.blocked || data.sources.some((s) => s.stale)) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const values = new FormData(e.currentTarget);
                void action(
                  () =>
                    post(`/knowledge/${page.id}/corrections`, {
                      version: page.version,
                      title: page.title,
                      body: values.get('body'),
                      summary: values.get('summary'),
                      sources: sameAudience
                        .filter((p) => values.getAll('source').includes(p.id))
                        .map((p) => ({ type: 'page', id: p.id, version: p.version })),
                    }),
                  'Correction published for review.',
                );
              }}
            >
              <fieldset disabled={busy}>
                <legend>Correct derived knowledge</legend>
                <label>
                  Corrected content
                  <Textarea
                    name="body"
                    defaultValue={page.body}
                    required
                    maxLength={50000}
                    rows={8}
                  />
                </label>
                <label>
                  Correction explanation
                  <Input name="summary" required minLength={5} maxLength={500} />
                </label>
                {sameAudience.map((p) => (
                  <label className="agent-checkrow" key={p.id}>
                    <Input name="source" value={p.id} type="checkbox" />
                    {p.title} · v{p.version}
                  </label>
                ))}
                <p className="muted">
                  Select the current sources that support the corrected text. Previous citations
                  remain in the provenance audit.
                </p>
                <Button variant="outline">Publish reviewed correction</Button>
              </fieldset>
            </form>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = new FormData(e.currentTarget);
              void action(
                () =>
                  api(`/knowledge/${page.id}/schedule`, {
                    method: 'PUT',
                    body: JSON.stringify({
                      enabled: values.get('enabled') === 'on',
                      intervalDays: Number(values.get('days')),
                      sourceIds: values.getAll('source'),
                    }),
                  }),
                'Synthesis schedule saved.',
              );
            }}
          >
            <fieldset disabled={busy}>
              <legend>Scheduled source digest</legend>
              <label className="agent-checkrow">
                <Input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={data.schedule?.enabled ?? false}
                />
                Propose source digests for review
              </label>
              <label>
                Interval in days
                <Input
                  name="days"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={data.schedule?.interval_days ?? 7}
                />
              </label>
              {sameAudience.map((p) => (
                <label className="agent-checkrow" key={p.id}>
                  <Input
                    name="source"
                    value={p.id}
                    type="checkbox"
                    defaultChecked={data.schedule?.source_ids.includes(p.id) ?? false}
                  />
                  {p.title}
                </label>
              ))}
              <Button variant="outline">Save synthesis schedule</Button>
            </fieldset>
          </form>
        </>
      )}
      {data.proposals.map((proposal) => (
        <article key={proposal.id}>
          <h4>Proposed source digest</h4>
          <RichMessage body={proposal.body} format="markdown" />
          {owner && (
            <div className="document-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(
                    () =>
                      post(`/knowledge/${page.id}/proposals/${proposal.id}/decisions`, {
                        decision: 'accepted',
                      }),
                    'Digest published as a new version.',
                  )
                }
              >
                Accept digest
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(
                    () =>
                      post(`/knowledge/${page.id}/proposals/${proposal.id}/decisions`, {
                        decision: 'rejected',
                      }),
                    'Digest rejected.',
                  )
                }
              >
                Reject digest
              </Button>
            </div>
          )}
        </article>
      ))}
      <h3>Review history</h3>
      {reviewPage.items.map((review) => (
        <article key={review.id}>
          <strong>
            {review.author_name} · v{review.page_version} · {review.decision}
          </strong>
          <p>{review.evidence}</p>
        </article>
      ))}
      <PageControls {...reviewPage} onMore={reviewPage.more} />
      <h3>Page discussion</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget,
            values = new FormData(form);
          void action(async () => {
            await post(`/knowledge/${page.id}/comments`, {
              clientId: commentKey.current,
              body: values.get('body'),
              anchor: values.get('anchor'),
            });
            form.reset();
          }, 'Comment added.');
        }}
      >
        <fieldset disabled={busy}>
          <label>
            Comment
            <Textarea
              name="body"
              required
              maxLength={5000}
              onChange={() => {
                commentKey.current = crypto.randomUUID();
              }}
            />
          </label>
          <label>
            Quoted passage
            <Input name="anchor" maxLength={200} />
          </label>
          <Button variant="outline">Add page comment</Button>
        </fieldset>
      </form>
      {commentPage.items.map((c) => (
        <article key={c.id}>
          <strong>{c.author_name}</strong>
          {c.anchor && <blockquote>{c.anchor}</blockquote>}
          <RichMessage body={c.body} format="markdown" />
          {c.resolved_at ? (
            <small>Resolved</small>
          ) : (
            (owner || c.author_id === boot.me.id) && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(
                    () => post(`/knowledge/${page.id}/comments/${c.id}/resolve`, {}),
                    'Comment resolved.',
                  )
                }
              >
                Resolve comment
              </Button>
            )
          )}
        </article>
      ))}
      <PageControls {...commentPage} onMore={commentPage.more} />
      {owner && (
        <>
          <h3>Export and deletion</h3>
          <a className="subtle-button" href={`/api/v1/knowledge/${page.id}/export`} download>
            Export approved page with provenance
          </a>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = new FormData(e.currentTarget);
              void action(async () => {
                await api(`/knowledge/${page.id}`, {
                  method: 'DELETE',
                  body: JSON.stringify({ version: page.version, reason: values.get('reason') }),
                });
                onDeleted();
              }, 'Page deleted.');
            }}
          >
            <label>
              Deletion reason
              <Input name="reason" required minLength={5} maxLength={500} />
            </label>
            <p className="muted">
              Deletion immediately removes access and invalidates derived knowledge. Retained
              revisions are erased after the workspace retention period unless a legal hold applies.
            </p>
            <Button variant="outline" disabled={busy}>
              Delete this knowledge page
            </Button>
          </form>
        </>
      )}
    </section>
  );
}
