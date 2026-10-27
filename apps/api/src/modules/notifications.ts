import type { Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import {
  id,
  notificationQuery,
  notificationRead,
  notificationReadAll,
  notificationPreferenceUpdate,
  conversationNotificationPreference,
} from '@ao/contracts';
import { authenticate } from './auth.js';
import { NotificationService } from '../notifications/service.js';
export function notificationRoutes(app: FastifyInstance, db: Database) {
  const service = new NotificationService(db);
  const param = (value: unknown) => id.parse((value as { id: string }).id);
  app.get('/v1/notifications', async (req) =>
    service.list(await authenticate(db, req), notificationQuery.parse(req.query)),
  );
  app.patch('/v1/notifications/:id', async (req) =>
    service.read(
      await authenticate(db, req),
      param(req.params),
      notificationRead.parse(req.body).read,
    ),
  );
  app.post('/v1/notifications/read-all', async (req) =>
    service.readAll(await authenticate(db, req), notificationReadAll.parse(req.body).throughId),
  );
  app.get('/v1/notifications/preferences', async (req) =>
    service.preferences(await authenticate(db, req)),
  );
  app.patch('/v1/notifications/preferences', async (req) =>
    service.updatePreferences(
      await authenticate(db, req),
      notificationPreferenceUpdate.parse(req.body),
    ),
  );
  app.get('/v1/conversations/:id/notification-preferences', async (req) =>
    service.conversationPreference(await authenticate(db, req), param(req.params)),
  );
  app.put('/v1/conversations/:id/notification-preferences', async (req) =>
    service.updateConversationPreference(
      await authenticate(db, req),
      param(req.params),
      conversationNotificationPreference.parse(req.body).mode,
    ),
  );
}
