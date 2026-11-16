import { it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudinaryFileStore } from '../src/files/cloudinary.js';
import { configuredFiles, type FileDependencies } from '../src/files/config.js';
import { messagingFixture } from './messaging-fixture.js';

const config = {
  cloudName: 'orbit-test',
  apiKey: '123456789',
  apiSecret: 'synthetic-secret-for-local-tests',
  folder: 'orbit-test/files',
};
const workspace = randomUUID();
const key = `${workspace}/${randomUUID()}/original`;
const bytes = Buffer.from('Private Cloudinary attachment');
const json = (value: unknown) => Response.json(value);
async function collect(stream: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
function provider() {
  const objects = new Map<string, Buffer>();
  const requests: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    requests.push(url);
    expect(url.origin).toBe('https://api.cloudinary.com');
    expect(options?.redirect).toBe('error');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    if (url.pathname.endsWith('/resources/raw/authenticated')) {
      expect(new Headers(options?.headers).get('authorization')).toBe(
        'Basic ' + Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64'),
      );
      return json({
        resources: [...objects.keys()]
          .filter((id) => id.startsWith(url.searchParams.get('prefix')!))
          .slice(0, 100)
          .map((public_id) => ({ public_id })),
      });
    }
    const fields =
      options?.body instanceof FormData
        ? options.body
        : options?.body instanceof URLSearchParams
          ? options.body
          : url.searchParams;
    const parameters = Object.fromEntries(
      [...fields.entries()].filter(([name]) => !['file', 'signature', 'api_key'].includes(name)),
    );
    const canonical = Object.keys(parameters)
      .sort()
      .map((name) => `${name}=${parameters[name]}`)
      .join('&');
    expect(fields.get('signature')).toBe(
      createHash('sha256')
        .update(canonical + config.apiSecret)
        .digest('hex'),
    );
    expect(fields.get('api_key')).toBe(config.apiKey);
    expect(fields.get('type')).toBe('authenticated');
    expect(fields.has('api_secret')).toBe(false);
    const publicId = String(fields.get('public_id'));
    if (url.pathname.endsWith('/raw/upload')) {
      expect(fields.get('backup')).toBe('false');
      expect(fields.get('overwrite')).toBe('true');
      expect(fields.get('invalidate')).toBe('true');
      const file = fields.get('file') as File;
      objects.set(publicId, Buffer.from(await file.arrayBuffer()));
      return json({
        public_id: publicId,
        resource_type: 'raw',
        type: 'authenticated',
        bytes: file.size,
      });
    }
    if (url.pathname.endsWith('/raw/download')) {
      expect(Number(fields.get('expires_at'))).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(Number(fields.get('expires_at'))).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000) + 60,
      );
      const data = objects.get(publicId);
      return data ? new Response(new Uint8Array(data)) : new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith('/raw/destroy')) {
      expect(fields.get('invalidate')).toBe('true');
      return json({ result: objects.delete(publicId) ? 'ok' : 'not found' });
    }
    throw new Error('Unexpected provider request.');
  });
  return { objects, requests, fetcher, store: new CloudinaryFileStore(config, fetcher) };
}

it('stores only authenticated originals and proxies expiring downloads and ranges', async () => {
  const p = provider();
  const directory = await mkdtemp(join(tmpdir(), 'orbit-cloudinary-'));
  try {
    const path = join(directory, 'original');
    await writeFile(path, bytes);
    await p.store.put(key, path, AbortSignal.timeout(2000));
    await p.store.put(key, path, AbortSignal.timeout(2000));
    expect(p.objects.size).toBe(1);
    expect(await collect(await p.store.get(key))).toEqual(bytes);
    expect(await collect(await p.store.get(key, { start: 3, end: 8 }))).toEqual(
      bytes.subarray(3, 9),
    );
    await p.store.delete(key);
    await p.store.delete(key);
    await expect(p.store.get(key)).rejects.toThrow('Cloudinary storage request failed');
    expect(p.requests.every((url) => !url.href.includes(config.apiSecret))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('preserves application access checks with a Cloudinary-backed attachment', async () => {
  const p = provider();
  const directory = await mkdtemp(join(tmpdir(), 'orbit-cloudinary-api-'));
  const f = await messagingFixture({
    store: p.store,
    scanner: { scan: async () => 'clean' },
    stagingDirectory: directory,
  });
  try {
    const channel = await f.channel();
    const reserved = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/files`, {
      name: 'private.txt',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      clientId: randomUUID(),
    });
    expect(reserved.statusCode, reserved.body).toBe(201);
    const id = reserved.json().id;
    const boundary = 'orbit-' + randomUUID();
    const result = await f.app.inject({
      method: 'PUT',
      url: `/v1/files/${id}/content`,
      headers: {
        cookie: `ao_session=${f.owner}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(result.statusCode, result.body).toBe(200);
    expect((await f.call(f.owner, 'GET', `/v1/files/${id}/content`)).rawPayload).toEqual(bytes);
    const requests = p.requests.length;
    expect((await f.call(f.other, 'GET', `/v1/files/${id}/content`)).statusCode).toBe(404);
    expect(p.requests.length).toBe(requests);
    expect(result.body).not.toContain('cloudinary.com');
    expect(result.body).not.toContain(config.apiSecret);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('purges only the selected workspace namespace and renews the erasure lease', async () => {
  const p = provider();
  const foreign = `${config.folder}/${randomUUID()}/other/original`;
  p.objects.set(`${config.folder}/${key}`, bytes);
  p.objects.set(`${config.folder}/${workspace}/orphan/chunks/0`, bytes);
  p.objects.set(foreign, bytes);
  const heartbeat = vi.fn(async () => {});
  await p.store.purgeWorkspace(workspace, heartbeat);
  expect([...p.objects.keys()]).toEqual([foreign]);
  expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(4);
  const poisoned = vi.fn<typeof fetch>(async () => json({ resources: [{ public_id: foreign }] }));
  await expect(
    new CloudinaryFileStore(config, poisoned).purgeWorkspace(workspace, heartbeat),
  ).rejects.toThrow('foreign workspace');
  expect(poisoned).toHaveBeenCalledTimes(1);
});

it('rejects unsafe configuration and keys before contacting the provider', async () => {
  expect(() => new CloudinaryFileStore({ ...config, cloudName: 'cloud/../../foreign' })).toThrow(
    'configuration',
  );
  expect(() => new CloudinaryFileStore({ ...config, folder: '../outside' })).toThrow(
    'configuration',
  );
  const p = provider();
  for (const invalid of [
    '../escape',
    `${workspace}/../escape`,
    `${workspace}//original`,
    'https://foreign.example/file',
  ]) {
    await expect(p.store.get(invalid)).rejects.toThrow('storage key');
    await expect(p.store.delete(invalid)).rejects.toThrow('storage key');
  }
  await expect(p.store.purgeWorkspace('invalid', async () => {})).rejects.toThrow('storage key');
  await expect(p.store.put(key, '/unread-path', AbortSignal.abort())).rejects.toThrow();
  expect(p.fetcher).not.toHaveBeenCalled();
});

it('fails closed on public uploads, uncertain deletion, provider errors and truncated ranges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-cloudinary-errors-'));
  try {
    const path = join(directory, 'original');
    await writeFile(path, bytes);
    const publicUpload = new CloudinaryFileStore(config, async () =>
      json({
        public_id: `${config.folder}/${key}`,
        resource_type: 'raw',
        type: 'upload',
        bytes: bytes.length,
      }),
    );
    await expect(publicUpload.put(key, path, AbortSignal.timeout(2000))).rejects.toThrow(
      'private upload',
    );
    const failed = new CloudinaryFileStore(config, async () => {
      throw new Error(config.apiSecret);
    });
    await expect(failed.get(key)).rejects.toThrow(/^Cloudinary storage request failed\.$/);
    const uncertain = new CloudinaryFileStore(config, async () => json({ result: 'pending' }));
    await expect(uncertain.delete(key)).rejects.toThrow('confirm deletion');
    const short = new CloudinaryFileStore(config, async () => new Response('abc'));
    await expect(collect(await short.get(key, { start: 10, end: 20 }))).rejects.toThrow(
      'incomplete byte range',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('configures Cloudinary without S3 credentials and can start without a scanner', async () => {
  const env = {
    NODE_ENV: 'production',
    FILE_STORAGE_PROVIDER: 'cloudinary',
    CLAMAV_HOST: 'scanner.internal',
    CLOUDINARY_CLOUD_NAME: config.cloudName,
    CLOUDINARY_API_KEY: config.apiKey,
    CLOUDINARY_API_SECRET: config.apiSecret,
  };
  expect(configuredFiles(env, tmpdir()).store.id).toBe('cloudinary');
  expect(() => configuredFiles({ ...env, CLOUDINARY_API_SECRET: '' }, tmpdir())).toThrow(
    'configuration',
  );
  const disabled = configuredFiles({ ...env, CLAMAV_HOST: '' }, tmpdir());
  expect(disabled.store.id).toBe('cloudinary');
  expect(disabled.scanner.available).toBe(false);
  await expect(disabled.scanner.scan('/unused', AbortSignal.timeout(1000))).rejects.toMatchObject({
    status: 503,
    code: 'FILE_UPLOADS_UNAVAILABLE',
  });
});

it('rejects new and pending uploads before storage writes when the production scanner is absent', async () => {
  const p = provider();
  const disabled = configuredFiles(
    {
      NODE_ENV: 'production',
      FILE_STORAGE_PROVIDER: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: config.cloudName,
      CLOUDINARY_API_KEY: config.apiKey,
      CLOUDINARY_API_SECRET: config.apiSecret,
    },
    tmpdir(),
  ).scanner;
  const dependencies: FileDependencies = {
    store: p.store,
    scanner: { scan: async () => 'clean' },
    stagingDirectory: tmpdir(),
  };
  const f = await messagingFixture(dependencies);
  try {
    const channel = await f.channel();
    const input = {
      name: 'pending.txt',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      clientId: randomUUID(),
    };
    const pending = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/files`, input);
    expect(pending.statusCode).toBe(201);
    const id = pending.json().id;
    dependencies.scanner = disabled;
    const reserved = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/files`, {
      ...input,
      clientId: randomUUID(),
    });
    expect(reserved.statusCode).toBe(503);
    expect(reserved.json().error.code).toBe('FILE_UPLOADS_UNAVAILABLE');
    const boundary = 'orbit-' + randomUUID();
    const upload = await f.app.inject({
      method: 'PUT',
      url: `/v1/files/${id}/content`,
      headers: {
        cookie: `ao_session=${f.owner}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pending.txt"\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(upload.statusCode).toBe(503);
    const chunk = await f.app.inject({
      method: 'PATCH',
      url: `/v1/files/${id}/upload`,
      headers: {
        cookie: `ao_session=${f.owner}`,
        'content-type': 'application/offset+octet-stream',
        'upload-offset': '0',
        'upload-checksum': input.sha256,
      },
      payload: bytes,
    });
    expect(chunk.statusCode).toBe(503);
    const completed = await f.call(f.owner, 'POST', `/v1/files/${id}/upload/complete`);
    expect(completed.statusCode).toBe(503);
    expect(await f.db.query('SELECT id,status FROM files')).toEqual([{ id, status: 'pending' }]);
    expect(p.objects.size).toBe(0);
    expect(p.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});
