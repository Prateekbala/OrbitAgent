import { it, expect } from 'vitest';
import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { S3FileStore } from '../src/files/storage.js';
import { randomUUID } from 'node:crypto';
it('erases S3 versions and delete markers and aborts unfinished multipart uploads', async () => {
  const workspace = randomUUID(),
    prefix = workspace + '/',
    removed: unknown[] = [];
  let versions = true,
    uploads = true,
    heartbeats = 0;
  const client = {
    async send(command: unknown) {
      if (command instanceof ListObjectVersionsCommand)
        return versions
          ? {
              Versions: [
                { Key: prefix + 'file', VersionId: 'old' },
                { Key: prefix + 'file', VersionId: 'new' },
              ],
              DeleteMarkers: [{ Key: prefix + 'file', VersionId: 'marker' }],
            }
          : {};
      if (command instanceof DeleteObjectsCommand) {
        removed.push(command.input.Delete?.Objects);
        versions = false;
        return {};
      }
      if (command instanceof ListMultipartUploadsCommand)
        return uploads ? { Uploads: [{ Key: prefix + 'partial', UploadId: 'upload' }] } : {};
      if (command instanceof AbortMultipartUploadCommand) {
        uploads = false;
        return {};
      }
      throw new Error('Unexpected command.');
    },
  };
  await new S3FileStore(client as unknown as S3Client, 'private-fixture').purgeWorkspace(
    workspace,
    async () => {
      heartbeats++;
    },
  );
  expect(removed).toEqual([
    [
      { Key: prefix + 'file', VersionId: 'old' },
      { Key: prefix + 'file', VersionId: 'new' },
      { Key: prefix + 'file', VersionId: 'marker' },
    ],
  ]);
  expect(uploads).toBe(false);
  expect(heartbeats).toBeGreaterThan(1);
});
it('stops on locked versions and never deletes another workspace prefix', async () => {
  const workspace = randomUUID();
  let deleted = false;
  const foreign = {
    async send(command: unknown) {
      if (command instanceof ListObjectVersionsCommand)
        return { Versions: [{ Key: randomUUID() + '/foreign', VersionId: 'one' }] };
      deleted = true;
      return {};
    },
  };
  await expect(
    new S3FileStore(foreign as unknown as S3Client, 'private').purgeWorkspace(
      workspace,
      async () => {},
    ),
  ).rejects.toThrow('foreign namespace');
  expect(deleted).toBe(false);
  const locked = {
    async send(command: unknown) {
      return command instanceof ListObjectVersionsCommand
        ? { Versions: [{ Key: workspace + '/held', VersionId: 'one' }] }
        : { Errors: [{ Code: 'AccessDenied' }] };
    },
  };
  await expect(
    new S3FileStore(locked as unknown as S3Client, 'private').purgeWorkspace(
      workspace,
      async () => {},
    ),
  ).rejects.toThrow('locked');
});
