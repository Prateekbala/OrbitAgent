import { createHash, randomBytes } from 'node:crypto';
import { workerScope, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { ownedConnection } from '../connections/service.js';
import { currentConnectionOwner } from '../connections/events.js';
import {
  nativeEvent,
  nativeEventProviders,
  nativeHookContext,
  type NativeEventProvider,
} from '../connections/native-events.js';
import type { IdentitySecrets } from '../identity/secrets.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
const key = (value: unknown) => z.object({ id: z.uuid() }).parse(value).id;
export function connectionNativeEventRoutes(
  app: FastifyInstance,
  db: Database,
  secrets: IdentitySecrets,
) {
  app.put('/v1/connections/:id/native-webhook', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = z
        .object({
          secret: z
            .string()
            .min(16)
            .max(500)
            .regex(/^[^\r\n]+$/)
            .optional(),
          events: z
            .array(z.enum(['resource.changed', 'resource.deleted']))
            .min(1)
            .max(2)
            .default(['resource.changed', 'resource.deleted']),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const c = await ownedConnection(tx, p, id);
      await currentConnectionOwner(tx, p.workspaceId, id);
      if (!nativeEventProviders.includes(c.provider as NativeEventProvider))
        throw new AppError(
          409,
          'NATIVE_EVENTS_UNAVAILABLE',
          'This provider has no implemented native signature adapter.',
        );
      if (c.provider === 'github' && input.secret)
        throw new AppError(
          400,
          'GENERATED_SECRET_REQUIRED',
          'GitHub webhook secrets are generated here and expire within 30 days.',
        );
      if (c.provider !== 'github' && !input.secret)
        throw new AppError(
          400,
          'PROVIDER_SIGNING_SECRET_REQUIRED',
          'Supply the signing secret shown by the provider.',
        );
      if (
        c.provider === 'gitlab' &&
        (!/^whsec_[A-Za-z0-9+/]+=*$/.test(input.secret!) ||
          Buffer.from(input.secret!.slice(6), 'base64').length < 32)
      )
        throw new AppError(
          400,
          'SIGNING_TOKEN_REQUIRED',
          'Use the GitLab signing token, not its legacy secret token.',
        );
      if (c.provider === 'stripe' && !input.secret!.startsWith('whsec_'))
        throw new AppError(
          400,
          'SIGNING_TOKEN_REQUIRED',
          'Use the Stripe endpoint signing secret.',
        );
      const secret = input.secret ?? randomBytes(32).toString('base64url');
      const [row] = await tx.query(
        "INSERT INTO connection_native_hooks(workspace_id,connection_id,provider,encrypted_secret,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days') ON CONFLICT(workspace_id,connection_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret,version=connection_native_hooks.version+1,enabled=true,expires_at=EXCLUDED.expires_at RETURNING version,expires_at",
        [p.workspaceId, id, c.provider, secrets.seal(nativeHookContext(p.workspaceId, id), secret)],
      );
      await tx.query(
        "UPDATE connections SET subscriptions=ARRAY(SELECT s FROM unnest(subscriptions) s WHERE s NOT LIKE 'native:%')||$3::text[] WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id, input.events.map((e) => 'native:' + e)],
      );
      await recordChange(tx, p, 'connection.native_webhook_configured', id, null, p.membershipId);
      return {
        version: row!.version,
        expiresAt: row!.expires_at,
        incomingPath: `/api/v1/connection-native-events/${p.workspaceId}/${id}`,
        provider: c.provider,
        ...(c.provider === 'github' ? { incomingSecret: secret } : {}),
        providerSetupRequired: true,
      };
    });
  });
  app.get('/v1/connections/:id/native-webhook', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    await db.transaction((tx) => ownedConnection(tx, p, id));
    const [row] = await db.query(
      'SELECT provider,enabled,version,expires_at FROM connection_native_hooks WHERE workspace_id=$1 AND connection_id=$2',
      [p.workspaceId, id],
    );
    return row ?? null;
  });
  app.delete('/v1/connections/:id/native-webhook', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    return db.transaction(async (tx) => {
      await ownedConnection(tx, p, id);
      await tx.query(
        "UPDATE connection_native_hooks SET enabled=false,encrypted_secret='',version=version+1 WHERE workspace_id=$1 AND connection_id=$2",
        [p.workspaceId, id],
      );
      await tx.query(
        "UPDATE connections SET subscriptions=ARRAY(SELECT s FROM unnest(subscriptions) s WHERE s NOT LIKE 'native:%') WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      );
      await recordChange(tx, p, 'connection.native_webhook_revoked', id, null, p.membershipId);
      return { ok: true };
    });
  });
  app.register(async (receiver) => {
    receiver.removeContentTypeParser('application/json');
    receiver.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    receiver.post(
      '/v1/connection-native-events/:workspace/:connection',
      { bodyLimit: 262144, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const params = z.object({ workspace: z.uuid(), connection: z.uuid() }).parse(req.params),
          raw = req.body;
        if (!Buffer.isBuffer(raw))
          throw new AppError(400, 'SIGNED_BODY_REQUIRED', 'Send the provider’s signed JSON bytes.');
        return workerScope(params.workspace, () =>
          db.transaction(async (tx) => {
            await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [params.workspace]);
            const [hook] = await tx.query(
              'SELECT * FROM connection_native_hooks WHERE workspace_id=$1 AND connection_id=$2 AND enabled AND expires_at>now() FOR UPDATE',
              [params.workspace, params.connection],
            );
            if (!hook)
              throw new AppError(
                401,
                'INVALID_EVENT_SIGNATURE',
                'The native event endpoint is unavailable.',
              );
            await currentConnectionOwner(tx, params.workspace, params.connection);
            const event = nativeEvent(
              hook.provider as NativeEventProvider,
              secrets.open(
                nativeHookContext(params.workspace, params.connection),
                String(hook.encrypted_secret),
              ),
              req.headers,
              raw,
            );
            if (!event) return reply.code(202).send({ accepted: true, ignored: true });
            const [connection] = await tx.query(
              'SELECT subscriptions FROM connections WHERE workspace_id=$1 AND id=$2',
              [params.workspace, params.connection],
            );
            if (!(connection!.subscriptions as string[]).includes('native:' + event.kind))
              throw new AppError(403, 'EVENT_NOT_SUBSCRIBED', 'This event kind is not subscribed.');
            const [resource] = await tx.query(
              'SELECT operation FROM connection_resources WHERE workspace_id=$1 AND connection_id=$2 AND external_id=$3 AND deleted_at IS NULL AND retained_until>now()',
              [params.workspace, params.connection, event.resource],
            );
            if (!resource) return reply.code(202).send({ accepted: true, ignored: true });
            if (event.kind === 'resource.changed' && resource.operation !== event.operation)
              throw notFound();
            const hash = createHash('sha256').update(raw).digest('hex');
            const [old] = await tx.query(
              "SELECT payload_hash FROM connection_events WHERE workspace_id=$1 AND connection_id=$2 AND (provider_event_id=$3 OR protocol='native' AND native_hook_version=$4 AND payload_hash=$5)",
              [params.workspace, params.connection, event.eventId, hook.version, hash],
            );
            if (old) {
              if (old.payload_hash !== hash)
                throw new AppError(
                  409,
                  'EVENT_ID_CONFLICT',
                  'This delivery ID was used with different bytes.',
                );
              return reply.code(202).send({ accepted: true, duplicate: true });
            }
            const [inserted] = await tx.query(
              "INSERT INTO connection_events(workspace_id,connection_id,provider_event_id,kind,payload,payload_hash,protocol,native_hook_version) VALUES($1,$2,$3,$4,$5,$6,'native',$7) ON CONFLICT(workspace_id,connection_id,provider_event_id) DO UPDATE SET payload_hash=connection_events.payload_hash WHERE connection_events.payload_hash=EXCLUDED.payload_hash RETURNING id",
              [
                params.workspace,
                params.connection,
                event.eventId,
                event.kind,
                JSON.stringify(event),
                hash,
                hook.version,
              ],
            );
            if (!inserted)
              throw new AppError(
                409,
                'EVENT_ID_CONFLICT',
                'This delivery ID was used with different bytes.',
              );
            return reply.code(202).send({ accepted: true, duplicate: false });
          }),
        );
      },
    );
  });
}
