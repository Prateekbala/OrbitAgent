import { TaskAttachmentService } from '../tasks/attachments.js';
import { taskAttachmentInput, taskAttachmentQuery, taskAttachmentVersion } from '@ao/contracts';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { fileInput, id } from '@ao/contracts';
import { AppError, notFound } from '../lib/errors.js';
import { authenticate } from './auth.js';
import { sharedFileService } from '../files/service.js';
import type { FileDependencies } from '../files/config.js';
import { byteRange } from '../files/ranges.js';
import { FileGovernance } from '../files/governance.js';
export function fileRoutes(app: FastifyInstance, db: Database, dependencies?: FileDependencies) {
  const attachments = new TaskAttachmentService(db);
  const service = dependencies ? sharedFileService(db, dependencies) : undefined;
  function files() {
    if (!service) throw new AppError(503, 'FILES_UNAVAILABLE', 'File storage is not configured.');
    return service;
  }
  const fileId = (params: unknown) => id.parse((params as { id: string }).id);
  app.post(
    '/v1/conversations/:id/files',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await files().reserve(
            await authenticate(db, req),
            fileId(req.params),
            fileInput.parse(req.body),
          ),
        ),
  );
  app.post(
    '/v1/tasks/:id/files',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await files().reserveTask(
            await authenticate(db, req),
            fileId(req.params),
            fileInput.parse(req.body),
          ),
        ),
  );
  app.get('/v1/tasks/:id/attachments', async (req) =>
    attachments.list(
      await authenticate(db, req),
      fileId(req.params),
      taskAttachmentQuery.parse(req.query),
    ),
  );
  app.post('/v1/tasks/:id/attachments', async (req) =>
    attachments.attach(
      await authenticate(db, req),
      fileId(req.params),
      taskAttachmentInput.parse(req.body).fileIds,
    ),
  );
  app.delete('/v1/tasks/:id/attachments/:file', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id, file: id }).parse(req.params);
    return attachments.remove(
      p,
      params.id,
      params.file,
      taskAttachmentVersion.parse(req.body).version,
    );
  });
  app.get('/v1/files/:id', async (req) =>
    files().metadata(await authenticate(db, req), fileId(req.params)),
  );
  app.delete('/v1/files/:id', async (req) =>
    files().discard(await authenticate(db, req), fileId(req.params)),
  );
  app.put('/v1/files/:id/content', async (req) => {
    const p = await authenticate(db, req);
    const abort = new AbortController();
    const onAbort = () => abort.abort(new Error('Upload disconnected.'));
    req.raw.once('aborted', onAbort);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]);
    try {
      return await files().upload(
        p,
        fileId(req.params),
        async () => {
          const parts = req.parts({
            limits: { files: 1, fields: 0, parts: 1, fileSize: 25 * 1024 * 1024 },
          });
          const first = await parts.next();
          if (first.done || first.value.type !== 'file')
            throw new AppError(400, 'FILE_REQUIRED', 'Upload one file.');
          const part = first.value;
          return {
            stream: part.file,
            truncated: () => part.file.truncated,
            complete: async () => {
              const extra = await parts.next();
              if (!extra.done)
                throw new AppError(400, 'TOO_MANY_FILES', 'Upload one file at a time.');
            },
          };
        },
        signal,
      );
    } finally {
      req.raw.off('aborted', onAbort);
    }
  });
  for (const preview of [false, true])
    app.get(`/v1/files/:id/${preview ? 'preview' : 'content'}`, async (req, reply) => {
      const p = await authenticate(db, req),
        root = await files().inspect(p, fileId(req.params), true),
        version = z
          .object({ version: z.coerce.number().int().positive().optional() })
          .parse(req.query).version,
        file =
          version && !preview
            ? await new FileGovernance(db, files()).version(p, String(root.id), version)
            : root;
      if (file.storage_provider !== dependencies!.store.id || (preview && !file.preview_key))
        throw notFound();
      const etag = '"' + String(file.sha256) + '-' + String(file.version) + '"';
      let range;
      if (!preview) {
        reply.header('accept-ranges', 'bytes').header('etag', etag);
        try {
          range = byteRange(
            req.headers['if-range'] && req.headers['if-range'] !== etag
              ? undefined
              : req.headers.range,
            Number(file.size),
          );
        } catch (error) {
          reply.header('content-range', `bytes */${file.size}`);
          throw error;
        }
      }
      const body =
        req.method === 'HEAD'
          ? undefined
          : await dependencies!.store.get(
              String(preview ? file.preview_key : file.object_key),
              range,
            );
      try {
        const current = await files().inspect(p, fileId(req.params), true);
        if (current.version !== root.version)
          throw new AppError(409, 'VERSION_CONFLICT', 'The file changed. Retry the download.');
        if (version && !preview)
          await new FileGovernance(db, files()).version(p, String(root.id), version);
      } catch (error) {
        body?.destroy();
        throw error;
      }
      const filename = String(file.name).replace(/[^\x20-\x7e]|["\\]/g, '_');
      reply
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox allow-downloads");
      reply.type(preview ? 'image/png' : 'application/octet-stream');
      reply.header(
        'content-disposition',
        preview
          ? 'inline'
          : `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(String(file.name)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
      );
      if (!preview)
        reply.header('content-length', range ? range.end - range.start + 1 : Number(file.size));
      if (range)
        reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${file.size}`);
      return reply.send(body);
    });
}
