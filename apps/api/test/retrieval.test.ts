import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { identifyPrincipal, scopedDatabase, tenantScope } from '@ao/database';
import type { RetrievalResult } from '@ao/contracts/retrieval';
import { messagingFixture } from './messaging-fixture.js';
import { RetrievalWorker } from '../src/retrieval/worker.js';
import { chunks, terms, cosine, assertVectors } from '../src/retrieval/text.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
let worker: RetrievalWorker;
beforeAll(async () => {
  f = await messagingFixture();
  worker = new RetrievalWorker(f.db);
});
afterAll(async () => {
  await f?.close();
});
const search = (session: string, q: string, extra: Record<string, unknown> = {}) =>
  f.call(session, 'POST', '/v1/search/retrieve', { q, ...extra });
const expiry = () => new Date(Date.now() + 86400000).toISOString();
describe('retrieval and inspectable memory', () => {
  it('coordinates full orphan sweeps without exposing orphan content between sweeps', async () => {
    const workspace = f.ownerBoot.workspace.id,
      id = randomUUID();
    await worker.tick();
    const [before] = await f.db.query(
      'SELECT epoch,next_orphan_sweep::text scheduled FROM retrieval_authority WHERE workspace_id=$1',
      [workspace],
    );
    await f.db.query(
      "INSERT INTO retrieval_documents(workspace_id,kind,source_id,source_version,title,body) VALUES($1,'message',$2,1,'Orphan','OrphanSweepEvidence')",
      [workspace, id],
    );
    await f.db.query(
      "INSERT INTO retrieval_chunks(workspace_id,kind,source_id,ordinal,body,terms) VALUES($1,'message',$2,0,'OrphanSweepEvidence',to_tsvector('simple','OrphanSweepEvidence'))",
      [workspace, id],
    );
    expect((await search(f.owner, 'OrphanSweepEvidence')).json().items).toHaveLength(0);
    await new RetrievalWorker(f.db).tick();
    expect(
      await f.db.query('SELECT source_id FROM retrieval_documents WHERE source_id=$1', [id]),
    ).toHaveLength(1);
    const [unchanged] = await f.db.query(
      'SELECT next_orphan_sweep::text scheduled FROM retrieval_authority WHERE workspace_id=$1',
      [workspace],
    );
    expect(unchanged!.scheduled).toBe(before!.scheduled);
    await f.db.query(
      "UPDATE retrieval_authority SET next_orphan_sweep=now()-interval '1 second' WHERE workspace_id=$1",
      [workspace],
    );
    await worker.tick();
    expect(
      await f.db.query('SELECT source_id FROM retrieval_documents WHERE source_id=$1', [id]),
    ).toHaveLength(0);
    const [after] = await f.db.query(
      'SELECT epoch FROM retrieval_authority WHERE workspace_id=$1',
      [workspace],
    );
    expect(after!.epoch).toBe(before!.epoch);
  });
  it('indexes Unicode messages, tasks and knowledge with citations and tenant boundaries', async () => {
    const channel = await f.channel();
    await f.send(f.owner, channel, 'नमस्ते खोज multilingual evidence');
    await f.send(f.owner, channel, '東京 検索 evidence');
    const task = await f.call(f.owner, 'POST', '/v1/tasks', {
      title: 'Retrieval test evidence',
      description: 'Delivery evidence',
      priority: 'normal',
    });
    expect(task.statusCode, task.body).toBe(201);
    const page = await f.call(f.owner, 'POST', '/v1/knowledge', {
      title: 'Evidence handbook',
      body: 'Evidence for a release',
    });
    expect(page.statusCode, page.body).toBe(201);
    await worker.tick();
    const result = await search(f.mate, 'evidence');
    expect(result.statusCode, result.body).toBe(200);
    const body = result.json<RetrievalResult>();
    expect(new Set(body.items.map((v) => v.kind))).toEqual(
      new Set(['message', 'task', 'knowledge']),
    );
    expect(body.items.every((v) => /^\[\d+\]$/.test(v.citation))).toBe(true);
    expect((await search(f.mate, 'नमस्ते')).json<RetrievalResult>().items).toHaveLength(1);
    expect((await search(f.mate, '東京')).json<RetrievalResult>().items).toHaveLength(1);
    expect((await search(f.other, 'evidence')).json<RetrievalResult>().items).toHaveLength(0);
    expect(
      (await f.call(f.owner, 'POST', '/v1/search/answer', { q: 'neverpresentxyz' })).json()
        .indicators.missingEvidence,
    ).toBe(true);
  });
  it('does not hydrate private candidates and invalidates cached contexts immediately on access revocation', async () => {
    const channel = await f.channel('private');
    await f.call(f.owner, 'POST', `/v1/conversations/${channel}/members`, {
      membershipId: f.mateBoot.me.id,
    });
    await f.send(f.owner, channel, 'RevocationSecret retrieval');
    await worker.tick();
    const found = (await search(f.mate, 'RevocationSecret')).json<RetrievalResult>();
    expect(found.items).toHaveLength(1);
    expect(
      (await f.call(f.owner, 'GET', `/v1/search/contexts/${found.contextId}`)).statusCode,
    ).toBe(409);
    await f.db.query(
      'DELETE FROM conversation_members WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3',
      [f.ownerBoot.workspace.id, channel, f.mateBoot.me.id],
    );
    expect((await f.call(f.mate, 'GET', `/v1/search/contexts/${found.contextId}`)).statusCode).toBe(
      409,
    );
    expect((await search(f.mate, 'RevocationSecret')).json<RetrievalResult>().items).toHaveLength(
      0,
    );
    const rows = await tenantScope(f.ownerBoot.workspace.id, async () => {
      identifyPrincipal(f.mateBoot.me.id, 'member');
      return scopedDatabase(f.db).query(
        "SELECT body FROM retrieval_chunks WHERE body LIKE '%RevocationSecret%'",
      );
    });
    expect(rows).toHaveLength(0);
    const candidates = await tenantScope(f.ownerBoot.workspace.id, async () => {
      identifyPrincipal(f.mateBoot.me.id, 'member');
      return scopedDatabase(f.db).query(
        "SELECT * FROM retrieval_candidates($1,'RevocationSecret',NULL,$2,false,301)",
        [f.ownerBoot.workspace.id, f.ownerBoot.me.id],
      );
    });
    expect(candidates).toHaveLength(0);
  });
  it('blocks edited/deleted evidence before index jobs run', async () => {
    const channel = await f.channel();
    const sent = (await f.send(f.owner, channel, 'ObsoleteEvidence')).json<{ id: string }>();
    await worker.tick();
    const found = (await search(f.owner, 'ObsoleteEvidence')).json<RetrievalResult>();
    await f.call(f.owner, 'PATCH', `/v1/messages/${sent.id}`, {
      body: 'ReplacementEvidence',
      version: 1,
    });
    expect((await search(f.owner, 'ObsoleteEvidence')).json<RetrievalResult>().items).toHaveLength(
      0,
    );
    expect(
      (await f.call(f.owner, 'GET', `/v1/search/contexts/${found.contextId}`)).statusCode,
    ).toBe(409);
    await worker.tick();
    expect(
      (await search(f.owner, 'ReplacementEvidence')).json<RetrievalResult>().items,
    ).toHaveLength(1);
  });
  it('retains consented transcripts idempotently and expires them without leaking indexed bodies', async () => {
    const channel = await f.channel(),
      input = {
        conversationId: channel,
        title: 'Call evidence',
        body: 'TranscriptEvidence secret',
        language: 'en',
        consentReference: 'Participants consented in recording form',
        retainedUntil: expiry(),
        clientId: randomUUID(),
      };
    const saved = await f.call(f.owner, 'POST', '/v1/search/transcripts', input);
    expect(saved.statusCode, saved.body).toBe(201);
    expect((await f.call(f.owner, 'POST', '/v1/search/transcripts', input)).json().id).toBe(
      saved.json().id,
    );
    await worker.tick();
    expect((await search(f.mate, 'TranscriptEvidence')).json<RetrievalResult>().items).toHaveLength(
      1,
    );
    await f.db.query(
      "UPDATE retained_transcripts SET retained_until=now()-interval '1 second' WHERE id=$1",
      [saved.json().id],
    );
    expect((await search(f.mate, 'TranscriptEvidence')).json<RetrievalResult>().items).toHaveLength(
      0,
    );
    await worker.tick();
    expect(
      await f.db.query('SELECT body FROM retained_transcripts WHERE id=$1', [saved.json().id]),
    ).toHaveLength(0);
  });
  it('enforces memory provenance, private boundaries, correction history, forwarding intersections and erasure', async () => {
    const channel = await f.channel(),
      source = (await f.send(f.owner, channel, 'MemoryOriginEvidence')).json<{ id: string }>();
    const created = await f.call(f.owner, 'POST', '/v1/agents', {
      name: 'Memory agent',
      role: 'Retain cited evidence.',
    });
    expect(created.statusCode, created.body).toBe(201);
    const agents = (await f.call(f.owner, 'GET', '/v1/agents')).json<{ id: string }[]>();
    expect(agents.length).toBeGreaterThan(0);
    const input = {
      agentId: agents[0]!.id,
      boundary: 'private',
      title: 'Inspected memory',
      body: 'RetainedMemoryEvidence',
      sources: [{ kind: 'message', id: source.id, version: 1 }],
      expiresAt: expiry(),
    };
    const saved = await f.call(f.owner, 'POST', '/v1/memory', input);
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().id;
    expect(
      (await f.call(f.mate, 'GET', '/v1/memory'))
        .json()
        .items.some((m: { id: string }) => m.id === id),
    ).toBe(false);
    const corrected = await f.call(f.owner, 'PATCH', `/v1/memory/${id}`, {
      version: 1,
      title: 'Corrected memory',
      body: 'CorrectedMemoryEvidence',
      reason: 'Fixed source interpretation',
      sources: input.sources,
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    const exported = await f.call(f.owner, 'GET', `/v1/memory/${id}/export`);
    expect(exported.json().revisions).toHaveLength(2);
    const forwarded = await f.call(f.owner, 'POST', `/v1/memory/${id}/forward`, {
      conversationId: channel,
      reason: 'Provide task context',
    });
    expect(forwarded.statusCode, forwarded.body).toBe(201);
    await worker.tick();
    expect(
      (await search(f.mate, 'CorrectedMemoryEvidence')).json<RetrievalResult>().items,
    ).toHaveLength(0);
    expect((await f.call(f.mate, 'DELETE', `/v1/memory/${id}`)).statusCode).toBe(404);
    expect((await f.call(f.owner, 'DELETE', `/v1/memory/${id}`)).statusCode).toBe(200);
    expect(
      await f.db.query('SELECT body FROM memory_revisions WHERE memory_id=$1', [id]),
    ).toHaveLength(0);
    expect(
      (await search(f.owner, 'CorrectedMemoryEvidence')).json<RetrievalResult>().items,
    ).toHaveLength(0);
  });
  it('handles apostrophes and punctuation without constructing invalid query syntax', async () => {
    const channel = await f.channel();
    const sent = (
      await f.send(f.owner, channel, "ApostropheEvidence can't block retrieval.")
    ).json<{ id: string }>();
    await worker.tick();
    const result = await search(f.owner, "can't ApostropheEvidence");
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json<RetrievalResult>().items.some((hit) => hit.id === sent.id)).toBe(true);
  });
  it('reports missing semantic configuration and queues fenced rebuilds', async () => {
    expect((await search(f.owner, 'evidence', { semantic: true })).statusCode).toBe(503);
    expect((await f.call(f.mate, 'GET', '/v1/search/health')).statusCode).toBe(403);
    const health = await f.call(f.owner, 'GET', '/v1/search/health');
    expect(health.statusCode, health.body).toBe(200);
    expect(health.json().measurements[0].queries).toBeGreaterThan(0);
    expect((await f.call(f.owner, 'POST', '/v1/search/rebuild', {})).statusCode).toBe(200);
    await worker.tick();
    expect((await search(f.owner, 'evidence')).statusCode).toBe(200);
  });
});
describe('retrieval primitives', () => {
  it('preserves code points and overlaps without fabricating semantic embeddings', () => {
    expect(chunks('😀abc😀def', 4, 1)).toEqual(['😀abc', 'c😀de', 'ef']);
    expect(terms('ＡＢＣ नमस्ते 東京')).toContain('abc');
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(() => assertVectors([[NaN]], 1)).toThrow();
    expect(() => chunks('test', 2, 2)).toThrow();
  });
});
