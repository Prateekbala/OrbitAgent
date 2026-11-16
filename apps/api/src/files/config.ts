import { S3Client } from '@aws-sdk/client-s3';
import { resolve } from 'node:path';
import {
  ClamAvScanner,
  DevelopmentScanner,
  UnavailableScanner,
  type FileScanner,
} from './scanner.js';
import { LocalFileStore, S3FileStore, type FileStore } from './storage.js';
import { CloudinaryFileStore } from './cloudinary.js';
export interface FileDependencies {
  store: FileStore;
  scanner: FileScanner;
  stagingDirectory: string;
}
export function configuredFiles(env: NodeJS.ProcessEnv, root: string): FileDependencies {
  const production = env.NODE_ENV === 'production';
  const provider = env.FILE_STORAGE_PROVIDER || (production ? 's3' : 'local');
  if (!['local', 's3', 'cloudinary'].includes(provider))
    throw new Error('Unsupported FILE_STORAGE_PROVIDER.');
  if (production && provider === 'local')
    throw new Error('Production files require private object storage.');
  if (provider === 's3' && (!env.S3_BUCKET || !env.S3_REGION))
    throw new Error('S3_BUCKET and S3_REGION are required.');
  const scanPort = Number(env.CLAMAV_PORT ?? 3310);
  if (!Number.isInteger(scanPort) || scanPort < 1 || scanPort > 65535)
    throw new Error('CLAMAV_PORT must be a valid TCP port.');
  if (production && provider === 's3' && env.S3_ENDPOINT && !env.S3_ENDPOINT.startsWith('https://'))
    throw new Error('Production object storage requires HTTPS.');
  return {
    store:
      provider === 'local'
        ? new LocalFileStore(resolve(root, '.data/files'))
        : provider === 'cloudinary'
          ? new CloudinaryFileStore({
              cloudName: env.CLOUDINARY_CLOUD_NAME ?? '',
              apiKey: env.CLOUDINARY_API_KEY ?? '',
              apiSecret: env.CLOUDINARY_API_SECRET ?? '',
              folder: env.CLOUDINARY_FOLDER || 'orbit',
            })
          : new S3FileStore(
              new S3Client({
                region: env.S3_REGION!,
                maxAttempts: 1,
                ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
              }),
              env.S3_BUCKET!,
            ),
    scanner: env.CLAMAV_HOST
      ? new ClamAvScanner(env.CLAMAV_HOST, scanPort)
      : production
        ? new UnavailableScanner()
        : new DevelopmentScanner(),
    stagingDirectory: resolve(root, env.FILE_STAGING_DIRECTORY || '.data/uploads'),
  };
}
