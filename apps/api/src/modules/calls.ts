import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  callCreate,
  callJoin,
  callTranscriptInput,
  callCorrection,
  callNotes,
} from '@ao/contracts/calls';
import { authenticate } from './auth.js';
import { CallService, callAccess } from '../calls/service.js';
import type { CallMedia } from '../calls/provider.js';
import { notFound } from '../lib/errors.js';
import { digest } from '../lib/security.js';

export function callRoutes(
  app: FastifyInstance,
  db: Database,
  media?: CallMedia,
  directory?: string,
) {
  const service = new CallService(db, media);
  const ids = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/v1/calls/capabilities', async (req) => {
    await authenticate(db, req);
    return service.capabilities();
  });
  app.get('/v1/conversations/:id/calls', async (req) =>
    service.list(
      await authenticate(db, req),
      ids(req.params),
      z.object({ before: z.uuid().optional() }).parse(req.query).before,
    ),
  );
  app.post('/v1/conversations/:id/calls', async (req, reply) =>
    reply
      .code(201)
      .send(
        await service.create(
          await authenticate(db, req),
          ids(req.params),
          callCreate.parse(req.body),
        ),
      ),
  );
  app.get('/v1/calls/:id', async (req) =>
    service.snapshot(await authenticate(db, req), ids(req.params)),
  );
  app.post('/v1/calls/:id/join', async (req) =>
    service.join(
      await authenticate(db, req),
      ids(req.params),
      callJoin.parse(req.body),
      digest(req.cookies.ao_session ?? ''),
    ),
  );
  app.post('/v1/calls/:id/heartbeat', async (req) =>
    service.heartbeat(
      await authenticate(db, req),
      ids(req.params),
      z.object({ participantId: z.uuid() }).strict().parse(req.body).participantId,
    ),
  );
  app.post('/v1/calls/:id/leave', async (req) => {
    const p = await authenticate(db, req),
      input = z
        .object({ participantId: z.uuid(), withdraw: z.boolean().default(false) })
        .strict()
        .parse(req.body);
    return service.leave(p, ids(req.params), input.participantId, input.withdraw);
  });
  app.post('/v1/calls/:id/end', async (req) =>
    service.end(await authenticate(db, req), ids(req.params)),
  );
  app.post('/v1/calls/:id/remove', async (req) =>
    service.remove(
      await authenticate(db, req),
      ids(req.params),
      z.object({ participantId: z.uuid() }).strict().parse(req.body).participantId,
    ),
  );
  app.post('/v1/calls/:id/mute', async (req) =>
    service.mute(
      await authenticate(db, req),
      ids(req.params),
      z.object({ participantId: z.uuid() }).strict().parse(req.body).participantId,
    ),
  );
  app.delete('/v1/calls/:id/content', async (req) =>
    service.deleteContent(await authenticate(db, req), ids(req.params)),
  );
  app.get('/v1/calls/:id/transcript', async (req) => {
    const p = await authenticate(db, req),
      query = z
        .object({
          after: z.coerce.number().int().nonnegative().default(0),
          afterId: z.uuid().optional(),
        })
        .parse(req.query);
    return service.segments(p, ids(req.params), query.after, query.afterId);
  });
  app.post('/v1/calls/:id/transcript', async (req) =>
    service.append(
      await authenticate(db, req),
      ids(req.params),
      callTranscriptInput.parse(req.body),
    ),
  );
  app.patch('/v1/calls/:id/transcript/:segment', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id: z.uuid(), segment: z.uuid() }).parse(req.params),
      input = callCorrection.parse(req.body);
    return service.correct(p, params.id, params.segment, input.version, input.text);
  });
  app.get('/v1/calls/:id/notes', async (req) =>
    service.notes(await authenticate(db, req), ids(req.params)),
  );
  app.put('/v1/calls/:id/notes', async (req) =>
    service.notes(await authenticate(db, req), ids(req.params), callNotes.parse(req.body)),
  );
  app.get('/v1/calls/:id/recording', async (req, reply) => {
    const p = await authenticate(db, req),
      call = await callAccess(db, p, ids(req.params));
    if (
      !directory ||
      call.mode !== 'retained_recording' ||
      call.state !== 'ended' ||
      call.recording_deleted_at ||
      !/^[0-9a-f-]{36}\.mp4$/.test(String(call.recording_key))
    )
      throw notFound();
    const file = join(directory, String(call.recording_key));
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw notFound();
    reply
      .header('content-type', 'video/mp4')
      .header('content-disposition', 'attachment; filename="orbit-call.mp4"')
      .header('content-length', info.size)
      .header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(file));
  });
  app.get('/v1/calls/:id/export', async (req) => {
    const p = await authenticate(db, req),
      id = ids(req.params);
    return {
      call: await service.snapshot(p, id),
      transcript: await service.segments(p, id, 0, undefined, 2001),
      notes: await service.notes(p, id),
    };
  });
}
