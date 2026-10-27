import { authenticatePlatform } from '../developer/auth.js';
import { ActivityService } from '../activity/service.js';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { tenantScope, type Database } from '@ao/database';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eventCursor } from '@ao/contracts';
import { authenticate } from './auth.js';
import { AppError } from '../lib/errors.js';
import { EventFeed } from '../messaging/events.js';
import { EventCursors } from '../messaging/cursors.js';
const ephemeralDevelopmentKey = randomBytes(32).toString('base64');

export function realtimeRoutes(
  app: FastifyInstance,
  db: Database,
  origin: string,
  key?: string,
  allowedOrigins: string[] = [],
) {
  const feed = new EventFeed(db);
  const activity = new ActivityService(db);
  const cursors = new EventCursors(key ?? ephemeralDevelopmentKey);
  const connections = new Map<AbortController, { key: string; stream: Readable }>();
  app.addHook('preClose', async () => {
    for (const [controller, { stream }] of connections) {
      controller.abort();
      stream.destroy();
    }
  });
  app.get('/v1/events', async (req) => {
    const p = await authenticate(db, req);
    const { after } = z.object({ after: eventCursor.default('0') }).parse(req.query);
    return cursors.batch(await feed.page(p, cursors.decode(after, p)), p);
  });
  const stream = async (req: FastifyRequest, reply: FastifyReply) => {
    if (
      req.headers.origin &&
      req.headers.origin !== origin &&
      !(
        req.routeOptions.url === '/public/v1/events/stream' &&
        allowedOrigins.includes(req.headers.origin)
      )
    )
      throw new AppError(403, 'INVALID_ORIGIN', 'This request origin is not allowed.');
    const p = await (req.routeOptions.url === '/public/v1/events/stream'
      ? authenticatePlatform(db, req)
      : authenticate(db, req));
    const query = z.object({ after: eventCursor.default('0') }).parse(req.query);
    let cursor = cursors.decode(req.headers['last-event-id'] ?? query.after, p);
    const first = await feed.page(p, cursor);
    const key = `${p.workspaceId}:${p.membershipId}`;
    if (
      connections.size >= 256 ||
      [...connections.values()].filter((c) => c.key === key).length >= 4
    )
      throw new AppError(
        429,
        'STREAM_LIMIT',
        'Too many live connections. Close another workspace tab and retry.',
      );
    const controller = new AbortController(),
      started = Date.now();
    async function* frames() {
      try {
        yield 'retry: 1500\n\nevent: ready\ndata: {}\n\n';
        let page = first,
          heartbeat = Date.now(),
          activityAt = 0;
        while (!controller.signal.aborted && Date.now() - started < 300000) {
          const identity = await tenantScope(p.workspaceId, () => authenticate(db, req));
          if (identity.workspaceId !== p.workspaceId || identity.membershipId !== p.membershipId)
            throw new AppError(401, 'SESSION_CHANGED', 'Your workspace session changed.');
          if (
            identity.kind === 'human' &&
            !identity.platformCredentialId &&
            Date.now() - activityAt >= 2000
          ) {
            const snapshot = await tenantScope(p.workspaceId, () => activity.snapshot(identity));
            yield `event: activity\ndata: ${JSON.stringify(snapshot)}\n\n`;
            activityAt = Date.now();
          }
          cursor = page.cursor;
          if (page.events.length) {
            const publicPage = cursors.batch(page, p);
            yield `id: ${publicPage.cursor}\nevent: changes\ndata: ${JSON.stringify(publicPage)}\n\n`;
          }
          if (Date.now() - heartbeat >= 15000) {
            heartbeat = Date.now();
            yield `id: ${cursors.encode(cursor, p)}\nevent: checkpoint\ndata: {}\n\n`;
          }
          if (!page.hasMore) await setTimeout(500, undefined, { signal: controller.signal });
          page = await tenantScope(p.workspaceId, () => feed.page(identity, cursor));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof AppError && [401, 403].includes(error.status))
          yield 'event: auth-required\ndata: {}\n\n';
        else {
          app.log.error({ code: 'REALTIME_STREAM_FAILED' }, 'Realtime stream interrupted');
          yield 'event: reconnect\ndata: {}\n\n';
        }
      } finally {
        controller.abort();
      }
    }
    const stream = Readable.from(frames(), { objectMode: false, highWaterMark: 16384 });
    connections.set(controller, { key, stream });
    const close = () => {
      controller.abort();
      connections.delete(controller);
      stream.destroy();
    };
    stream.once('close', close);
    reply.raw.once('close', close);
    return reply
      .type('text/event-stream; charset=utf-8')
      .header('cache-control', 'private, no-cache, no-store, no-transform')
      .header('x-accel-buffering', 'no')
      .send(stream);
  };
  app.get('/v1/events/stream', stream);
  app.get('/public/v1/events/stream', stream);
}
