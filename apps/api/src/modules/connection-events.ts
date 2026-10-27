import { randomBytes, randomUUID } from 'node:crypto';
import { workerScope, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  connectionEvent,
  hookContext,
  verifyEvent,
  currentConnectionOwner,
} from '../connections/events.js';
import { ownedConnection } from '../connections/service.js';
import { validateWebhookUrl } from '../agents/webhooks.js';
import { authenticate } from './auth.js';
import { requireConversation } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { recordChange } from '../lib/events.js';
import type { IdentitySecrets } from '../identity/secrets.js';
export function connectionEventRoutes(
  app: FastifyInstance,
  db: Database,
  secrets: IdentitySecrets,
  hosts: string[] = [],
) {
  app.put('/v1/connections/:id/webhook', async (req) => {
    const p = await authenticate(db, req),
      id = z.uuid().parse((req.params as { id: string }).id),
      input = z
        .object({
          endpoint: z.url().max(1000).optional(),
          events: z
            .array(z.enum(['resource.changed', 'resource.deleted']))
            .min(1)
            .max(2)
            .default(['resource.changed', 'resource.deleted']),
          emailChannelId: z.uuid().optional(),
          emailSenders: z
            .array(z.email().transform((v) => v.toLowerCase()))
            .max(50)
            .default([]),
        })
        .strict()
        .parse(req.body);
    if (Boolean(input.emailChannelId) !== Boolean(input.emailSenders.length))
      throw new AppError(
        400,
        'EMAIL_ROUTE_REQUIRED',
        'Choose both an email channel and explicit allowed senders.',
      );
    if (input.endpoint) await validateWebhookUrl(input.endpoint, hosts);
    const incoming = randomBytes(32).toString('base64url'),
      outgoing = randomBytes(32).toString('base64url');
    return db.transaction(async (tx) => {
      await ownedConnection(tx, p, id);
      if (input.emailChannelId) {
        await requireConversation(tx, p, input.emailChannelId, true);
        const [channel] = await tx.query(
          "SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 AND kind='channel' AND archived_at IS NULL",
          [p.workspaceId, input.emailChannelId],
        );
        if (!channel)
          throw new AppError(
            400,
            'EMAIL_CHANNEL_REQUIRED',
            'Choose an active channel for email delivery.',
          );
      }
      const [old] = await tx.query(
        'SELECT email_actor_id FROM connection_webhooks WHERE workspace_id=$1 AND connection_id=$2',
        [p.workspaceId, id],
      );
      let actor = old?.email_actor_id as string | undefined;
      if (input.emailChannelId && !actor) {
        actor = randomUUID();
        await tx.query(
          "INSERT INTO memberships(id,workspace_id,name,kind,role,access_type,permissions) VALUES($1,$2,'External email','agent','member','service',$3)",
          [actor, p.workspaceId, JSON.stringify({ 'messages.read': true, 'messages.write': true })],
        );
      }
      if (actor) {
        await tx.query(
          'DELETE FROM conversation_members WHERE workspace_id=$1 AND membership_id=$2',
          [p.workspaceId, actor],
        );
        if (input.emailChannelId)
          await tx.query(
            'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id,history_from_sequence) SELECT $1,id,$3,next_sequence+1 FROM conversations WHERE workspace_id=$1 AND id=$2',
            [p.workspaceId, input.emailChannelId, actor],
          );
      }
      const [row] = await tx.query(
        'INSERT INTO connection_webhooks(workspace_id,connection_id,encrypted_incoming,encrypted_outgoing,endpoint,email_channel_id,email_actor_id,email_senders) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,connection_id) DO UPDATE SET encrypted_incoming=EXCLUDED.encrypted_incoming,encrypted_outgoing=EXCLUDED.encrypted_outgoing,endpoint=EXCLUDED.endpoint,email_channel_id=EXCLUDED.email_channel_id,email_actor_id=EXCLUDED.email_actor_id,email_senders=EXCLUDED.email_senders,version=connection_webhooks.version+1,enabled=true RETURNING version',
        [
          p.workspaceId,
          id,
          secrets.seal(hookContext(p.workspaceId, id, 'incoming'), incoming),
          secrets.seal(hookContext(p.workspaceId, id, 'outgoing'), outgoing),
          input.endpoint ?? null,
          input.emailChannelId ?? null,
          input.emailChannelId ? actor : null,
          input.emailSenders,
        ],
      );
      await tx.query(
        "UPDATE connections SET subscriptions=ARRAY(SELECT s FROM unnest(subscriptions) s WHERE s NOT LIKE 'bridge:%')||$3::text[] WHERE workspace_id=$1 AND id=$2",
        [
          p.workspaceId,
          id,
          [
            ...input.events.map((kind) => 'bridge:' + kind),
            ...(input.emailChannelId ? ['bridge:email.received'] : []),
          ],
        ],
      );
      await recordChange(tx, p, 'connection.webhook_configured', id, undefined, p.membershipId);
      return {
        version: row!.version,
        incomingPath: `/api/v1/connection-events/${p.workspaceId}/${id}`,
        incomingSecret: incoming,
        outgoingSecret: outgoing,
        protocol: 'orbit-bridge-v1',
        nativeProviderSignature: false,
      };
    });
  });
  app.delete('/v1/connections/:id/webhook', async (req) => {
    const p = await authenticate(db, req),
      id = z.uuid().parse((req.params as { id: string }).id);
    return db.transaction(async (tx) => {
      await ownedConnection(tx, p, id);
      await tx.query(
        'UPDATE connection_webhooks SET enabled=false,version=version+1 WHERE workspace_id=$1 AND connection_id=$2',
        [p.workspaceId, id],
      );
      return { ok: true };
    });
  });
  app.get('/v1/connections/:id/events', async (req) => {
    const p = await authenticate(db, req),
      id = z.uuid().parse((req.params as { id: string }).id),
      q = z
        .object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .strict()
        .parse(req.query);
    await db.transaction((tx) => ownedConnection(tx, p, id));
    const rows = await db.query(
      'SELECT id,provider_event_id,kind,state,attempts,available_at,error_code,created_at,completed_at FROM connection_events WHERE workspace_id=$1 AND connection_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',
      [p.workspaceId, id, q.after ?? null, q.limit + 1],
    );
    return {
      items: rows.slice(0, q.limit),
      next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
  app.post('/v1/connections/:id/events/:event/retry', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id: z.uuid(), event: z.uuid() }).parse(req.params);
    return db.transaction(async (tx) => {
      await ownedConnection(tx, p, params.id);
      await tx.query(
        "UPDATE connection_events SET state='pending',available_at=now(),lease=NULL,lease_until=NULL,attempts=0,error_code=NULL WHERE workspace_id=$1 AND connection_id=$2 AND id=$3 AND state='dead' AND expires_at>now()",
        [p.workspaceId, params.id, params.event],
      );
      return { queued: true };
    });
  });
  app.register(async (bridge) => {
    bridge.removeContentTypeParser('application/json');
    bridge.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    bridge.post(
      '/v1/connection-events/:workspace/:connection',
      { bodyLimit: 65536, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const params = z.object({ workspace: z.uuid(), connection: z.uuid() }).parse(req.params),
          raw = req.body as Buffer;
        if (!Buffer.isBuffer(raw))
          throw new AppError(400, 'SIGNED_BODY_REQUIRED', 'Send a signed JSON event.');
        const timestamp = String(req.headers['x-orbit-timestamp'] ?? ''),
          signature = String(req.headers['x-orbit-signature'] ?? '');
        return workerScope(params.workspace, () =>
          db.transaction(async (tx) => {
            const [hook] = await tx.query(
              'SELECT encrypted_incoming,email_senders,email_channel_id FROM connection_webhooks WHERE workspace_id=$1 AND connection_id=$2 AND enabled FOR SHARE',
              [params.workspace, params.connection],
            );
            if (
              !hook ||
              !verifyEvent(
                secrets.open(
                  hookContext(params.workspace, params.connection, 'incoming'),
                  String(hook.encrypted_incoming),
                ),
                timestamp,
                signature,
                raw,
              )
            )
              throw new AppError(
                401,
                'INVALID_EVENT_SIGNATURE',
                'The event signature is invalid or expired.',
              );
            await currentConnectionOwner(tx, params.workspace, params.connection);
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              throw new AppError(
                400,
                'INVALID_EVENT_JSON',
                'The signed event must contain valid JSON.',
              );
            }
            const input = connectionEvent.parse(parsed);
            const [subscription] = await tx.query(
              'SELECT subscriptions FROM connections WHERE workspace_id=$1 AND id=$2',
              [params.workspace, params.connection],
            );
            if (!(subscription?.subscriptions as string[]).includes('bridge:' + input.kind))
              throw new AppError(403, 'EVENT_NOT_SUBSCRIBED', 'This event kind is not subscribed.');
            if (
              input.kind === 'email.received' &&
              (!hook.email_channel_id ||
                !(hook.email_senders as string[]).includes(input.from.toLowerCase()))
            )
              throw new AppError(
                403,
                'EMAIL_SENDER_DENIED',
                'This sender is not allowed on the configured email route.',
              );
            const payload = JSON.stringify(input);
            const [old] = await tx.query(
              'SELECT payload_hash FROM connection_events WHERE workspace_id=$1 AND connection_id=$2 AND provider_event_id=$3',
              [params.workspace, params.connection, input.eventId],
            );
            if (old) {
              if (old.payload_hash !== digest(payload))
                throw new AppError(409, 'EVENT_ID_CONFLICT', 'This event ID was already used.');
              return reply.code(202).send({ accepted: true, duplicate: true });
            }
            const [inserted] = await tx.query(
              'INSERT INTO connection_events(workspace_id,connection_id,provider_event_id,kind,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,connection_id,provider_event_id) DO UPDATE SET payload_hash=connection_events.payload_hash WHERE connection_events.payload_hash=EXCLUDED.payload_hash RETURNING id',
              [
                params.workspace,
                params.connection,
                input.eventId,
                input.kind,
                payload,
                digest(payload),
              ],
            );
            if (!inserted)
              throw new AppError(409, 'EVENT_ID_CONFLICT', 'This event ID was already used.');
            return reply.code(202).send({ accepted: true, duplicate: false });
          }),
        );
      },
    );
  });
}
