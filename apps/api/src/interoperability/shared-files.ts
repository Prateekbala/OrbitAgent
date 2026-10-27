import { hasPermission } from '../identity/authorization.js';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { id, messageDelete } from '@ao/contracts';
import { authenticate } from '../modules/auth.js';
import { currentSession } from '../identity/security.js';
import { FileService } from '../files/service.js';
import type { FileDependencies } from '../files/config.js';
import { MessageService } from '../messaging/service.js';
import { AppError, notFound } from '../lib/errors.js';
import type { SharedChannelService } from './shared.js';
export function sharedFileRoutes(
  app: FastifyInstance,
  db: Database,
  shared: SharedChannelService,
  files?: FileDependencies,
) {
  const params = z.object({ id, file: id });
  app.put('/v1/shared-channels/:id/files/:file/content', async (req) => {
    await currentSession(db, req);
    const p = await authenticate(db, req),
      q = params.parse(req.params);
    if (!hasPermission(p, req.method === 'PUT' ? 'files.write' : 'files.read'))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Your source membership does not grant file access.',
      );
    if (!files) throw new AppError(503, 'FILES_UNAVAILABLE', 'File storage is unavailable.');
    return shared.inChannel(p, q.id, true, async (guest, c) => {
      const service = new FileService(db, files),
        file = await service.inspect(guest, q.file);
      if (file.conversation_id !== c) throw notFound();
      const abort = new AbortController(),
        onAbort = () => abort.abort();
      req.raw.once('aborted', onAbort);
      try {
        return await service.upload(
          guest,
          q.file,
          async () => {
            const parts = req.parts({
                limits: { files: 1, fields: 0, parts: 1, fileSize: 25 * 1024 * 1024 },
              }),
              first = await parts.next();
            if (first.done || first.value.type !== 'file')
              throw new AppError(400, 'FILE_REQUIRED', 'Upload one file.');
            const part = first.value;
            return {
              stream: part.file,
              truncated: () => part.file.truncated,
              complete: async () => {
                if (!(await parts.next()).done)
                  throw new AppError(400, 'TOO_MANY_FILES', 'Upload one file.');
              },
            };
          },
          AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
        );
      } finally {
        req.raw.off('aborted', onAbort);
      }
    });
  });
  app.get('/v1/shared-channels/:id/files/:file/content', async (req, reply) => {
    await currentSession(db, req);
    const p = await authenticate(db, req),
      q = params.parse(req.params);
    if (!hasPermission(p, req.method === 'PUT' ? 'files.write' : 'files.read'))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Your source membership does not grant file access.',
      );
    if (!files) throw new AppError(503, 'FILES_UNAVAILABLE', 'File storage is unavailable.');
    return shared.inChannel(p, q.id, false, async (guest, c) => {
      const file = await new FileService(db, files).inspect(guest, q.file, true);
      if (file.conversation_id !== c || file.storage_provider !== files.store.id) throw notFound();
      const stream = await files.store.get(String(file.object_key));
      reply
        .type('application/octet-stream')
        .header('content-length', Number(file.size))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox allow-downloads")
        .header(
          'content-disposition',
          `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(String(file.name)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
        );
      return reply.send(stream);
    });
  });
  app.delete('/v1/shared-channels/:id/messages/:message', async (req) => {
    await currentSession(db, req);
    const p = await authenticate(db, req),
      q = z.object({ id, message: id }).parse(req.params),
      input = messageDelete.parse(req.body);
    return shared.inChannel(p, q.id, true, async (guest, c) => {
      const [m] = await db.query(
        'SELECT conversation_id FROM messages WHERE workspace_id=$1 AND id=$2',
        [guest.workspaceId, q.message],
      );
      if (m?.conversation_id !== c) throw notFound();
      return new MessageService(db).delete(guest, q.message, input.version);
    });
  });
  app.put('/v1/shared-channels/:id/read', async (req) => {
    await currentSession(db, req);
    const p = await authenticate(db, req),
      q = z.object({ id }).parse(req.params),
      input = z.object({ messageId: id }).strict().parse(req.body);
    return shared.inChannel(p, q.id, false, (guest, c) =>
      new MessageService(db).read(guest, c, input.messageId),
    );
  });
}
