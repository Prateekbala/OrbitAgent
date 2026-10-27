import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { directInput, groupInput, groupUpdate, id } from '@ao/contracts';
import { authenticate } from './auth.js';
import { ConversationService } from '../conversations/service.js';
export function conversationRoutes(app: FastifyInstance, db: Database) {
  const service = new ConversationService(db);
  app.post('/v1/conversations/direct', async (req, reply) => {
    const p = await authenticate(db, req);
    const result = await service.direct(p, directInput.parse(req.body).membershipId);
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.post('/v1/conversations/groups', async (req, reply) =>
    reply
      .code(201)
      .send(await service.group(await authenticate(db, req), groupInput.parse(req.body))),
  );
  app.get('/v1/conversations/:id', async (req) =>
    service.details(await authenticate(db, req), id.parse((req.params as { id: string }).id)),
  );
  app.patch('/v1/conversations/:id', async (req) =>
    service.update(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      groupUpdate.parse(req.body),
    ),
  );
}
