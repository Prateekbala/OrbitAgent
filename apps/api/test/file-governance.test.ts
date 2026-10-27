import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { messagingFixture } from './messaging-fixture.js';
import { LocalFileStore } from '../src/files/storage.js';
import { FileGovernanceWorker } from '../src/files/governance-worker.js';
import { defaultDlpPolicy, uploadChunkBytes } from '@ao/contracts/file-governance';
import { scopedDatabase, tenantScope, identifyPrincipal } from '@ao/database';
let f: Awaited<ReturnType<typeof messagingFixture>>, directory: string;
let dependencies: Parameters<typeof messagingFixture>[0];
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbit-governance-'));
  dependencies = {
    store: new LocalFileStore(join(directory, 'objects')),
    stagingDirectory: join(directory, 'staging'),
    scanner: { scan: async () => 'clean' },
  };
  f = await messagingFixture(dependencies);
}, 30000);
afterAll(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});
async function reserve(channel: string, data: Buffer, name = 'notes.txt') {
  const r = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/files`, {
    name,
    size: data.length,
    sha256: sha(data),
    clientId: randomUUID(),
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function chunk(id: string, data: Buffer, offset = 0, session = f.owner) {
  return f.app.inject({
    method: 'PATCH',
    url: `/v1/files/${id}/upload`,
    headers: {
      cookie: `ao_session=${session}`,
      'content-type': 'application/offset+octet-stream',
      'upload-offset': String(offset),
      'upload-checksum': sha(data),
    },
    payload: data,
  });
}
async function upload(channel: string, data: Buffer, name = 'notes.txt') {
  const id = await reserve(channel, data, name);
  for (let offset = 0; offset < data.length; offset += uploadChunkBytes) {
    const r = await chunk(id, data.subarray(offset, offset + uploadChunkBytes), offset);
    expect(r.statusCode, r.body).toBe(200);
  }
  const r = await f.call(f.owner, 'POST', `/v1/files/${id}/upload/complete`);
  expect(r.statusCode, r.body).toBe(200);
  return id;
}
async function attach(channel: string, file: string) {
  const r = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/messages`, {
    body: 'File',
    clientId: randomUUID(),
    attachmentIds: [file],
  });
  expect(r.statusCode, r.body).toBe(201);
}
it('resumes from committed offsets, rejects changed replays and other owners, and finalizes once', async () => {
  const channel = await f.channel(),
    data = Buffer.alloc(uploadChunkBytes + 5, 65),
    id = await reserve(channel, data);
  expect((await chunk(id, data.subarray(uploadChunkBytes), uploadChunkBytes)).statusCode).toBe(409);
  expect((await chunk(id, data.subarray(0, uploadChunkBytes))).json().offset).toBe(
    uploadChunkBytes,
  );
  expect((await chunk(id, data.subarray(0, uploadChunkBytes))).json().offset).toBe(
    uploadChunkBytes,
  );
  expect((await chunk(id, Buffer.alloc(uploadChunkBytes, 66))).statusCode).toBe(409);
  expect(
    (await chunk(id, data.subarray(uploadChunkBytes), uploadChunkBytes, f.mate)).statusCode,
  ).toBe(404);
  expect((await f.call(f.owner, 'POST', `/v1/files/${id}/upload/complete`)).statusCode).toBe(409);
  expect((await chunk(id, data.subarray(uploadChunkBytes), uploadChunkBytes)).json().offset).toBe(
    data.length,
  );
  for (let i = 0; i < 2; i++)
    expect((await f.call(f.owner, 'POST', `/v1/files/${id}/upload/complete`)).statusCode).toBe(200);
  const result = await f.call(f.owner, 'GET', `/v1/files/${id}/content`);
  expect(result.rawPayload).toEqual(data);
});
it('serves single byte ranges and preserves immutable versions without double charging storage', async () => {
  const channel = await f.channel(),
    original = Buffer.from('0123456789'),
    id = await upload(channel, original);
  await attach(channel, id);
  const ranged = await f.app.inject({
    method: 'GET',
    url: `/v1/files/${id}/content`,
    headers: { cookie: `ao_session=${f.owner}`, range: 'bytes=2-5' },
  });
  expect(ranged.statusCode, ranged.body).toBe(206);
  expect(ranged.body).toBe('2345');
  expect(ranged.headers['content-range']).toBe('bytes 2-5/10');
  const invalid = await f.app.inject({
    method: 'GET',
    url: `/v1/files/${id}/content`,
    headers: { cookie: `ao_session=${f.owner}`, range: 'bytes=99-' },
  });
  expect(invalid.statusCode).toBe(416);
  expect((await f.call(f.owner, 'POST', `/v1/search/files/${id}/extract`, {})).statusCode).toBe(
    200,
  );
  const [extraction] = await f.db.query('SELECT version FROM file_extractions WHERE file_id=$1', [
    id,
  ]);
  const next = await upload(channel, Buffer.from('replacement'));
  const before = (
    await f.db.query('SELECT storage_bytes FROM workspaces WHERE id=$1', [f.ownerBoot.workspace.id])
  )[0]!.storage_bytes;
  const input = { fileId: next, expectedVersion: 1, clientId: randomUUID() };
  for (let i = 0; i < 2; i++) {
    const r = await f.call(f.owner, 'POST', `/v1/files/${id}/versions`, input);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().version).toBe(2);
  }
  expect((await f.call(f.owner, 'GET', `/v1/files/${id}/content?version=1`)).body).toBe(
    original.toString(),
  );
  expect((await f.call(f.owner, 'GET', `/v1/files/${id}/content`)).body).toBe('replacement');
  expect((await f.call(f.owner, 'POST', `/v1/search/files/${id}/extract`, {})).statusCode).toBe(
    200,
  );
  const [replacement] = await f.db.query('SELECT version FROM file_extractions WHERE file_id=$1', [
    id,
  ]);
  expect(Number(replacement!.version)).toBeGreaterThan(Number(extraction!.version));
  expect(
    (
      await f.db.query('SELECT storage_bytes FROM workspaces WHERE id=$1', [
        f.ownerBoot.workspace.id,
      ])
    )[0]!.storage_bytes,
  ).toBe(before);
  expect((await f.call(f.other, 'GET', `/v1/files/${id}/versions`)).statusCode).toBe(404);
});
it('enforces explicit recipients, one-time download limits, current access, and immutable grants', async () => {
  const policy = await f.call(f.owner, 'PUT', '/v1/files/policy', {
    ...defaultDlpPolicy,
    sharing: true,
  });
  expect(policy.statusCode, policy.body).toBe(200);
  const channel = await f.channel(),
    id = await upload(channel, Buffer.from('shared bytes'));
  await attach(channel, id);
  const created = await f.call(f.owner, 'POST', `/v1/files/${id}/shares`, {
    recipientIds: [f.mateBoot.me.id],
    expiresInHours: 1,
    maxDownloads: 1,
  });
  expect(created.statusCode, created.body).toBe(200);
  const token = created.json().path.split('.')[1],
    proof = { id: created.json().id, token };
  expect((await f.call(f.other, 'POST', '/v1/file-shares/resolve', proof)).statusCode).toBe(404);
  const scoped = scopedDatabase(f.db);
  await expect(
    tenantScope(f.ownerBoot.workspace.id, async () => {
      identifyPrincipal(f.mateBoot.me.id, 'member');
      return scoped.query('UPDATE file_shares SET max_downloads=99 WHERE id=$1', [proof.id]);
    }),
  ).rejects.toThrow(/permission denied/);
  const content = await f.call(f.mate, 'POST', '/v1/file-shares/content', proof);
  expect(content.statusCode, content.body).toBe(200);
  expect(content.body).toBe('shared bytes');
  expect((await f.call(f.mate, 'POST', '/v1/file-shares/content', proof)).statusCode).toBe(404);
  const second = await f.call(f.owner, 'POST', `/v1/files/${id}/shares`, {
    recipientIds: [f.mateBoot.me.id],
    expiresInHours: 1,
    maxDownloads: 10,
  });
  const otherProof = { id: second.json().id, token: second.json().path.split('.')[1] };
  expect(
    (await f.call(f.owner, 'DELETE', `/v1/files/${id}/shares/${otherProof.id}`)).statusCode,
  ).toBe(200);
  expect((await f.call(f.mate, 'POST', '/v1/file-shares/resolve', otherProof)).statusCode).toBe(
    404,
  );
});
it('blocks stale inspections, rescans existing versions and keeps detected secrets out of findings', async () => {
  const channel = await f.channel(),
    id = await upload(channel, Buffer.from('-----BEGIN PRIVATE KEY-----\nsecret bytes'));
  await attach(channel, id);
  const before = await f.call(f.owner, 'GET', '/v1/files/policy');
  const changed = await f.call(f.owner, 'PUT', '/v1/files/policy', {
    ...before.json<Record<string, unknown>>(),
    enabled: true,
    requireInspection: true,
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect((await f.call(f.owner, 'GET', `/v1/files/${id}/content`)).json().error.code).toBe(
    'DLP_BLOCKED',
  );
  await new FileGovernanceWorker(f.db, dependencies!).tick();
  expect((await f.call(f.owner, 'GET', `/v1/files/${id}/content`)).statusCode).toBe(403);
  const row = (await f.db.query('SELECT dlp_findings FROM files WHERE id=$1', [id]))[0]!;
  expect(JSON.stringify(row)).toContain('private_key');
  expect(JSON.stringify(row)).not.toContain('secret bytes');
  const bad = await reserve(channel, Buffer.from('-----BEGIN PRIVATE KEY-----\nnew secret'));
  expect(
    (await chunk(bad, Buffer.from('-----BEGIN PRIVATE KEY-----\nnew secret'))).statusCode,
  ).toBe(200);
  expect((await f.call(f.owner, 'POST', `/v1/files/${bad}/upload/complete`)).statusCode).toBe(422);
});
