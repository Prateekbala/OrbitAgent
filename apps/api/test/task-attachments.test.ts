import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopedDatabase, tenantScope } from '@ao/database';
import type { TaskAttachmentPage, TaskDetails } from '@ao/contracts';
import { messagingFixture } from './messaging-fixture.js';
import { LocalFileStore } from '../src/files/storage.js';
import { FileCleanupWorker } from '../src/files/worker.js';
let f: Awaited<ReturnType<typeof messagingFixture>>, directory: string, store: LocalFileStore;
let scan: () => Promise<'clean'> = async () => 'clean';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbit-task-files-'));
  store = new LocalFileStore(join(directory, 'objects'));
  f = await messagingFixture({
    store,
    scanner: { scan: () => scan() },
    stagingDirectory: join(directory, 'staging'),
  });
});
afterAll(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});
async function create(input: Record<string, unknown> = {}) {
  const r = await f.call(f.owner, 'POST', '/v1/tasks', { title: 'Task with files', ...input });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
}
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function reserve(
  task: string,
  bytes = Buffer.from('Task evidence'),
  session = f.owner,
  clientId = randomUUID(),
) {
  return f.call(session, 'POST', `/v1/tasks/${task}/files`, {
    clientId,
    name: 'evidence.txt',
    size: bytes.length,
    sha256: checksum(bytes),
  });
}
function upload(id: string, bytes = Buffer.from('Task evidence'), session = f.owner) {
  const boundary = 'task-' + randomUUID();
  return f.app.inject({
    method: 'PUT',
    url: `/v1/files/${id}/content`,
    headers: {
      cookie: `ao_session=${session}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
async function ready(task: string, session = f.owner) {
  const r = await reserve(task, undefined, session);
  expect(r.statusCode, r.body).toBe(201);
  const file = r.json<{ id: string }>().id;
  const uploaded = await upload(file, undefined, session);
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  return file;
}
const attach = (task: string, files: string[], session = f.owner) =>
  f.call(session, 'POST', `/v1/tasks/${task}/attachments`, { fileIds: files });
const download = (file: string, session = f.owner) =>
  f.call(session, 'GET', `/v1/files/${file}/content`);
describe('private task attachments', () => {
  it('uploads workspace-only files, attaches atomically, exposes safe downloads, and deduplicates retries', async () => {
    const id = await create(),
      file = await ready(id);
    expect((await download(file, f.mate)).statusCode).toBe(404);
    expect((await attach(id, [file])).json()).toMatchObject({ ok: true, replayed: false });
    expect((await attach(id, [file])).json().replayed).toBe(true);
    const list = (
      await f.call(f.mate, 'GET', `/v1/tasks/${id}/attachments`)
    ).json<TaskAttachmentPage>();
    expect(list.items[0]).toMatchObject({
      id: file,
      name: 'evidence.txt',
      attached_by: f.ownerBoot.me.id,
      version: 1,
    });
    const response = await download(file, f.mate);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toBe('Task evidence');
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect((await download(file, f.other)).statusCode).toBe(404);
    expect(
      (await f.call(f.owner, 'GET', `/v1/tasks/${id}`)).json<TaskDetails>().task.attachment_count,
    ).toBe(1);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM audit_events WHERE resource_id=$1 AND action='task.attachment_added'",
          [id],
        )
      )[0]?.n,
    ).toBe(1);
  });
  it('prevents cross-task, conversation-file and cross-tenant reuse without partial attachment', async () => {
    const conversation = await f.channel(),
      a = await create({ conversationId: conversation }),
      b = await create({ conversationId: conversation });
    const first = await ready(a),
      second = await ready(b);
    expect((await attach(a, [first, second])).statusCode).toBe(400);
    expect(
      (await f.call(f.owner, 'GET', `/v1/tasks/${a}/attachments`)).json<TaskAttachmentPage>().items,
    ).toHaveLength(0);
    expect((await f.send(f.owner, conversation, 'Cannot reuse task file')).statusCode).toBe(201);
    const message = await f.call(f.owner, 'POST', `/v1/conversations/${conversation}/messages`, {
      body: 'Task file reuse',
      clientId: randomUUID(),
      attachmentIds: [first],
    });
    expect(message.statusCode, message.body).toBe(400);
    const other = await f.call(f.owner, 'POST', `/v1/conversations/${conversation}/files`, {
      clientId: randomUUID(),
      name: 'evidence.txt',
      size: 13,
      sha256: checksum(Buffer.from('Task evidence')),
    });
    expect(other.statusCode, other.body).toBe(201);
    expect((await upload(other.json().id)).statusCode).toBe(200);
    expect((await attach(a, [other.json().id])).statusCode).toBe(400);
    expect((await attach(a, [first], f.other)).statusCode).toBe(404);
  });
  it('checks managers, uploader identity and current conversation access', async () => {
    const id = await create({ assigneeId: f.mateBoot.me.id });
    const file = await ready(id, f.mate);
    expect((await attach(id, [file], f.owner)).statusCode).toBe(400);
    expect((await attach(id, [file], f.mate)).statusCode).toBe(200);
    const readerTask = await create();
    expect((await reserve(readerTask, undefined, f.mate)).statusCode).toBe(403);
    const group = (
      await f.call(f.owner, 'POST', '/v1/conversations/groups', {
        title: 'Task file privacy',
        membershipIds: [f.mateBoot.me.id],
      })
    ).json<{ id: string }>().id;
    const privateTask = await create({ conversationId: group, assigneeId: f.mateBoot.me.id }),
      privateFile = await ready(privateTask);
    await attach(privateTask, [privateFile]);
    expect((await download(privateFile, f.mate)).statusCode).toBe(200);
    await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
      version: 1,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    expect((await download(privateFile, f.mate)).statusCode).toBe(404);
    expect((await f.call(f.mate, 'GET', `/v1/tasks/${privateTask}/attachments`)).statusCode).toBe(
      404,
    );
  });
  it('rechecks management at upload finalization after an assignment changes', async () => {
    const id = await create({ assigneeId: f.mateBoot.me.id }),
      reserved = await reserve(id, undefined, f.mate),
      file = reserved.json<{ id: string }>().id;
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    scan = async () => {
      entered();
      await waiting;
      return 'clean';
    };
    const pending = upload(file, undefined, f.mate);
    await started;
    try {
      expect(
        (
          await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, {
            version: 1,
            assigneeId: f.ownerBoot.me.id,
          })
        ).statusCode,
      ).toBe(200);
      release();
      const result = await pending;
      expect(result.statusCode, result.body).toBe(403);
    } finally {
      release();
      scan = async () => 'clean';
    }
    expect((await attach(id, [file], f.mate)).statusCode).toBe(403);
  });
  it('soft-removes files immediately, version-checks removal and releases quota through cleanup', async () => {
    const id = await create(),
      file = await ready(id);
    await attach(id, [file]);
    expect(
      (await f.call(f.mate, 'DELETE', `/v1/tasks/${id}/attachments/${file}`, { version: 1 }))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/tasks/${id}/attachments/${file}`, { version: 2 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/tasks/${id}/attachments/${file}`, { version: 1 }))
        .statusCode,
    ).toBe(200);
    expect((await download(file)).statusCode).toBe(404);
    expect((await attach(id, [file])).statusCode).toBe(410);
    expect(
      (
        await f.call(f.owner, 'DELETE', `/v1/tasks/${id}/attachments/${file}`, { version: 1 })
      ).json().replayed,
    ).toBe(true);
    const [before] = await f.db.query('SELECT storage_bytes FROM workspaces WHERE id=$1', [
      f.ownerBoot.workspace.id,
    ]);
    await f.db.query("UPDATE files SET cleanup_after=now()-interval '1 minute' WHERE id=$1", [
      file,
    ]);
    const errors: unknown[] = [];
    await new FileCleanupWorker(f.db, store, (e) => errors.push(e)).tick();
    expect(errors).toEqual([]);
    const [after] = await f.db.query('SELECT storage_bytes FROM workspaces WHERE id=$1', [
      f.ownerBoot.workspace.id,
    ]);
    expect(BigInt(String(after!.storage_bytes))).toBeLessThan(
      BigInt(String(before!.storage_bytes)),
    );
    const [purged] = await f.db.query('SELECT status,reserved_bytes FROM files WHERE id=$1', [
      file,
    ]);
    expect(purged?.status).toBe('deleted');
    expect(String(purged?.reserved_bytes)).toBe('0');
  });
  it('rejects reservation identity reuse across tasks and enforces forced RLS and immutable sources', async () => {
    const a = await create(),
      b = await create(),
      client = randomUUID(),
      first = await reserve(a, undefined, f.owner, client);
    expect((await reserve(a, undefined, f.owner, client)).json().id).toBe(first.json().id);
    expect((await reserve(b, undefined, f.owner, client)).statusCode).toBe(409);
    const file = await ready(a);
    await attach(a, [file]);
    const scoped = scopedDatabase(f.db);
    expect(
      await tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query('SELECT * FROM task_attachments'),
      ),
    ).toEqual([]);
    await expect(
      f.db.query('UPDATE files SET task_id=$2 WHERE id=$1', [file, b]),
    ).rejects.toThrow();
    await expect(
      tenantScope(f.ownerBoot.workspace.id, () =>
        scoped.query('DELETE FROM task_attachments WHERE file_id=$1', [file]),
      ),
    ).rejects.toThrow();
    await expect(
      tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query(
          'INSERT INTO task_attachments(workspace_id,task_id,file_id,attached_by) VALUES($1,$2,$3,$4)',
          [f.otherBoot.workspace.id, a, file, f.otherBoot.me.id],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('attachment limits and pagination', () => {
  it('caps active files at 100 and pages every attachment without dropping identities', async () => {
    const id = await create();
    const ids = Array.from({ length: 101 }, () => randomUUID());
    for (const file of ids)
      await f.db.query(
        `INSERT INTO files(id,workspace_id,task_id,uploader_id,client_id,name,size,sha256,storage_provider,object_key,reserved_bytes,status,scan_status) VALUES($1,$2,$3,$4,$5,'bounded.txt',1,$6,'local',$7,1,'ready','clean')`,
        [
          file,
          f.ownerBoot.workspace.id,
          id,
          f.ownerBoot.me.id,
          randomUUID(),
          checksum(Buffer.from('x')),
          `${f.ownerBoot.workspace.id}/${file}/original`,
        ],
      );
    await f.db.query('UPDATE workspaces SET storage_bytes=storage_bytes+101 WHERE id=$1', [
      f.ownerBoot.workspace.id,
    ]);
    for (let n = 0; n < 100; n += 10)
      expect((await attach(id, ids.slice(n, n + 10))).statusCode).toBe(200);
    expect((await attach(id, [ids[100]!])).json().error.code).toBe('ATTACHMENT_LIMIT');
    expect((await attach(id, ids.slice(0, 11))).statusCode).toBe(400);
    const seen = new Set<string>();
    let after: string | null = null;
    for (let n = 0; n < 5; n++) {
      const response = await f.call(
        f.owner,
        'GET',
        `/v1/tasks/${id}/attachments?limit=20${after ? `&after=${after}` : ''}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json<TaskAttachmentPage>();
      for (const file of page.items) {
        expect(seen.has(file.id)).toBe(false);
        seen.add(file.id);
      }
      after = page.next_after;
    }
    expect(after).toBeNull();
    expect(seen.size).toBe(100);
  });
});
