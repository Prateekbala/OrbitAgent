import { tenantScope, scopedDatabase } from '@ao/database';
import { afterEach, describe, it, expect } from 'vitest';
import { messagingFixture } from './messaging-fixture.js';
import { RetrievalWorker } from '../src/retrieval/worker.js';
import { EmbeddingWorker } from '../src/retrieval/embedding-worker.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
async function agent() {
  const r = await f.call(f.owner, 'POST', '/v1/agents', {
    name: 'Memory steward',
    role: 'Use authorized cited evidence.',
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
}
const until = () => new Date(Date.now() + 86400000).toISOString();
describe('memory release governance', () => {
  it('requires explicit source ownership, preserves immutable release evidence and invalidates releases after corrections', async () => {
    f = await messagingFixture();
    const id = await agent(),
      channel = await f.channel('private'),
      source = (await f.send(f.owner, channel, 'PrivateReleaseOrigin')).json<{ id: string }>();
    const saved = await f.call(f.owner, 'POST', '/v1/memory', {
      agentId: id,
      boundary: 'private',
      title: 'Owned source',
      body: 'ReleasedMemoryEvidence',
      sources: [{ kind: 'message', id: source.id, version: 1 }],
      expiresAt: until(),
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const memory = saved.json().id;
    const released = await f.call(f.owner, 'POST', `/v1/memory/${memory}/declassify`, {
      version: 1,
      reason: 'I authorize sharing my authored source with this workspace.',
      acknowledgeAudienceExpansion: true,
    });
    expect(released.statusCode, released.body).toBe(201);
    const copy = released.json().id;
    const visible = (await f.call(f.mate, 'GET', '/v1/memory')).json().items;
    expect(visible.some((v: { id: string }) => v.id === copy)).toBe(true);
    expect(visible.some((v: { id: string }) => v.id === memory)).toBe(false);
    expect((await f.call(f.mate, 'GET', `/v1/memory/${copy}/export`)).statusCode).toBe(200);
    await new RetrievalWorker(f.db).tick();
    expect(
      (await f.call(f.mate, 'POST', '/v1/search/retrieve', { q: 'ReleasedMemoryEvidence' }))
        .json()
        .items.some((v: { id: string }) => v.id === copy),
    ).toBe(true);
    await f.call(f.owner, 'PATCH', `/v1/messages/${source.id}`, {
      version: 1,
      body: 'Corrected private origin',
    });
    expect(
      (await f.call(f.mate, 'GET', '/v1/memory'))
        .json()
        .items.some((v: { id: string }) => v.id === copy),
    ).toBe(false);
    expect(
      (await f.call(f.mate, 'POST', '/v1/search/retrieve', { q: 'ReleasedMemoryEvidence' }))
        .json()
        .items.some((v: { id: string }) => v.id === copy),
    ).toBe(false);
  });
  it('does not let an administrator declassify another author’s evidence', async () => {
    f = await messagingFixture();
    const id = await agent(),
      channel = await f.channel(),
      source = (await f.send(f.mate, channel, 'Other author private interpretation')).json<{
        id: string;
      }>();
    const saved = await f.call(f.owner, 'POST', '/v1/memory', {
      agentId: id,
      boundary: 'workspace',
      title: 'Mixed ownership',
      body: 'A retained interpretation',
      sources: [{ kind: 'message', id: source.id, version: 1 }],
      expiresAt: until(),
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const result = await f.call(f.owner, 'POST', `/v1/memory/${saved.json().id}/declassify`, {
      version: 1,
      reason: 'Attempt to share a mixed owner source.',
      acknowledgeAudienceExpansion: true,
    });
    expect(result.statusCode, result.body).toBe(403);
    expect(result.json().error.code).toBe('SOURCE_OWNER_APPROVAL_REQUIRED');
  });
  it('rejects transitive memory cycles and bounds provenance path expansion', async () => {
    f = await messagingFixture();
    const agentId = await agent(),
      channel = await f.channel(),
      message = (await f.send(f.owner, channel, 'Graph source')).json<{ id: string }>();
    const source = { kind: 'message', id: message.id, version: 1 };
    const input = {
      agentId,
      boundary: 'private',
      title: 'Graph memory',
      body: 'Retained cited fact',
      sources: [source],
      expiresAt: until(),
    };
    const first = (await f.call(f.owner, 'POST', '/v1/memory', input)).json<{ id: string }>();
    const second = (
      await f.call(f.owner, 'POST', '/v1/memory', {
        ...input,
        sources: [{ kind: 'memory', id: first.id, version: 1 }],
      })
    ).json<{ id: string }>();
    const cycle = await f.call(f.owner, 'PATCH', `/v1/memory/${first.id}`, {
      version: 1,
      title: 'Cycle attempt',
      body: 'Invalid cycle',
      reason: 'Must reject cyclic evidence',
      sources: [source, { kind: 'memory', id: second.id, version: 1 }],
    });
    expect(cycle.statusCode, cycle.body).toBe(409);
    expect(cycle.json().error.code).toBe('MEMORY_PROVENANCE_LIMIT');
    const fanout = await f.call(f.owner, 'POST', '/v1/memory', {
      ...input,
      sources: Array.from({ length: 20 }, () => source),
    });
    expect(fanout.statusCode, fanout.body).toBe(201);
    const exponential = await f.call(f.owner, 'POST', '/v1/memory', {
      ...input,
      sources: Array.from({ length: 20 }, () => ({
        kind: 'memory',
        id: fanout.json().id,
        version: 1,
      })),
    });
    expect(exponential.statusCode, exponential.body).toBe(409);
    expect(exponential.json().error.code).toBe('MEMORY_PROVENANCE_LIMIT');
    const [bounded] = await tenantScope(f.ownerBoot.workspace.id, () =>
      scopedDatabase(f.db).query('SELECT memory_graph_valid($1,$2) allowed', [
        f.ownerBoot.workspace.id,
        JSON.stringify(Array.from({ length: 21 }, () => source)),
      ]),
    );
    expect(bounded!.allowed).toBe(false);
  });
});
describe('real embedding provider boundary', () => {
  it('indexes finite vectors through durable actor-bound jobs and ranks independently of lexical overlap', async () => {
    let calls = 0;
    const embeddings = {
      model: 'fixture/semantic',
      async embed(values: string[]) {
        calls++;
        return values.map((v) =>
          v.includes('Astronomy') || v.includes('space science') ? [1, 0] : [0, 1],
        );
      },
    };
    f = await messagingFixture(undefined, undefined, { embeddings });
    const channel = await f.channel();
    const source = (await f.send(f.owner, channel, 'Astronomy research findings')).json<{
      id: string;
    }>();
    await f.send(f.owner, channel, 'Cooking recipes');
    await new RetrievalWorker(f.db).tick();
    const queued = await f.call(f.owner, 'POST', '/v1/search/embeddings', {
      sources: [{ kind: 'message', id: source.id, version: 1 }],
    });
    expect(queued.statusCode, queued.body).toBe(200);
    await new EmbeddingWorker(f.db, embeddings).tick();
    expect(
      (
        await f.db.query('SELECT embedding FROM retrieval_chunks WHERE source_id=$1', [source.id])
      )[0]!.embedding,
    ).toEqual([1, 0]);
    const result = await f.call(f.owner, 'POST', '/v1/search/retrieve', {
      q: 'space science',
      semantic: true,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().items[0].id).toBe(source.id);
    expect(result.json().mode).toBe('hybrid');
    expect(calls).toBeGreaterThan(1);
  });
  it('never sends a revoked source into an embedding provider and rejects access changes during inference', async () => {
    let inputs: string[][] = [];
    let revoke = false;
    let channel = '';
    const embeddings = {
      model: 'fixture/semantic',
      async embed(values: string[]) {
        inputs.push(values);
        if (revoke)
          await f.db.query(
            'DELETE FROM conversation_members WHERE conversation_id=$1 AND membership_id=$2',
            [channel, f.mateBoot.me.id],
          );
        return values.map(() => [1, 0]);
      },
    };
    f = await messagingFixture(undefined, undefined, { embeddings });
    channel = await f.channel('private');
    await f.call(f.owner, 'POST', `/v1/conversations/${channel}/members`, {
      membershipId: f.mateBoot.me.id,
    });
    const source = (await f.send(f.owner, channel, 'EmbeddingRevocationSecret')).json<{
      id: string;
    }>();
    await new RetrievalWorker(f.db).tick();
    await f.call(f.mate, 'POST', '/v1/search/embeddings', {
      sources: [{ kind: 'message', id: source.id, version: 1 }],
    });
    await f.db.query(
      'DELETE FROM conversation_members WHERE conversation_id=$1 AND membership_id=$2',
      [channel, f.mateBoot.me.id],
    );
    await new EmbeddingWorker(f.db, embeddings).tick();
    expect(inputs).toHaveLength(0);
    await f.call(f.owner, 'POST', `/v1/conversations/${channel}/members`, {
      membershipId: f.mateBoot.me.id,
    });
    revoke = true;
    const result = await f.call(f.mate, 'POST', '/v1/search/retrieve', {
      q: 'EmbeddingRevocationSecret',
      semantic: true,
    });
    expect(result.statusCode, result.body).toBe(409);
    expect(result.body).not.toContain('excerpt');
  });
});
