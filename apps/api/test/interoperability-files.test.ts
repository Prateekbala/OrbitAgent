import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messagingFixture } from './messaging-fixture.js';
import { LocalFileStore } from '../src/files/storage.js';
let f: Awaited<ReturnType<typeof messagingFixture>>, directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbit-migration-files-'));
  f = await messagingFixture({
    store: new LocalFileStore(join(directory, 'objects')),
    scanner: { scan: async () => 'clean' },
    stagingDirectory: join(directory, 'staging'),
  });
});
afterAll(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});
async function upload(
  session: string,
  reservePath: string,
  contentPath: (id: string) => string,
  body: Buffer,
) {
  const r = await f.call(session, 'POST', reservePath, {
    clientId: randomUUID(),
    name: 'retained.txt',
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id,
    boundary = 'orbit-' + randomUUID(),
    response = await f.app.inject({
      method: 'PUT',
      url: contentPath(id),
      headers: {
        cookie: 'ao_session=' + session,
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
      payload: Buffer.concat([
        Buffer.from(
          '--' +
            boundary +
            '\r\nContent-Disposition: form-data; name="file"; filename="retained.txt"\r\nContent-Type: text/plain\r\n\r\n',
        ),
        body,
        Buffer.from('\r\n--' + boundary + '--\r\n'),
      ]),
    });
  expect(response.statusCode, response.body).toBe(200);
  return id;
}
it('retains scanned imported binaries, reuses explicit origin mappings on sync, and exports their bytes', async () => {
  const channel = await f.channel('private'),
    body = Buffer.from('Retained migration bytes\n');
  const file = await upload(
    f.owner,
    `/v1/conversations/${channel}/files`,
    (id) => `/v1/files/${id}/content`,
    body,
  );
  const created = await f.call(f.owner, 'POST', '/v1/migrations', {
    clientId: randomUUID(),
    name: 'Files history',
    provider: 'teams',
    sourceWorkspaceId: randomUUID(),
  });
  const base = '/v1/migrations/' + created.json().id;
  const mapped = await f.call(f.owner, 'PUT', base + '/mappings', {
    version: 1,
    channels: [
      {
        sourceId: 'SOURCE',
        conversationId: channel,
        visibility: 'private',
        authorized: true,
        acknowledgeAudienceExpansion: true,
      },
    ],
  });
  expect(mapped.statusCode, mapped.body).toBe(200);
  const record = {
    id: '1',
    channelId: 'SOURCE',
    authorId: 'A',
    authorName: 'Ava',
    timestamp: '2026-10-25T00:00:00Z',
    revision: '2026-10-25T00:00:00Z',
    body: 'File from source',
    files: [{ sourceId: 'FILE', name: 'retained.txt', fileId: file }],
  };
  await f.call(f.owner, 'POST', base + '/batches', {
    clientId: randomUUID(),
    complete: true,
    records: [record],
  });
  await f.call(f.owner, 'POST', base + '/control', { version: 2, action: 'start' });
  let result = await f.call(f.owner, 'POST', base + '/process', {});
  expect(result.statusCode, result.body).toBe(200);
  expect((await f.messages(f.owner, channel))[0]!.attachments).toHaveLength(1);
  await f.call(f.owner, 'POST', base + '/batches', {
    clientId: randomUUID(),
    complete: true,
    records: [
      {
        ...record,
        body: 'Source updated',
        revision: '2026-10-25T01:00:00Z',
        files: [{ sourceId: 'FILE', name: 'retained.txt' }],
      },
    ],
  });
  result = await f.call(f.owner, 'POST', base + '/process', {});
  expect(result.statusCode, result.body).toBe(200);
  expect((await f.messages(f.owner, channel))[0]!.attachments[0]!.id).toBe(file);
  const report = await f.call(f.owner, 'GET', base);
  expect(report.json().hasOmissions).toBe(false);
  const archive = await f.call(f.owner, 'GET', '/v1/workspace-export');
  expect(archive.statusCode, archive.body.slice(0, 300)).toBe(200);
  expect(archive.rawPayload.includes(body)).toBe(true);
});
it('scopes external uploads and downloads to their granted shared channel, including revocation', async () => {
  const channel = await f.channel('private'),
    [org] = await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
      f.otherBoot.workspace.id,
    ]),
    policy = {
      history: 'join_time',
      retentionDays: 30,
      export: true,
      agents: false,
      recording: false,
    };
  const invitation = await f.call(f.owner, 'POST', '/v1/shared-channels/invitations', {
      conversationId: channel,
      organizationId: org!.organization_id,
      policy,
    }),
    grant = invitation.json().id;
  const accept = await f.call(f.other, 'POST', '/v1/shared-channels/accept', {
    token: invitation.json().token,
    policy,
    membershipIds: [f.otherBoot.me.id],
  });
  expect(accept.statusCode, accept.body).toBe(200);
  const body = Buffer.from('External retained file\n'),
    file = await upload(
      f.other,
      `/v1/shared-channels/${grant}/files`,
      (id) => `/v1/shared-channels/${grant}/files/${id}/content`,
      body,
    );
  const sent = await f.call(f.other, 'POST', `/v1/shared-channels/${grant}/messages`, {
    clientId: randomUUID(),
    body: 'Shared attachment',
    attachmentIds: [file],
  });
  expect(sent.statusCode, sent.body).toBe(201);
  const download = await f.call(
    f.other,
    'GET',
    `/v1/shared-channels/${grant}/files/${file}/content`,
  );
  expect(download.statusCode).toBe(200);
  expect(download.rawPayload).toEqual(body);
  const archive = await f.call(f.other, 'GET', `/v1/shared-channels/${grant}/export`);
  expect(archive.statusCode, archive.body.slice(0, 300)).toBe(200);
  expect(archive.rawPayload.includes(body)).toBe(true);
  await f.call(f.owner, 'POST', `/v1/shared-channels/${grant}/revoke`, { version: 2 });
  expect(
    (await f.call(f.other, 'GET', `/v1/shared-channels/${grant}/files/${file}/content`)).statusCode,
  ).toBe(404);
});
