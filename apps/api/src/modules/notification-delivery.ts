import type { FastifyInstance } from 'fastify';
import { workerScope, type Database } from '@ao/database';
import { z } from 'zod';
import {
  deliveryPreferences,
  deviceRegistration,
  scopedDeliveryPreference,
} from '@ao/contracts/delivery';
import { authenticate } from './auth.js';
import { IdentitySecrets } from '../identity/secrets.js';
import { NotificationDeliveryService } from '../notifications/delivery-service.js';
import type { PushProvider } from '../notifications/delivery-providers.js';
import { digest } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
export function notificationDeliveryRoutes(
  app: FastifyInstance,
  db: Database,
  secrets: IdentitySecrets,
  push?: PushProvider,
) {
  const service = new NotificationDeliveryService(db, secrets, push);
  app.get('/v1/notification-delivery/preferences', async (req) =>
    service.settings(await authenticate(db, req)),
  );
  app.put('/v1/notification-delivery/preferences', async (req) =>
    service.update(await authenticate(db, req), deliveryPreferences.parse(req.body)),
  );
  app.get('/v1/notification-delivery/devices', async (req) =>
    service.devices(await authenticate(db, req)),
  );
  app.post('/v1/notification-delivery/devices', async (req) => {
    const p = await authenticate(db, req);
    if (!req.cookies.ao_session)
      throw new AppError(403, 'SESSION_REQUIRED', 'Use a browser session to register a device.');
    return service.register(p, digest(req.cookies.ao_session), deviceRegistration.parse(req.body));
  });
  app.delete('/v1/notification-delivery/devices/:id', async (req) =>
    service.revoke(await authenticate(db, req), z.object({ id: z.uuid() }).parse(req.params).id),
  );
  app.put('/v1/notification-delivery/scopes', async (req) =>
    service.scope(await authenticate(db, req), scopedDeliveryPreference.parse(req.body)),
  );
  app.get('/v1/notification-delivery/scopes', async (req) => {
    const p = await authenticate(db, req);
    const query = z
      .object({
        scope: z.enum(['conversation', 'thread', 'agent']).optional(),
        resourceId: z.uuid().optional(),
      })
      .parse(req.query);
    return db.query(
      'SELECT scope,resource_id,mode FROM notification_scope_preferences WHERE workspace_id=$1 AND membership_id=$2 AND ($3::text IS NULL OR scope=$3) AND ($4::uuid IS NULL OR resource_id=$4) ORDER BY scope,resource_id LIMIT 500',
      [p.workspaceId, p.membershipId, query.scope ?? null, query.resourceId ?? null],
    );
  });
  app.get('/v1/notification-delivery/history', async (req) =>
    service.history(
      await authenticate(db, req),
      z.object({ before: z.uuid().optional() }).parse(req.query).before,
    ),
  );
  app.post(
    '/v1/notification-delivery/receipts',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const input = z
        .object({
          workspaceId: z.uuid(),
          deliveryId: z.uuid(),
          token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          state: z.enum(['received', 'opened']),
        })
        .strict()
        .parse(req.body);
      await workerScope(input.workspaceId, () =>
        db.query(
          "UPDATE notification_deliveries SET received_at=coalesce(received_at,now()),opened_at=CASE WHEN $4='opened' THEN coalesce(opened_at,now()) ELSE opened_at END,state=CASE WHEN $4='opened' OR state='opened' THEN 'opened' ELSE 'received' END WHERE workspace_id=$1 AND receipt_hash=$2 AND deadline>now() AND state IN ('sending','sent','received','opened') AND EXISTS(SELECT 1 FROM notification_deliveries anchor WHERE anchor.workspace_id=$1 AND anchor.id=$3 AND anchor.receipt_hash=$2)",
          [input.workspaceId, digest(input.token), input.deliveryId, input.state],
        ),
      );
      return { ok: true };
    },
  );
}
