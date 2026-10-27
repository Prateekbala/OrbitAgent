import type { Database } from '@ao/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  presenceHeartbeat,
  presencePreference,
  presenceLeave,
  typingInput,
  id,
} from '@ao/contracts';
import { authenticate } from './auth.js';
import { ActivityService } from '../activity/service.js';
import { digest } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
import { z } from 'zod';
export function activityRoutes(app: FastifyInstance, db: Database) {
  const service = new ActivityService(db);
  const session = (req: FastifyRequest) => {
    if (!req.cookies.ao_session)
      throw new AppError(403, 'HUMAN_REQUIRED', 'Presence requires a browser session.');
    return digest(req.cookies.ao_session);
  };
  app.get('/v1/activity', async (req) => {
    const query = z
      .object({
        membershipIds: z
          .string()
          .max(7400)
          .transform((value) => value.split(','))
          .pipe(z.array(z.uuid()).min(1).max(200))
          .optional(),
      })
      .parse(req.query);
    return service.snapshot(await authenticate(db, req), query.membershipIds);
  });
  app.put(
    '/v1/presence',
    { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } },
    async (req) =>
      service.heartbeat(
        await authenticate(db, req),
        session(req),
        presenceHeartbeat.parse(req.body),
      ),
  );
  app.delete('/v1/presence', async (req) =>
    service.leave(
      await authenticate(db, req),
      session(req),
      presenceLeave.parse(req.body).clientId,
    ),
  );
  app.put('/v1/presence/preferences', async (req) =>
    service.preference(await authenticate(db, req), presencePreference.parse(req.body).mode),
  );
  app.put(
    '/v1/conversations/:id/typing',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) =>
      service.typing(
        await authenticate(db, req),
        session(req),
        id.parse((req.params as { id: string }).id),
        typingInput.parse(req.body),
      ),
  );
}
