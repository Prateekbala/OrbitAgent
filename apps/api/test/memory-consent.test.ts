import { afterEach, describe, expect, it } from 'vitest';
import { messagingFixture } from './messaging-fixture.js';
import { RetrievalWorker } from '../src/retrieval/worker.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => f?.close());
async function memory() {
  f = await messagingFixture();
  const a = await f.call(f.owner, 'POST', '/v1/agents', {
    name: 'Memory steward',
    role: 'Retain cited evidence',
    runtime: 'external',
  });
  const channel = await f.channel(),
    first = (await f.send(f.owner, channel, 'Owner exact evidence')).json().id,
    second = (await f.send(f.mate, channel, 'Other owner exact evidence')).json().id;
  const saved = await f.call(f.owner, 'POST', '/v1/memory', {
    agentId: a.json().id,
    boundary: 'private',
    title: 'Private mixed interpretation',
    body: 'Private composed memory',
    sources: [
      { kind: 'message', id: first, version: 1 },
      { kind: 'message', id: second, version: 1 },
    ],
    expiresAt: new Date(Date.now() + 86400000 * 7).toISOString(),
  });
  expect(saved.statusCode, saved.body).toBe(201);
  const r = await f.call(f.owner, 'POST', `/v1/memory/${saved.json().id}/release-requests`, {
    version: 1,
    reason: 'Publish the cited interpretation to the workspace.',
    acknowledgeAudienceExpansion: true,
  });
  expect(r.statusCode, r.body).toBe(201);
  return { request: r.json().id as string, memory: saved.json().id as string, first, second };
}
async function decide(request: string, session: string, decision = 'approved') {
  const detail = await f.call(session, 'GET', `/v1/memory-release-requests/${request}`);
  expect(detail.statusCode, detail.body).toBe(200);
  return f.call(session, 'POST', `/v1/memory-release-requests/${request}/decision`, {
    decision,
    bodyHash: detail.json().bodyHash,
    acknowledgeAudienceExpansion: true,
  });
}
const publish = (id: string) =>
  f.call(f.owner, 'POST', `/v1/memory-release-requests/${id}/publish`, {
    acknowledgeAudienceExpansion: true,
  });
describe('mixed-owner memory source consent', () => {
  it('erases request/consent evidence with its source memory and purges released copies without restoring private content', async () => {
    const { request, memory: id } = await memory();
    expect((await decide(request, f.owner)).statusCode).toBe(200);
    expect((await decide(request, f.mate)).statusCode).toBe(200);
    const result = await publish(request);
    expect(result.statusCode, result.body).toBe(201);
    const deleted = await f.call(f.owner, 'DELETE', '/v1/memory/' + id);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(
      await f.db.query('SELECT id FROM memory_release_requests WHERE id=$1', [request]),
    ).toHaveLength(0);
    expect(
      await f.db.query('SELECT request_id FROM memory_source_consents WHERE request_id=$1', [
        request,
      ]),
    ).toHaveLength(0);
    expect((await f.call(f.mate, 'GET', `/v1/memory/${result.json().id}/export`)).statusCode).toBe(
      404,
    );
    await new RetrievalWorker(f.db).tick();
    expect(
      await f.db.query('SELECT id FROM agent_memories WHERE id=$1', [result.json().id]),
    ).toHaveLength(0);
  });
  it('requires every source owner, hides other private evidence during review, and invalidates a published release when consent is withdrawn', async () => {
    const { request, first, second } = await memory();
    const review = await f.call(f.mate, 'GET', `/v1/memory-release-requests/${request}`);
    expect(review.statusCode, review.body).toBe(200);
    expect(review.body).not.toContain('Private composed');
    expect(review.body).not.toContain('Private mixed');
    expect(review.body).not.toContain(first);
    expect(review.json().ownSources.map((s: { id: string }) => s.id)).toEqual([second]);
    expect(
      (await f.call(f.other, 'GET', `/v1/memory-release-requests/${request}`)).statusCode,
    ).toBe(404);
    expect((await publish(request)).statusCode).toBe(409);
    expect((await decide(request, f.owner)).statusCode).toBe(200);
    expect((await publish(request)).statusCode).toBe(409);
    expect((await decide(request, f.mate)).statusCode).toBe(200);
    const result = await publish(request);
    expect(result.statusCode, result.body).toBe(201);
    const copy = result.json().id;
    expect((await f.call(f.mate, 'GET', `/v1/memory/${copy}/export`)).statusCode).toBe(200);
    expect((await publish(request)).json().id).toBe(copy);
    await new RetrievalWorker(f.db).tick();
    const before = await f.call(f.mate, 'POST', '/v1/search/retrieve', { q: 'Private composed' });
    expect(before.json().items.some((r: { id: string }) => r.id === copy)).toBe(true);
    const [epoch] = await f.db.query(
      'SELECT epoch FROM retrieval_authority WHERE workspace_id=$1',
      [f.ownerBoot.workspace.id],
    );
    expect((await decide(request, f.mate, 'withdrawn')).statusCode).toBe(200);
    expect((await f.call(f.mate, 'GET', `/v1/memory/${copy}/export`)).statusCode).toBe(404);
    const [next] = await f.db.query('SELECT epoch FROM retrieval_authority WHERE workspace_id=$1', [
      f.ownerBoot.workspace.id,
    ]);
    expect(Number(next!.epoch)).toBeGreaterThan(Number(epoch!.epoch));
  });
  it('rejects stale source revisions and does not accept approval of a different body hash', async () => {
    const { request, second } = await memory();
    const invalid = await f.call(
      f.mate,
      'POST',
      `/v1/memory-release-requests/${request}/decision`,
      { decision: 'approved', bodyHash: '0'.repeat(64), acknowledgeAudienceExpansion: true },
    );
    expect(invalid.statusCode).toBe(404);
    expect((await decide(request, f.owner)).statusCode).toBe(200);
    expect((await decide(request, f.mate)).statusCode).toBe(200);
    await f.call(f.mate, 'PATCH', `/v1/messages/${second}`, {
      version: 1,
      body: 'Corrected source',
    });
    expect((await publish(request)).statusCode).toBe(409);
  });
  it('makes denial final and prevents an administrator from approving another owner’s sources', async () => {
    const { request } = await memory();
    expect((await decide(request, f.owner)).statusCode).toBe(200);
    expect((await publish(request)).statusCode).toBe(409);
    expect((await decide(request, f.mate, 'rejected')).statusCode).toBe(200);
    expect((await publish(request)).statusCode).toBe(409);
    expect((await decide(request, f.mate)).statusCode).toBe(409);
  });
});
