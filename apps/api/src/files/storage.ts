import { createReadStream } from 'node:fs';
import { mkdir, copyFile, unlink, stat, chmod, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ByteRange } from './ranges.js';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
export interface FileStore {
  readonly id: 'local' | 's3';
  put(key: string, path: string, signal: AbortSignal): Promise<void>;
  get(key: string, range?: ByteRange): Promise<Readable>;
  delete(key: string): Promise<void>;
  purgeWorkspace?(workspaceId: string, heartbeat: () => Promise<void>): Promise<void>;
}
export class LocalFileStore implements FileStore {
  readonly id = 'local' as const;
  private readonly root: string;
  constructor(directory: string) {
    this.root = resolve(directory);
  }
  private path(key: string) {
    if (!/^[a-zA-Z0-9/-]+$/.test(key)) throw new Error('Invalid storage key.');
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage path.');
    return path;
  }
  async purgeWorkspace(workspaceId: string, heartbeat: () => Promise<void>) {
    if (!/^[a-f0-9-]{36}$/.test(workspaceId)) throw new Error('Invalid workspace namespace.');
    await heartbeat();
    await rm(this.path(workspaceId), { recursive: true, force: true });
  }
  async put(key: string, path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = target + '.' + randomUUID();
    try {
      await copyFile(path, temporary);
      await chmod(temporary, 0o600);
      signal.throwIfAborted();
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async get(key: string, range?: ByteRange) {
    const path = this.path(key);
    await stat(path);
    return createReadStream(path, range);
  }
  async delete(key: string) {
    await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export class S3FileStore implements FileStore {
  readonly id = 's3' as const;
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}
  async purgeWorkspace(workspaceId: string, heartbeat: () => Promise<void>) {
    if (!/^[a-f0-9-]{36}$/.test(workspaceId)) throw new Error('Invalid workspace namespace.');
    const Prefix = workspaceId + '/';
    while (true) {
      await heartbeat();
      const page = await this.client.send(
        new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix, MaxKeys: 1000 }),
      );
      const Objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({
        Key: v.Key!,
        VersionId: v.VersionId!,
      }));
      if (!Objects.length) break;
      if (Objects.some((object) => !object.Key.startsWith(Prefix)))
        throw new Error('Storage returned a foreign namespace.');
      const result = await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects, Quiet: true } }),
      );
      if (result.Errors?.length) throw new Error('Object versions are locked or deletion failed.');
    }
    while (true) {
      await heartbeat();
      const page = await this.client.send(
        new ListMultipartUploadsCommand({ Bucket: this.bucket, Prefix, MaxUploads: 1000 }),
      );
      if (!page.Uploads?.length) break;
      if (page.Uploads.some((upload) => !upload.Key?.startsWith(Prefix)))
        throw new Error('Storage returned a foreign namespace.');
      for (const upload of page.Uploads)
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: upload.Key!,
            UploadId: upload.UploadId!,
          }),
        );
    }
  }
  async put(key: string, path: string, signal: AbortSignal) {
    const body = createReadStream(path);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: (await stat(path)).size,
          ContentType: 'application/octet-stream',
        }),
        { abortSignal: signal },
      );
    } finally {
      body.destroy();
    }
  }
  async get(key: string, range?: ByteRange) {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    if (!(response.Body instanceof Readable))
      throw new Error('Object storage returned no readable body.');
    return response.Body;
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(30000),
    });
  }
}
