import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import {
  fileVersionInput,
  fileShareInput,
  shareProof,
  dlpPolicy,
  uploadChunkBytes,
} from '@ao/contracts/file-governance';
import { authenticate } from './auth.js';
import { sharedFileService } from '../files/service.js';
import { FileGovernance } from '../files/governance.js';
import { ResumableUploads } from '../files/resumable.js';
import type { FileDependencies } from '../files/config.js';
import { AppError } from '../lib/errors.js';
export function fileGovernanceRoutes(
  app: FastifyInstance,
  db: Database,
  dependencies?: FileDependencies,
) {
  const id = (params: unknown) => z.object({ id: z.uuid() }).passthrough().parse(params).id;
  const services = () => {
    if (!dependencies)
      throw new AppError(503, 'FILES_UNAVAILABLE', 'File storage is not configured.');
    const files = sharedFileService(db, dependencies);
    return {
      files,
      governance: new FileGovernance(db, files),
      uploads: new ResumableUploads(db, files),
    };
  };
  app.addContentTypeParser(
    'application/offset+octet-stream',
    { parseAs: 'buffer', bodyLimit: uploadChunkBytes },
    (_req, body, done) => done(null, body),
  );
  app.get('/v1/files/policy', async (req) =>
    services().governance.policy(await authenticate(db, req)),
  );
  app.put('/v1/files/policy', async (req) =>
    services().governance.policy(await authenticate(db, req), dlpPolicy.parse(req.body)),
  );
  app.get('/v1/files/:id/upload', async (req) =>
    services().uploads.status(await authenticate(db, req), id(req.params)),
  );
  app.patch('/v1/files/:id/upload', { bodyLimit: uploadChunkBytes }, async (req) => {
    const p = await authenticate(db, req),
      offset = z.coerce.number().int().nonnegative().parse(req.headers['upload-offset']),
      checksum = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(req.headers['upload-checksum']);
    if (!Buffer.isBuffer(req.body))
      throw new AppError(
        400,
        'CHUNK_REQUIRED',
        'Send a binary chunk with its checksum and offset.',
      );
    return services().uploads.chunk(
      p,
      id(req.params),
      offset,
      checksum,
      req.body,
      AbortSignal.timeout(30000),
    );
  });
  app.post('/v1/files/:id/upload/complete', async (req) =>
    services().uploads.complete(
      await authenticate(db, req),
      id(req.params),
      AbortSignal.timeout(120000),
    ),
  );
  app.get('/v1/files/:id/versions', async (req) =>
    services().governance.versions(await authenticate(db, req), id(req.params)),
  );
  app.post('/v1/files/:id/versions', async (req) =>
    services().governance.promote(
      await authenticate(db, req),
      id(req.params),
      fileVersionInput.parse(req.body),
    ),
  );
  app.post('/v1/files/:id/shares', async (req) =>
    services().governance.share(
      await authenticate(db, req),
      id(req.params),
      fileShareInput.parse(req.body),
    ),
  );
  app.get('/v1/files/:id/shares', async (req) =>
    services().governance.shares(await authenticate(db, req), id(req.params)),
  );
  app.delete('/v1/files/:id/shares/:share', async (req) => {
    const params = z.object({ id: z.uuid(), share: z.uuid() }).parse(req.params);
    return services().governance.revoke(await authenticate(db, req), params.id, params.share);
  });
  app.post('/v1/file-shares/resolve', async (req) => {
    const p = await authenticate(db, req),
      proof = shareProof.parse(req.body),
      file = await services().governance.resolve(p, proof.id, proof.token);
    return { id: file.id, name: file.name, size: file.size, version: file.version };
  });
  app.post('/v1/file-shares/content', async (req, reply) => {
    const p = await authenticate(db, req),
      proof = shareProof.parse(req.body),
      file = await services().governance.resolve(p, proof.id, proof.token);
    if (file.storage_provider !== dependencies!.store.id)
      throw new AppError(
        503,
        'FILE_STORE_UNAVAILABLE',
        'This file storage provider is unavailable.',
      );
    const body = await dependencies!.store.get(String(file.object_key));
    try {
      await services().governance.resolve(p, proof.id, proof.token, true);
    } catch (error) {
      body.destroy();
      throw error;
    }
    return reply
      .type('application/octet-stream')
      .header(
        'content-disposition',
        "attachment; filename*=UTF-8''" +
          encodeURIComponent(String(file.name)).replace(
            /['()*]/g,
            (c) => '%' + c.charCodeAt(0).toString(16),
          ),
      )
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });
}
