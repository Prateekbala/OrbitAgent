import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { scopedDatabase, tenantScope, identifyPrincipal, workerScope } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { KnowledgeWorker } from '../src/knowledge/worker.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
});
afterAll(async () => f?.close());
async function create(title = 'Knowledge ' + randomUUID(), conversationId?: string) {
  const response = await f.call(f.owner, 'POST', '/v1/knowledge', {
    title,
    body: 'Authoritative original content.',
    ...(conversationId ? { conversationId } : {}),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}
async function edit(id: string, version = 1, body = 'Corrected authoritative content.') {
  const r = await f.call(f.owner, 'PATCH', `/v1/knowledge/${id}`, {
    version,
    title: 'Current source',
    body,
    summary: 'Reviewed change',
    clientId: randomUUID(),
  });
  expect(r.statusCode, r.body).toBe(200);
  return r;
}
const governance = async (id: string) =>
  (await f.call(f.owner, 'GET', `/v1/knowledge/${id}/governance`)).json();
async function source(target: string, id: string, version = 1) {
  const r = await f.call(f.owner, 'POST', `/v1/knowledge/${target}/sources`, {
    type: 'page',
    id,
    version,
  });
  expect(r.statusCode, r.body).toBe(200);
}
async function review(id: string, version = 1, decision = 'approved') {
  const meta = await governance(id);
  return f.call(f.owner, 'POST', `/v1/knowledge/${id}/reviews`, {
    reviewEpoch: meta.review_epoch,
    version,
    decision,
    evidence: 'Reviewed against the original source evidence.',
  });
}
describe('collaborative and governed knowledge', () => {
  it('merges simultaneous CRDT edits and deduplicates updates into immutable attributed versions', async () => {
    const id = await create(),
      state = (await f.call(f.owner, 'GET', `/v1/knowledge/${id}/document`)).json();
    const a = new Y.Doc(),
      b = new Y.Doc();
    Y.applyUpdate(a, Buffer.from(state.update, 'base64'));
    Y.applyUpdate(b, Buffer.from(state.update, 'base64'));
    a.getText('body').insert(0, 'Alice. ');
    b.getText('body').insert(0, 'Bob. ');
    const sync = (session: string, doc: Y.Doc) =>
      f.call(session, 'POST', `/v1/knowledge/${id}/document`, {
        generation: state.generation,
        update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
      });
    const responses = await Promise.all([sync(f.owner, a), sync(f.mate, b)]);
    responses.forEach((r) => expect(r.statusCode, r.body).toBe(200));
    const page = (await f.call(f.owner, 'GET', `/v1/knowledge/${id}`)).json();
    expect(page.body).toContain('Alice.');
    expect(page.body).toContain('Bob.');
    expect(page.version).toBe(3);
    expect((await sync(f.owner, a)).json().version).toBe(3);
    const versions = (await f.call(f.owner, 'GET', `/v1/knowledge/${id}/versions`)).json();
    expect(versions.items).toHaveLength(3);
    expect(new Set(versions.items.map((v: { author_name: string }) => v.author_name))).toEqual(
      new Set(['Owner', 'Teammate']),
    );
    a.destroy();
    b.destroy();
  });
  it('rejects stale generations, invalid shared roots and updates after access revocation', async () => {
    const channel = await f.channel('private'),
      id = await create(undefined, channel),
      state = (await f.call(f.owner, 'GET', `/v1/knowledge/${id}/document`)).json();
    expect((await f.call(f.mate, 'GET', `/v1/knowledge/${id}/document`)).statusCode).toBe(404);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(state.update, 'base64'));
    doc.getMap('unauthorized').set('x', 'y');
    const invalid = await f.call(f.owner, 'POST', `/v1/knowledge/${id}/document`, {
      generation: state.generation,
      update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    await edit(id);
    const next = (await f.call(f.owner, 'GET', `/v1/knowledge/${id}/document`)).json();
    expect(next.generation).not.toBe(state.generation);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/knowledge/${id}/document`, {
          generation: state.generation,
          update: state.update,
        })
      ).json().error.code,
    ).toBe('DOCUMENT_RESET');
    const scoped = scopedDatabase(f.db);
    await tenantScope(f.ownerBoot.workspace.id, async () => {
      identifyPrincipal(f.mateBoot.me.id, 'member');
      expect(
        await scoped.query('SELECT * FROM knowledge_documents WHERE page_id=$1', [id]),
      ).toEqual([]);
    });
    doc.destroy();
  });
  it('enforces owner governance, current reviewers, audience-bound provenance and acyclic sources', async () => {
    const id = await create(),
      privatePage = await create(undefined, await f.channel('private'));
    expect(
      (
        await f.call(f.mate, 'PUT', `/v1/knowledge/${id}/governance`, {
          version: 1,
          ownerId: f.mateBoot.me.id,
          kind: 'decision',
          reviewers: [],
          freshUntil: null,
          state: 'active',
          supersededBy: null,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/knowledge/${id}/sources`, {
          type: 'page',
          id: privatePage,
          version: 1,
        })
      ).json().error.code,
    ).toBe('SOURCE_UNAVAILABLE');
    const other = await create();
    await source(id, other);
    const cycle = await f.call(f.owner, 'POST', `/v1/knowledge/${other}/sources`, {
      type: 'page',
      id,
      version: 1,
    });
    expect(cycle.statusCode).toBeGreaterThanOrEqual(400);
    const meta = await governance(id);
    const r = await f.call(f.owner, 'PUT', `/v1/knowledge/${id}/governance`, {
      version: meta.version,
      ownerId: f.ownerBoot.me.id,
      kind: 'decision',
      reviewers: [f.mateBoot.me.id],
      freshUntil: null,
      state: 'active',
      supersededBy: null,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(
      (
        await f.call(f.mate, 'POST', `/v1/knowledge/${id}/reviews`, {
          version: 1,
          decision: 'approved',
          reviewEpoch: (await governance(id)).review_epoch,
          evidence: 'Evidence checked independently.',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.owner, 'GET', `/v1/knowledge/${id}/export`)).json().sources[0].source_page_id,
    ).toBe(other);
  });
  it('propagates corrections and deletions transitively and requires a reviewed correction to unblock exports', async () => {
    const original = await create(),
      derived = await create('Derived factual record'),
      downstream = await create();
    await source(derived, original);
    await source(downstream, derived);
    await edit(original);
    expect((await governance(derived)).review_state).toBe('stale');
    expect((await governance(downstream)).review_state).toBe('stale');
    expect((await review(derived)).json().error.code).toBe('STALE_SOURCES');
    expect(
      (
        await f.call(f.owner, 'DELETE', `/v1/knowledge/${original}`, {
          version: 2,
          reason: 'Source withdrawn by its owner.',
        })
      ).statusCode,
    ).toBe(200);
    expect((await governance(derived)).blocked).toBe(true);
    expect((await governance(downstream)).blocked).toBe(true);
    expect((await f.call(f.owner, 'GET', `/v1/knowledge/${original}`)).statusCode).toBe(404);
    const search = (
      await f.call(f.owner, 'GET', '/v1/search/advanced?scope=knowledge&q=Derived')
    ).json();
    expect(search.items.some((p: { id: string }) => p.id === derived)).toBe(false);
    const correction = await f.call(f.owner, 'POST', `/v1/knowledge/${derived}/corrections`, {
      version: 1,
      title: 'Corrected record',
      body: 'Withdrawn source no longer supports the previous conclusion.',
      summary: 'Removed the withdrawn conclusion.',
      sources: [],
    });
    expect(correction.statusCode, correction.body).toBe(200);
    expect((await governance(derived)).blocked).toBe(false);
    expect((await review(derived, 2)).statusCode).toBe(200);
    const exported = await f.call(f.owner, 'GET', `/v1/knowledge/${derived}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json().provenance.map((p: { operation: string }) => p.operation)).toEqual([
      'linked',
      'removed',
    ]);
  });
  it('attributes comments, deduplicates retries, restricts resolution and invalidates reviewed pages on edit', async () => {
    const id = await create(),
      clientId = randomUUID(),
      comment = { clientId, body: 'Please explain this decision.', anchor: 'original' };
    expect((await f.call(f.mate, 'POST', `/v1/knowledge/${id}/comments`, comment)).statusCode).toBe(
      201,
    );
    expect((await f.call(f.mate, 'POST', `/v1/knowledge/${id}/comments`, comment)).statusCode).toBe(
      201,
    );
    expect((await governance(id)).comments).toHaveLength(1);
    expect(
      (await f.call(f.other, 'POST', `/v1/knowledge/${id}/comments/${clientId}/resolve`, {}))
        .statusCode,
    ).toBe(404);
    expect(
      (await f.call(f.owner, 'POST', `/v1/knowledge/${id}/comments/${clientId}/resolve`, {}))
        .statusCode,
    ).toBe(200);
    expect((await review(id)).statusCode).toBe(200);
    await edit(id);
    expect((await governance(id)).review_state).toBe('draft');
  });
  it('schedules cited extractive proposals without overwriting human changes and invalidates changed citations', async () => {
    const id = await create(),
      sourceId = await create('Reference manual');
    expect(
      (
        await f.call(f.owner, 'PUT', `/v1/knowledge/${id}/schedule`, {
          enabled: true,
          intervalDays: 1,
          sourceIds: [sourceId],
        })
      ).statusCode,
    ).toBe(200);
    const worker = new KnowledgeWorker(f.db);
    await worker.tick();
    let meta = await governance(id);
    expect(meta.proposals).toHaveLength(1);
    expect(meta.proposals[0].body).toContain(sourceId);
    await edit(id);
    const stale = await f.call(
      f.owner,
      'POST',
      `/v1/knowledge/${id}/proposals/${meta.proposals[0].id}/decisions`,
      { decision: 'accepted' },
    );
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    await edit(sourceId);
    meta = await governance(id);
    expect(meta.proposals).toHaveLength(0);
    await f.db.query('UPDATE knowledge_schedules SET next_at=now() WHERE page_id=$1', [id]);
    await worker.tick();
    meta = await governance(id);
    expect(meta.proposals).toHaveLength(1);
    const accepted = await f.call(
      f.owner,
      'POST',
      `/v1/knowledge/${id}/proposals/${meta.proposals[0].id}/decisions`,
      { decision: 'accepted' },
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await governance(id)).sources[0].source_version).toBe(2);
  });
  it('honors retention and legal holds before physically erasing deleted pages and their revisions', async () => {
    const id = await create();
    await f.call(f.owner, 'DELETE', `/v1/knowledge/${id}`, {
      version: 1,
      reason: 'Document no longer needed.',
    });
    const db = scopedDatabase(f.db);
    await workerScope(f.ownerBoot.workspace.id, async () => {
      expect(
        (
          await db.query('SELECT purge_deleted_knowledge($1,$2) purged', [
            f.ownerBoot.workspace.id,
            id,
          ])
        )[0]?.purged,
      ).toBe(false);
    });
    await f.db.query(
      "UPDATE knowledge_metadata SET deleted_at=now()-interval '40 days' WHERE page_id=$1",
      [id],
    );
    await f.call(f.owner, 'PUT', '/v1/knowledge-retention', { days: 30, legalHold: true });
    await new KnowledgeWorker(f.db).tick();
    expect((await f.db.query('SELECT id FROM knowledge_pages WHERE id=$1', [id])).length).toBe(1);
    await f.call(f.owner, 'PUT', '/v1/knowledge-retention', { days: 30, legalHold: false });
    await new KnowledgeWorker(f.db).tick();
    expect(await f.db.query('SELECT id FROM knowledge_pages WHERE id=$1', [id])).toEqual([]);
    expect(await f.db.query('SELECT id FROM knowledge_versions WHERE page_id=$1', [id])).toEqual(
      [],
    );
  });
  it('paginates comments with page- and reader-bound cursors', async () => {
    const id = await create(),
      other = await create();
    await f.db.query(
      "INSERT INTO knowledge_comments(id,workspace_id,page_id,author_id,body,created_at) SELECT gen_random_uuid(),$1,$2,$3,'Comment '||n,'2026-01-01T00:00:00Z'::timestamptz FROM generate_series(1,5) n",
      [f.ownerBoot.workspace.id, id, f.ownerBoot.me.id],
    );
    const first = (await f.call(f.owner, 'GET', `/v1/knowledge/${id}/comments?limit=2`)).json();
    expect(first.items).toHaveLength(2);
    expect(first.next).toBeTruthy();
    const second = (
      await f.call(
        f.owner,
        'GET',
        `/v1/knowledge/${id}/comments?limit=2&after=${encodeURIComponent(first.next)}`,
      )
    ).json();
    expect(new Set([...first.items, ...second.items].map((c: { id: string }) => c.id)).size).toBe(
      4,
    );
    expect(
      (
        await f.call(
          f.owner,
          'GET',
          `/v1/knowledge/${other}/comments?after=${encodeURIComponent(first.next)}`,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call(
          f.mate,
          'GET',
          `/v1/knowledge/${id}/comments?after=${encodeURIComponent(first.next)}`,
        )
      ).statusCode,
    ).toBe(400);
  });
  it('requires every assigned reviewer and invalidates approval when provenance changes', async () => {
    const id = await create(),
      reference = await create(),
      meta = await governance(id);
    const configured = await f.call(f.owner, 'PUT', `/v1/knowledge/${id}/governance`, {
      version: meta.version,
      ownerId: f.ownerBoot.me.id,
      kind: 'procedure',
      reviewers: [f.ownerBoot.me.id, f.mateBoot.me.id],
      freshUntil: null,
      state: 'active',
      supersededBy: null,
    });
    expect(configured.statusCode).toBe(200);
    await review(id);
    expect((await governance(id)).review_state).toBe('in_review');
    await f.call(f.mate, 'POST', `/v1/knowledge/${id}/reviews`, {
      version: 1,
      decision: 'approved',
      reviewEpoch: (await governance(id)).review_epoch,
      evidence: 'Independently reviewed all procedure steps.',
    });
    expect((await governance(id)).review_state).toBe('approved');
    await source(id, reference);
    expect((await governance(id)).review_state).toBe('draft');
  });
  it('fences synthesis on ownership transfer and propagates expired canonical freshness', async () => {
    const id = await create(),
      reference = await create(),
      derived = await create();
    await source(derived, reference);
    await f.call(f.owner, 'PUT', `/v1/knowledge/${id}/schedule`, {
      enabled: true,
      intervalDays: 1,
      sourceIds: [reference],
    });
    let meta = await governance(id);
    await f.call(f.owner, 'PUT', `/v1/knowledge/${id}/governance`, {
      version: meta.version,
      ownerId: f.mateBoot.me.id,
      kind: 'summary',
      reviewers: [],
      freshUntil: null,
      state: 'active',
      supersededBy: null,
    });
    expect((await governance(id)).schedule.enabled).toBe(false);
    meta = await governance(reference);
    await f.call(f.owner, 'PUT', `/v1/knowledge/${reference}/governance`, {
      version: meta.version,
      ownerId: f.ownerBoot.me.id,
      kind: 'decision',
      reviewers: [],
      freshUntil: '2020-01-01T00:00:00Z',
      state: 'active',
      supersededBy: null,
    });
    await new KnowledgeWorker(f.db).tick();
    expect((await governance(reference)).review_state).toBe('stale');
    expect((await governance(derived)).review_state).toBe('stale');
  });
  it('prevents derived pages and historical revisions from widening private join-time history', async () => {
    const group = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Scoped knowledge lineage',
      membershipIds: [f.mateBoot.me.id],
      historyPolicy: 'join_time',
    });
    expect(group.statusCode, group.body).toBe(201);
    const channel = group.json().id as string;
    const reference = await create('Earlier confidential source', channel);
    await f.call(f.owner, 'PATCH', `/v1/conversations/${channel}`, {
      version: 1,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    await f.call(f.owner, 'PATCH', `/v1/conversations/${channel}`, {
      version: 2,
      member: { membershipId: f.mateBoot.me.id, action: 'add' },
    });
    const derived = await create('Derived historical decision', channel);
    await source(derived, reference);
    expect((await f.call(f.mate, 'GET', `/v1/knowledge/${derived}`)).statusCode).toBe(404);
    const db = scopedDatabase(f.db);
    await tenantScope(f.ownerBoot.workspace.id, async () => {
      identifyPrincipal(f.mateBoot.me.id, 'member');
      expect(await db.query('SELECT body FROM knowledge_pages WHERE id=$1', [derived])).toEqual([]);
      expect(
        await db.query('SELECT body FROM knowledge_versions WHERE page_id=$1', [derived]),
      ).toEqual([]);
    });
    const meta = await governance(derived);
    const transfer = await f.call(f.owner, 'PUT', `/v1/knowledge/${derived}/governance`, {
      version: meta.version,
      ownerId: f.mateBoot.me.id,
      kind: 'decision',
      reviewers: [],
      freshUntil: null,
      state: 'active',
      supersededBy: null,
    });
    expect(transfer.json().error.code).toBe('SOURCE_ACCESS_REQUIRED');
    const correction = await f.call(f.owner, 'POST', `/v1/knowledge/${derived}/corrections`, {
      version: 1,
      title: 'Current decision',
      body: 'A new decision based solely on information shared after the new join.',
      summary: 'Removed all references to earlier confidential history.',
      sources: [],
    });
    expect(correction.statusCode, correction.body).toBe(200);
    expect((await f.call(f.mate, 'GET', `/v1/knowledge/${derived}`)).statusCode).toBe(200);
    expect((await f.call(f.mate, 'GET', `/v1/knowledge/${derived}/versions/1`)).statusCode).toBe(
      404,
    );
    expect((await f.call(f.mate, 'GET', `/v1/knowledge/${derived}/versions/2`)).statusCode).toBe(
      200,
    );
  });
});
