import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { S3Client } from '@aws-sdk/client-s3';
import { ClamAvScanner } from '../src/files/scanner.js';
import { S3FileStore } from '../src/files/storage.js';
import { configuredFiles } from '../src/files/config.js';
describe('file transport contracts', () => {
  it('requires private object storage and a scanner in production', () => {
    expect(() => configuredFiles({ NODE_ENV: 'production' }, tmpdir())).toThrow(/CLAMAV_HOST/);
    expect(() =>
      configuredFiles(
        { NODE_ENV: 'production', FILE_STORAGE_PROVIDER: 'local', CLAMAV_HOST: 'scanner' },
        tmpdir(),
      ),
    ).toThrow();
    expect(() =>
      configuredFiles({ NODE_ENV: 'production', CLAMAV_HOST: 'scanner' }, tmpdir()),
    ).toThrow(/S3_BUCKET/);
    expect(configuredFiles({ NODE_ENV: 'development' }, tmpdir()).store.id).toBe('local');
  });
  it('speaks the ClamAV INSTREAM protocol and fails closed on infected, invalid and disconnected responses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbit-scan-')),
      path = join(directory, 'file');
    const original = Buffer.from('Scan this content');
    await writeFile(path, original);
    let reply = 'stream: OK\0';
    const uploaded: Buffer[] = [];
    const server = createServer((socket) => {
      let pending = Buffer.alloc(0),
        command = false;
      const chunks: Buffer[] = [];
      socket.on('data', (data: Buffer) => {
        pending = Buffer.concat([pending, data]);
        if (!command) {
          const end = pending.indexOf(0);
          if (end < 0) return;
          expect(pending.subarray(0, end).toString()).toBe('zINSTREAM');
          pending = pending.subarray(end + 1);
          command = true;
        }
        while (pending.length >= 4) {
          const size = pending.readUInt32BE();
          if (pending.length < size + 4) return;
          const data = pending.subarray(4, 4 + size);
          pending = pending.subarray(size + 4);
          if (!size) {
            uploaded.push(Buffer.concat(chunks));
            socket.end(reply);
            return;
          }
          chunks.push(data);
        }
      });
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port,
        scanner = new ClamAvScanner('127.0.0.1', port);
      expect(await scanner.scan(path, AbortSignal.timeout(2000))).toBe('clean');
      expect(uploaded[0]).toEqual(original);
      reply = 'stream: Eicar-Test-Signature FOUND\0';
      await expect(scanner.scan(path, AbortSignal.timeout(2000))).rejects.toThrow('FILE_INFECTED');
      for (const invalid of ['stream: OK', 'stream: scanner ERROR\0', '']) {
        reply = invalid;
        await expect(scanner.scan(path, AbortSignal.timeout(2000))).rejects.toThrow();
      }
      const aborted = AbortSignal.abort(new Error('Cancelled'));
      await expect(scanner.scan(path, aborted)).rejects.toThrow();
    } finally {
      server.close();
      await once(server, 'close');
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('round trips private S3 objects using the real AWS SDK without exposing bucket paths to clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbit-s3-')),
      path = join(directory, 'file');
    const original = Buffer.from('Object-store payload');
    await writeFile(path, original);
    const objects = new Map<string, Buffer>(),
      requests: string[] = [];
    const server = createHttpServer(async (req, res) => {
      const key = new URL(req.url!, 'http://localhost').pathname;
      requests.push(`${req.method} ${key}`);
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        objects.set(key, Buffer.concat(chunks));
        res.end();
      } else if (req.method === 'GET') {
        const data = objects.get(key);
        if (!data) {
          res.writeHead(404);
          res.end();
        } else {
          res.setHeader('content-length', data.length);
          res.end(data);
        }
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(405);
        res.end();
      }
    });
    let client: S3Client | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      client = new S3Client({
        region: 'us-east-1',
        endpoint: `http://127.0.0.1:${port}`,
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        requestChecksumCalculation: 'WHEN_REQUIRED',
      });
      const store = new S3FileStore(client, 'private-files');
      await store.put('workspace/file/original', path, AbortSignal.timeout(2000));
      const stream = await store.get('workspace/file/original');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(original);
      await store.delete('workspace/file/original');
      await store.delete('workspace/file/original');
      await expect(store.get('workspace/file/original')).rejects.toThrow();
      expect(requests[0]).toBe('PUT /private-files/workspace/file/original');
      expect(objects.size).toBe(0);
    } finally {
      client?.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
      await rm(directory, { recursive: true, force: true });
    }
  });
});
