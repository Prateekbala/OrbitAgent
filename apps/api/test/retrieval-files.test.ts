import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { messagingFixture } from './messaging-fixture.js';
import { LocalFileStore } from '../src/files/storage.js';
import { RetrievalWorker } from '../src/retrieval/worker.js';
let f: Awaited<ReturnType<typeof messagingFixture>>, directory: string;
let extracts = 0;
let revoke: (() => Promise<void>) | undefined;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbit-retrieval-files-'));
  f = await messagingFixture(
    {
      store: new LocalFileStore(join(directory, 'objects')),
      scanner: {
        async scan() {
          return 'clean';
        },
      },
      stagingDirectory: join(directory, 'stage'),
    },
    undefined,
    {
      textExtractor: {
        id: 'fixture/ocr',
        async extract() {
          extracts++;
          await revoke?.();
          return 'OcrBrowserEvidence from a scanned image.';
        },
      },
    },
  );
});
afterAll(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});
async function upload(channel: string, data: Buffer, name: string) {
  const reserved = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/files`, {
    name,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    clientId: randomUUID(),
  });
  expect(reserved.statusCode, reserved.body).toBe(201);
  const id = reserved.json().id,
    boundary = 'upload-' + randomUUID();
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await f.app.inject({
    method: 'PUT',
    url: `/v1/files/${id}/content`,
    headers: {
      cookie: 'ao_session=' + f.owner,
      'content-type': 'multipart/form-data; boundary=' + boundary,
    },
    payload,
  });
  expect(response.statusCode, response.body).toBe(200);
  const attached = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/messages`, {
    body: 'Attached evidence',
    clientId: randomUUID(),
    attachmentIds: [id],
  });
  expect(attached.statusCode, attached.body).toBe(201);
  return id as string;
}
describe('authorized file text and OCR extraction', () => {
  it('extracts scanned text, versions re-extraction, and hides stale index bodies before refresh', async () => {
    const channel = await f.channel(),
      id = await upload(
        channel,
        Buffer.from('FileExtractionEvidence in UTF-8 नमस्ते'),
        'evidence.txt',
      );
    const first = await f.call(f.owner, 'POST', `/v1/search/files/${id}/extract`, {});
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().method).toBe('text');
    await new RetrievalWorker(f.db).tick();
    const found = await f.call(f.mate, 'POST', '/v1/search/retrieve', {
      q: 'FileExtractionEvidence',
      kinds: ['file'],
    });
    expect(found.json().items[0].id).toBe(id);
    const context = found.json().contextId;
    expect((await f.call(f.owner, 'POST', `/v1/search/files/${id}/extract`, {})).statusCode).toBe(
      200,
    );
    expect((await f.call(f.mate, 'GET', `/v1/search/contexts/${context}`)).statusCode).toBe(409);
    expect(
      (
        await f.call(f.mate, 'POST', '/v1/search/retrieve', {
          q: 'FileExtractionEvidence',
          kinds: ['file'],
        })
      ).json().items,
    ).toHaveLength(0);
    await new RetrievalWorker(f.db).tick();
    expect(
      (
        await f.call(f.mate, 'POST', '/v1/search/retrieve', {
          q: 'FileExtractionEvidence',
          kinds: ['file'],
        })
      ).json().items[0].version,
    ).toBe(2);
    await f.db.query('UPDATE files SET size=5000000 WHERE id=$1', [id]);
    expect((await f.call(f.owner, 'POST', `/v1/search/files/${id}/extract`, {})).statusCode).toBe(
      413,
    );
  });
  it('checks private access before OCR and refuses to persist inference completed after revocation', async () => {
    const channel = await f.channel('private'),
      png = await sharp({ create: { width: 2, height: 2, channels: 4, background: 'white' } })
        .png()
        .toBuffer(),
      id = await upload(channel, png, 'scanned.png');
    expect((await f.call(f.mate, 'POST', `/v1/search/files/${id}/extract`, {})).statusCode).toBe(
      404,
    );
    expect(extracts).toBe(0);
    await f.call(f.owner, 'POST', `/v1/conversations/${channel}/members`, {
      membershipId: f.mateBoot.me.id,
    });
    revoke = async () => {
      await f.db.query(
        'DELETE FROM conversation_members WHERE conversation_id=$1 AND membership_id=$2',
        [channel, f.mateBoot.me.id],
      );
    };
    try {
      const result = await f.call(f.mate, 'POST', `/v1/search/files/${id}/extract`, {});
      expect(result.statusCode, result.body).toBe(409);
      expect(extracts).toBe(1);
      expect(
        await f.db.query('SELECT body FROM file_extractions WHERE file_id=$1', [id]),
      ).toHaveLength(0);
    } finally {
      revoke = undefined;
    }
  });
});
it('rejects an in-flight OCR result after a DLP policy change and hides indexed file evidence', async () => {
  const channel = await f.channel(),
    text = await upload(channel, Buffer.from('DlpRevocationEvidence private text'), 'dlp.txt');
  expect((await f.call(f.owner, 'POST', `/v1/search/files/${text}/extract`, {})).statusCode).toBe(
    200,
  );
  await new RetrievalWorker(f.db).tick();
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer(),
    id = await upload(channel, image, 'scan.png');
  revoke = async () => {
    const policy = (await f.call(f.owner, 'GET', '/v1/files/policy')).json<
      Record<string, unknown>
    >();
    const r = await f.call(f.owner, 'PUT', '/v1/files/policy', {
      ...policy,
      enabled: true,
      requireInspection: true,
    });
    expect(r.statusCode, r.body).toBe(200);
  };
  try {
    const result = await f.call(f.owner, 'POST', `/v1/search/files/${id}/extract`, {});
    expect(result.statusCode, result.body).toBe(409);
    expect(
      await f.db.query('SELECT file_id FROM file_extractions WHERE file_id=$1', [id]),
    ).toHaveLength(0);
    const search = await f.call(f.owner, 'POST', '/v1/search/retrieve', {
      q: 'DlpRevocationEvidence',
      kinds: ['file'],
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().items).toHaveLength(0);
  } finally {
    revoke = undefined;
  }
});
