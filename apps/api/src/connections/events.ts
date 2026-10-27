import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import {
  dispatcherScope,
  scopedDatabase,
  workerScope,
  type Database,
  type Sql,
} from '@ao/database';
import { messageInput } from '@ao/contracts';
import { z } from 'zod';
import type { Identity } from '../lib/policy.js';
import type { IdentitySecrets } from '../identity/secrets.js';
import { connectionActor, type ConnectionService } from './service.js';
import { currentNativeHook } from './native-events.js';
import { AppError } from '../lib/errors.js';
import { sendMessage } from '../messaging/send.js';
import { webhookSignature, type WakeupSender } from '../agents/webhooks.js';
export const connectionEvent = z.discriminatedUnion('kind', [
  z
    .object({
      eventId: z.string().min(1).max(250),
      kind: z.literal('resource.changed'),
      operation: z.string().min(1).max(100),
      resource: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      eventId: z.string().min(1).max(250),
      kind: z.literal('resource.deleted'),
      resource: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      eventId: z.string().min(1).max(250),
      kind: z.literal('email.received'),
      from: z.email(),
      subject: z.string().max(500),
      body: z.string().min(1).max(16000),
      authentication: z.literal('dkim-pass'),
    })
    .strict(),
]);
export const hookContext = (workspace: string, id: string, direction: 'incoming' | 'outgoing') =>
  `connection-hook:${workspace}:${id}:${direction}`;
export function eventSignature(secret: string, timestamp: string, body: Buffer | string) {
  return createHmac('sha256', secret)
    .update(timestamp + '.')
    .update(body)
    .digest('hex');
}
export function verifyEvent(
  secret: string,
  timestamp: string,
  signature: string,
  body: Buffer,
  now = Date.now(),
) {
  if (
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 300000 ||
    !/^\w{64}$/.test(signature)
  )
    return false;
  const expected = Buffer.from(eventSignature(secret, timestamp, body), 'hex'),
    actual = Buffer.from(signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function currentConnectionOwner(tx: Sql, workspace: string, id: string) {
  const [row] = await tx.query(
    "SELECT c.*,m.name owner_name,m.role owner_role,m.permissions owner_permissions FROM connections c JOIN memberships m ON m.workspace_id=c.workspace_id AND m.id=c.owner_id WHERE c.workspace_id=$1 AND c.id=$2 AND c.state='connected' AND c.credential_expires_at>now() AND connection_authority_current(c.workspace_id,c.id) AND m.status='active' AND m.kind='human' AND m.access_type='member'",
    [workspace, id],
  );
  if (!row)
    throw new AppError(409, 'CONNECTION_AUTHORITY_REVOKED', 'The connection is no longer active.');
  const p: Identity = {
    workspaceId: workspace,
    membershipId: String(row.owner_id),
    kind: 'human',
    accessType: 'member',
    role: row.owner_role as Identity['role'],
    name: String(row.owner_name),
    permissions: row.owner_permissions as NonNullable<Identity['permissions']>,
  };
  const authority = await connectionActor(tx, p);
  if (authority.auth !== row.auth_version || authority.policy !== row.policy_version)
    throw new AppError(409, 'CONNECTION_AUTHORITY_REVOKED', 'The connection owner must reconnect.');
  return p;
}
interface EventRow extends Record<string, unknown> {
  protocol: string;
  native_hook_version: number | null;
  id: string;
  workspace_id: string;
  connection_id: string;
  payload: unknown;
  lease: string;
  attempts: number;
}
export class ConnectionEventWorker {
  private busy = false;
  private stopped = false;
  private active: Promise<void> | undefined;
  constructor(
    private db: Database,
    private service: ConnectionService,
    private secrets: IdentitySecrets,
    private send: WakeupSender,
    private onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  start(interval = 2000) {
    const timer = setInterval(() => {
      if (!this.busy && !this.stopped)
        this.active = this.tick().catch(() => this.onError('CONNECTOR_EVENT_WORKER_FAILED'));
    }, interval);
    timer.unref();
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      await this.active;
    };
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const tenant of await dispatcherScope(() =>
        this.db.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id'),
      )) {
        if (this.stopped) break;
        await workerScope(tenant.id, async () => {
          await this.db.query(
            "UPDATE connections SET state='reconnect_required',last_error_code='CREDENTIAL_EXPIRED' WHERE state='connected' AND credential_expires_at<=now()",
          );
          await this.db.query(
            "DELETE FROM connection_secrets s WHERE EXISTS(SELECT 1 FROM connections c WHERE c.workspace_id=s.workspace_id AND c.id=s.connection_id AND (c.state='revoked' OR c.credential_expires_at<=now()))",
          );
          await this.db.query('DELETE FROM connection_oauth_states WHERE expires_at<=now()');
          await this.db.query(
            "UPDATE connection_native_hooks SET enabled=false,encrypted_secret='',version=version+1 WHERE enabled AND expires_at<=now()",
          );
          await this.db.query(
            "UPDATE connection_events SET state='dead',error_code='EVENT_EXPIRED',payload='{}' WHERE state IN ('pending','leased') AND expires_at<=now()",
          );
          await this.db.query(
            "DELETE FROM connection_events WHERE created_at<now()-interval '30 days'",
          );
          for (let slot = 0; slot < 5 && !this.stopped; slot++) {
            const [event] = await this.db.query<EventRow>(
              `WITH due AS (SELECT id FROM connection_events WHERE expires_at>now() AND available_at<=now() AND (state='pending' OR state='leased' AND lease_until<now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE connection_events e SET state='leased',lease=$1,lease_until=now()+interval '60 seconds',attempts=attempts+1 FROM due WHERE e.id=due.id RETURNING e.*`,
              [randomUUID()],
            );
            if (!event) break;
            await this.process(event);
          }
          await this.deliver(tenant.id);
        });
      }
    } finally {
      this.busy = false;
    }
  }
  private async process(event: EventRow) {
    try {
      const input = connectionEvent.parse(event.payload);
      const [subscription] = await this.db.query(
        'SELECT subscriptions FROM connections WHERE workspace_id=$1 AND id=$2',
        [event.workspace_id, event.connection_id],
      );
      if (
        !(subscription?.subscriptions as string[]).includes(
          (event.protocol === 'native' ? 'native:' : 'bridge:') + input.kind,
        )
      )
        throw new AppError(409, 'EVENT_NOT_SUBSCRIBED', 'This subscription was revoked.');
      const p = await this.db.transaction((tx) =>
        currentConnectionOwner(tx, event.workspace_id, event.connection_id),
      );
      const eventGuard = async (tx: Sql) => {
        const [leased] = await tx.query(
          "SELECT 1 FROM connection_events WHERE workspace_id=$1 AND id=$2 AND state='leased' AND lease=$3 AND lease_until>now() FOR SHARE",
          [event.workspace_id, event.id, event.lease],
        );
        if (!leased)
          throw new AppError(
            409,
            'EVENT_LEASE_LOST',
            'The event lease expired or another worker claimed it.',
          );
        if (event.protocol === 'native')
          await currentNativeHook(
            tx,
            event.workspace_id,
            event.connection_id,
            Number(event.native_hook_version),
          );
      };
      await this.db.transaction(eventGuard);
      let confirmedDeletion = input.kind === 'resource.deleted';
      let observedVersion: number | null = null,
        observedFetched: string | null = null;
      if (
        input.kind === 'resource.changed' ||
        (event.protocol === 'native' && input.kind === 'resource.deleted')
      ) {
        const [resource] = await this.db.query(
          'SELECT conversation_id,operation,retained_until,version,fetched_at::text fetched FROM connection_resources WHERE workspace_id=$1 AND connection_id=$2 AND external_id=$3 AND deleted_at IS NULL AND retained_until>now()',
          [event.workspace_id, event.connection_id, input.resource],
        );
        if (
          !resource ||
          (input.kind === 'resource.changed' && resource.operation !== input.operation)
        )
          throw new AppError(
            409,
            'EVENT_RESOURCE_NOT_GRANTED',
            'Events can only refresh an already imported resource.',
          );
        if (event.protocol === 'native') {
          observedVersion = Number(resource.version);
          observedFetched = String(resource.fetched);
        }
        try {
          await this.service.read(
            p,
            event.connection_id,
            {
              operation: String(resource.operation),
              resource: input.resource,
              ...(resource.conversation_id
                ? { conversationId: String(resource.conversation_id) }
                : {}),
              retentionDays: 30,
            },
            resource.retained_until as string | Date,
            eventGuard,
          );
          confirmedDeletion = false;
          if (input.kind === 'resource.deleted' && event.protocol === 'native')
            throw new AppError(
              409,
              'NATIVE_DELETION_UNCONFIRMED',
              'The provider still returns this resource. Retry reconciliation without erasing it.',
            );
        } catch (error) {
          if (
            input.kind === 'resource.deleted' &&
            event.protocol === 'native' &&
            error instanceof AppError &&
            error.code === 'PROVIDER_RESOURCE_NOT_FOUND'
          )
            confirmedDeletion = true;
          else throw error;
        }
      }
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [event.workspace_id]);
        await currentConnectionOwner(tx, event.workspace_id, event.connection_id);
        await eventGuard(tx);
        const [job] = await tx.query(
          "SELECT id FROM connection_events WHERE workspace_id=$1 AND id=$2 AND state='leased' AND lease=$3 AND lease_until>now() FOR UPDATE",
          [event.workspace_id, event.id, event.lease],
        );
        if (!job) return;
        if (input.kind === 'resource.deleted' && confirmedDeletion)
          await tx.query(
            "UPDATE connection_resources SET deleted_at=now(),body='',title='Removed resource',version=version+1 WHERE workspace_id=$1 AND connection_id=$2 AND external_id=$3 AND ($4::integer IS NULL OR version=$4 AND fetched_at=$5::timestamptz)",
            [
              event.workspace_id,
              event.connection_id,
              input.resource,
              observedVersion,
              observedFetched,
            ],
          );
        if (input.kind === 'email.received') {
          const [hook] = await tx.query(
            'SELECT w.*,m.name,m.permissions,m.status FROM connection_webhooks w JOIN memberships m ON m.workspace_id=w.workspace_id AND m.id=w.email_actor_id WHERE w.workspace_id=$1 AND w.connection_id=$2 AND w.enabled FOR SHARE OF w,m',
            [event.workspace_id, event.connection_id],
          );
          if (
            !hook ||
            hook.status !== 'active' ||
            !(hook.email_senders as string[]).includes(input.from.toLowerCase())
          )
            throw new AppError(
              409,
              'EMAIL_SENDER_DENIED',
              'The verified sender or destination is not allowed.',
            );
          const actor: Identity = {
            workspaceId: event.workspace_id,
            membershipId: String(hook.email_actor_id),
            kind: 'agent',
            accessType: 'service',
            role: 'member',
            name: String(hook.name),
            permissions: hook.permissions as NonNullable<Identity['permissions']>,
          };
          await sendMessage(
            tx,
            actor,
            String(hook.email_channel_id),
            messageInput.parse({
              clientId: event.id,
              body: `External email from ${input.from}\n${input.subject}\n\n${input.body}`,
            }),
          );
        }
        await tx.query(
          "UPDATE connection_events SET state='completed',completed_at=now(),payload=$4,lease=NULL,lease_until=NULL,error_code=NULL WHERE workspace_id=$1 AND id=$2 AND lease=$3",
          [
            event.workspace_id,
            event.id,
            event.lease,
            JSON.stringify(
              input.kind === 'email.received'
                ? { eventId: input.eventId, kind: input.kind, redacted: true }
                : input,
            ),
          ],
        );
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'EVENT_PROCESSING_FAILED';
      await this.db.query(
        "UPDATE connection_events SET state=CASE WHEN attempts>=8 OR $4 IN ('EVENT_RESOURCE_NOT_GRANTED','CONNECTION_AUTHORITY_REVOKED','EMAIL_SENDER_DENIED','RESOURCE_RETENTION_EXPIRED','EVENT_NOT_SUBSCRIBED') THEN 'dead' ELSE 'pending' END,error_code=$4,available_at=now()+least(3600,power(2,least(attempts,10))*5)::integer*interval '1 second',lease=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2 AND lease=$3",
        [event.workspace_id, event.id, event.lease, code],
      );
    }
  }
  private async deliver(workspace: string) {
    const [job] = await this.db.query<Record<string, unknown>>(
      `WITH due AS(SELECT id FROM connection_deliveries WHERE available_at<=now() AND (state='pending' OR state='sending' AND lease_until<now()) ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE connection_deliveries d SET state='sending',lease=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1 FROM due WHERE d.id=due.id RETURNING d.*`,
      [randomUUID()],
    );
    if (!job) return;
    try {
      const hook = await this.db.transaction(async (tx) => {
        await currentConnectionOwner(tx, workspace, String(job.connection_id));
        const [row] = await tx.query(
          "SELECT w.endpoint,w.encrypted_outgoing,e.kind FROM connection_webhooks w JOIN connection_events e ON e.workspace_id=w.workspace_id AND e.connection_id=w.connection_id WHERE w.workspace_id=$1 AND w.connection_id=$2 AND w.enabled AND w.version=$3 AND w.endpoint IS NOT NULL AND e.id=$4 AND e.state='completed' AND e.expires_at>now()",
          [workspace, job.connection_id, job.webhook_version, job.event_id],
        );
        if (!row) throw new Error('Delivery superseded.');
        return row;
      });
      const id = String(job.id),
        timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
          id,
          eventId: job.event_id,
          connectionId: job.connection_id,
          kind: hook.kind,
          status: 'completed',
        }),
        secret = this.secrets.open(
          hookContext(workspace, String(job.connection_id), 'outgoing'),
          String(hook.encrypted_outgoing),
        );
      const status = await this.send(
        String(hook.endpoint),
        {
          'content-type': 'application/json',
          'x-orbit-id': id,
          'x-orbit-timestamp': timestamp,
          'x-orbit-signature': webhookSignature(secret, id, timestamp, body),
          'idempotency-key': id,
        },
        body,
      );
      if (status < 200 || status >= 300) throw new Error('Delivery failed.');
      await this.db.query(
        "UPDATE connection_deliveries SET state='completed',lease=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2 AND lease=$3",
        [workspace, job.id, job.lease],
      );
    } catch {
      await this.db.query(
        "UPDATE connection_deliveries SET state=CASE WHEN attempts>=8 THEN 'dead' ELSE 'pending' END,error_code='DELIVERY_FAILED_OR_REVOKED',available_at=now()+least(3600,power(2,least(attempts,10))*5)::integer*interval '1 second',lease=NULL,lease_until=NULL WHERE workspace_id=$1 AND id=$2 AND lease=$3",
        [workspace, job.id, job.lease],
      );
    }
  }
}
