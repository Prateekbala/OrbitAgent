import { MessageDeliveryWorker } from '../src/messaging/worker.js';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { scopedDatabase, tenantScope } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { LocalFileStore } from '../src/files/storage.js';
import { FileCleanupWorker } from '../src/files/worker.js';
import type { FileDependencies } from '../src/files/config.js';
let f: Awaited<ReturnType<typeof messagingFixture>>,
  directory: string,
  dependencies: FileDependencies;
let scanning: (
  path: string,
  signal: AbortSignal,
) => Promise<'clean' | 'development_only'> = async () => 'clean';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbit-files-'));
  dependencies = {
    store: new LocalFileStore(join(directory, 'objects')),
    scanner: { scan: (path, signal) => scanning(path, signal) },
    stagingDirectory: join(directory, 'staging'),
  };
  f = await messagingFixture(dependencies);
}, 30000);
afterAll(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});
const checksum = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function multipart(data: Buffer, extra = false) {
  const boundary = 'orbit-' + randomUUID();
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      data,
      Buffer.from(
        extra
          ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="unexpected"\r\n\r\nextra\r\n--${boundary}--\r\n`
          : `\r\n--${boundary}--\r\n`,
      ),
    ]),
  };
}
async function reserve(
  channel: string,
  data: Buffer,
  name = 'notes.txt',
  session = f.owner,
  clientId = randomUUID(),
) {
  return f.call(session, 'POST', `/v1/conversations/${channel}/files`, {
    name,
    size: data.length,
    sha256: checksum(data),
    clientId,
  });
}
async function content(id: string, data: Buffer, session = f.owner, extra = false) {
  const form = multipart(data, extra);
  return f.app.inject({
    method: 'PUT',
    url: `/v1/files/${id}/content`,
    headers: { ...form.headers, cookie: `ao_session=${session}` },
    payload: form.body,
  });
}
async function upload(
  channel: string,
  data = Buffer.from('Project notes'),
  name = 'notes.txt',
  session = f.owner,
) {
  const reserved = await reserve(channel, data, name, session);
  expect(reserved.statusCode, reserved.body).toBe(201);
  const id = reserved.json().id;
  const response = await content(id, data, session);
  expect(response.statusCode, response.body).toBe(200);
  return id as string;
}
async function attach(
  channel: string,
  ids: string[],
  body = '',
  session = f.owner,
  threadId?: string,
  clientId = randomUUID(),
) {
  return f.call(session, 'POST', `/v1/conversations/${channel}/messages`, {
    body,
    clientId,
    attachmentIds: ids,
    ...(threadId ? { threadId } : {}),
  });
}
describe('private file attachments', () => {
  it('uploads, scans and attaches files to messages and threads with immutable request deduplication', async () => {
    const channel = await f.channel(),
      data = Buffer.from('A private design decision');
    const file = await upload(channel, data),
      clientId = randomUUID();
    expect((await f.call(f.mate, 'GET', `/v1/files/${file}/content`)).statusCode).toBe(404);
    const sent = await attach(channel, [file], '', f.owner, undefined, clientId);
    expect(sent.statusCode, sent.body).toBe(201);
    const message = sent.json().id;
    expect((await f.messages(f.mate, channel))[0]).toMatchObject({
      body: '',
      attachments: [{ id: file, name: 'notes.txt', size: data.length }],
    });
    const download = await f.call(f.mate, 'GET', `/v1/files/${file}/content`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(data);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect((await attach(channel, [file], '', f.owner, undefined, clientId)).statusCode).toBe(200);
    expect((await attach(channel, [], 'Changed', f.owner, undefined, clientId)).statusCode).toBe(
      409,
    );
    const replyFile = await upload(channel, Buffer.from('Thread appendix'));
    expect((await attach(channel, [replyFile], '', f.owner, message)).statusCode).toBe(201);
    expect((await f.messages(f.mate, channel, message))[0]?.attachments[0]?.id).toBe(replyFile);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/messages/${message}`, {
          version: 1,
          body: 'New caption',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/messages/${message}`, { version: 2, body: '' }))
        .statusCode,
    ).toBe(200);
  });
  it('checks tenant, conversation, uploader and readiness on every attachment binding', async () => {
    const a = await f.channel(),
      b = await f.channel(),
      file = await upload(a);
    expect((await attach(b, [file])).statusCode).toBe(400);
    expect((await attach(a, [file], '', f.mate)).statusCode).toBe(400);
    expect((await attach(a, [file], '', f.other)).statusCode).toBe(404);
    expect((await f.call(f.other, 'GET', `/v1/files/${file}`)).statusCode).toBe(404);
    const pending = (await reserve(a, Buffer.from('Waiting'))).json().id;
    expect((await attach(a, [pending])).statusCode).toBe(400);
    expect((await f.call(f.owner, 'GET', `/v1/files/${pending}/content`)).statusCode).toBe(409);
    expect((await attach(a, [file, file])).statusCode).toBe(400);
    expect((await attach(a, [file])).statusCode).toBe(201);
    expect((await attach(a, [file])).statusCode).toBe(400);
    const scoped = scopedDatabase(f.db);
    expect(
      await tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query('SELECT id FROM files WHERE id=$1', [file]),
      ),
    ).toEqual([]);
    await expect(
      tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query(
          "INSERT INTO files(id,workspace_id,conversation_id,uploader_id,client_id,name,size,sha256,storage_provider,object_key,reserved_bytes) VALUES($1,$2,$3,$4,$5,'invalid',1,$6,'local',$7,1)",
          [
            randomUUID(),
            f.otherBoot.workspace.id,
            a,
            f.otherBoot.me.id,
            randomUUID(),
            checksum(Buffer.from('a')),
            randomUUID(),
          ],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });
  it('deduplicates upload reservations and enforces checksums, sizes, filenames and multipart limits', async () => {
    const channel = await f.channel(),
      data = Buffer.from('Expected'),
      clientId = randomUUID();
    const first = await reserve(channel, data, 'notes.txt', f.owner, clientId),
      second = await reserve(channel, data, 'notes.txt', f.owner, clientId);
    expect(second.json().id).toBe(first.json().id);
    expect(
      (await reserve(channel, Buffer.from('Different'), 'notes.txt', f.owner, clientId)).statusCode,
    ).toBe(409);
    expect((await content(first.json().id, Buffer.from('Tampered'))).statusCode).toBe(400);
    expect((await f.call(f.owner, 'GET', `/v1/files/${first.json().id}/content`)).statusCode).toBe(
      409,
    );
    const tooBig = (await reserve(channel, data)).json().id;
    expect((await content(tooBig, Buffer.alloc(100))).statusCode).toBe(413);
    const extra = (await reserve(channel, data)).json().id;
    expect((await content(extra, data, f.owner, true)).statusCode).toBe(413);
    for (const name of ['../secret', 'bad\\name', 'unsafe\nname'])
      expect((await reserve(channel, data, name)).statusCode).toBe(400);
    const invalid = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/files`, {
      name: 'huge.bin',
      size: 26214401,
      sha256: checksum(data),
      clientId: randomUUID(),
    });
    expect(invalid.statusCode).toBe(400);
    expect((await readdir(dependencies.stagingDirectory)).length).toBe(0);
  });
  it('fails closed when scanning is unavailable and quarantines malicious content', async () => {
    const channel = await f.channel(),
      data = Buffer.from('Test content');
    for (const reason of ['Offline', 'FILE_INFECTED']) {
      scanning = async () => {
        throw new Error(reason);
      };
      const file = (await reserve(channel, data)).json().id;
      expect((await content(file, data)).statusCode).toBe(422);
      expect((await attach(channel, [file])).statusCode).toBe(400);
      expect((await f.call(f.owner, 'GET', `/v1/files/${file}/content`)).statusCode).toBe(409);
    }
    scanning = async () => 'clean';
  });
  it('generates safe image previews and never serves user HTML or SVG inline', async () => {
    const channel = await f.channel(),
      png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#245a32' } })
        .png()
        .toBuffer();
    const image = await upload(channel, png, 'photo.svg');
    expect((await f.call(f.owner, 'GET', `/v1/files/${image}`)).json()).toMatchObject({
      content_type: 'image/png',
      has_preview: true,
    });
    const preview = await f.call(f.owner, 'GET', `/v1/files/${image}/preview`);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');
    expect((await sharp(preview.rawPayload).metadata()).format).toBe('png');
    const svg = await upload(
      channel,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'untrusted.svg',
    );
    expect((await f.call(f.owner, 'GET', `/v1/files/${svg}/preview`)).statusCode).toBe(404);
    expect(
      (await f.call(f.owner, 'GET', `/v1/files/${svg}/content`)).headers['content-disposition'],
    ).toContain('attachment;');
  });
  it('revokes file downloads and in-flight uploads when a participant leaves', async () => {
    const group = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
        title: 'Private files',
        membershipIds: [f.mateBoot.me.id],
      }),
      channel = group.json().id;
    const file = await upload(channel);
    await attach(channel, [file]);
    let release!: () => void, started!: () => void;
    const scanningStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    scanning = async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'clean';
    };
    const data = Buffer.from('Upload during removal'),
      pending = (await reserve(channel, data, 'pending.txt', f.mate)).json().id;
    const uploading = content(pending, data, f.mate);
    await scanningStarted;
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/conversations/${channel}`, {
          version: 1,
          member: { membershipId: f.mateBoot.me.id, action: 'remove' },
        })
      ).statusCode,
    ).toBe(200);
    release();
    expect((await uploading).statusCode).toBe(404);
    scanning = async () => 'clean';
    expect((await f.call(f.mate, 'GET', `/v1/files/${file}/content`)).statusCode).toBe(404);
    expect((await f.call(f.owner, 'GET', `/v1/files/${file}/content`)).statusCode).toBe(200);
    expect((await f.call(f.mate, 'GET', `/v1/files/${pending}`)).statusCode).toBe(404);
  });
  it('reserves quota atomically, tombstones downloads immediately, and cleans up without releasing quota twice', async () => {
    const channel = await f.channel(),
      data = Buffer.from('Quota content');
    await f.db.query('UPDATE workspaces SET storage_limit_bytes=storage_bytes+$2 WHERE id=$1', [
      f.ownerBoot.workspace.id,
      data.length + 512 * 1024 - 1,
    ]);
    expect((await reserve(channel, data)).json().error.code).toBe('STORAGE_QUOTA');
    await f.db.query('UPDATE workspaces SET storage_limit_bytes=5368709120 WHERE id=$1', [
      f.ownerBoot.workspace.id,
    ]);
    const file = await upload(channel, data),
      sent = await attach(channel, [file]);
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/messages/${sent.json().id}`, { version: 1 }))
        .statusCode,
    ).toBe(200);
    expect((await f.call(f.owner, 'GET', `/v1/files/${file}/content`)).statusCode).toBe(404);
    expect((await f.messages(f.owner, channel))[0]?.attachments).toEqual([]);
    await f.db.query(
      "UPDATE files SET cleanup_after=now()-interval '1 minute',lease_expires_at=NULL WHERE id=$1",
      [file],
    );
    const before = Number(
      (
        await f.db.query('SELECT storage_bytes FROM workspaces WHERE id=$1', [
          f.ownerBoot.workspace.id,
        ])
      )[0]!.storage_bytes,
    );
    const worker = new FileCleanupWorker(f.db, dependencies.store);
    await worker.tick();
    const used = () =>
      f.db
        .query('SELECT storage_bytes FROM workspaces WHERE id=$1', [f.ownerBoot.workspace.id])
        .then((rows) => Number(rows[0]!.storage_bytes));
    expect(await used()).toBe(before - data.length);
    expect(
      (await f.db.query('SELECT status,reserved_bytes FROM files WHERE id=$1', [file]))[0],
    ).toMatchObject({ status: 'deleted', reserved_bytes: expect.anything() });
    await f.db.query("UPDATE files SET cleanup_after=now()-interval '1 minute' WHERE id=$1", [
      file,
    ]);
    await worker.tick();
    expect(await used()).toBe(before - data.length);
    await expect(
      dependencies.store.get(`${f.ownerBoot.workspace.id}/${file}/original`),
    ).rejects.toThrow();
  });
  it('keeps content non-empty at the database boundary', async () => {
    const channel = await f.channel();
    await expect(
      f.db.transaction((tx) =>
        tx.query(
          "INSERT INTO messages(id,workspace_id,conversation_id,author_id,body,client_id,sequence) VALUES($1,$2,$3,$4,'',$5,1)",
          [randomUUID(), f.ownerBoot.workspace.id, channel, f.ownerBoot.me.id, randomUUID()],
        ),
      ),
    ).rejects.toThrow(/requires text or an attachment/);
  });
});

it('keeps files behind the message history floor after a participant rejoins a private group', async () => {
  const response = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
    title: 'History protected files',
    membershipIds: [f.mateBoot.me.id],
  });
  expect(response.statusCode, response.body).toBe(201);
  const group = response.json().id;
  const file = await upload(group, Buffer.from('Older history attachment'), 'history.txt');
  expect((await attach(group, [file])).statusCode).toBe(201);
  expect((await f.call(f.mate, 'GET', `/v1/files/${file}`)).statusCode).toBe(200);
  expect(
    (
      await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
        version: 1,
        member: { membershipId: f.mateBoot.me.id, action: 'remove' },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
        version: 2,
        member: { membershipId: f.mateBoot.me.id, action: 'add' },
      })
    ).statusCode,
  ).toBe(200);
  expect((await f.call(f.mate, 'GET', `/v1/files/${file}`)).statusCode).toBe(404);
  expect((await f.call(f.mate, 'GET', `/v1/files/${file}/content`)).statusCode).toBe(404);
  const fresh = await upload(group, Buffer.from('New history attachment'), 'fresh-history.txt');
  expect((await attach(group, [fresh])).statusCode).toBe(201);
  expect((await f.call(f.mate, 'GET', `/v1/files/${fresh}`)).statusCode).toBe(200);
});
it('reserves scheduled attachments, prevents reuse, releases long holds on cancellation, and attaches once on delivery', async () => {
  const channel = f.ownerBoot.channels[0]!.id,
    file = await upload(channel, Buffer.from('Scheduled attachment bytes'), 'schedule.txt'),
    input = {
      body: 'Scheduled with file',
      clientId: randomUUID(),
      attachmentIds: [file],
      sendAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    };
  const scheduled = await f.call(
    f.owner,
    'POST',
    `/v1/conversations/${channel}/scheduled-messages`,
    input,
  );
  expect(scheduled.statusCode, scheduled.body).toBe(201);
  expect((await attach(channel, [file])).statusCode).toBe(400);
  expect(
    (
      await f.call(f.owner, 'POST', `/v1/conversations/${channel}/scheduled-messages`, {
        ...input,
        clientId: randomUUID(),
      })
    ).statusCode,
  ).toBe(409);
  const [held] = await f.db.query(
    "SELECT expires_at>now()+interval '2 days' held FROM files WHERE id=$1",
    [file],
  );
  expect(held?.held).toBe(true);
  await f.call(f.owner, 'PATCH', `/v1/scheduled-messages/${scheduled.json().id}`, {
    version: 1,
    cancel: true,
  });
  const [released] = await f.db.query(
    "SELECT expires_at<=now()+interval '1 day' released FROM files WHERE id=$1",
    [file],
  );
  expect(released?.released).toBe(true);
  const next = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/scheduled-messages`, {
    ...input,
    clientId: randomUUID(),
  });
  expect(next.statusCode, next.body).toBe(201);
  await f.db.query('UPDATE scheduled_messages SET send_at=now() WHERE id=$1', [next.json().id]);
  await new MessageDeliveryWorker(f.db).tick();
  await new MessageDeliveryWorker(f.db).tick();
  expect((await f.call(f.owner, 'GET', `/v1/files/${file}`)).json().status).toBe('attached');
  expect(
    await f.db.query('SELECT * FROM message_attachments WHERE file_id=$1', [file]),
  ).toHaveLength(1);
});
