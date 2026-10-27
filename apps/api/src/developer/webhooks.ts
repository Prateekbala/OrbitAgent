import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  dispatcherScope,
  workerScope,
  scopedDatabase,
  type Database,
  type Sql,
} from '@ao/database';
import type { FastifyInstance } from 'fastify';
import type { IdentitySecrets } from '../identity/secrets.js';
import { authenticate } from '../modules/auth.js';
import { browserDeveloper, credentialOwner } from './auth.js';
import { requireConversation, type Identity } from '../lib/policy.js';
import { hasPermission } from '../identity/authorization.js';
import { AppError, notFound } from '../lib/errors.js';
import { workAuthority } from '../workflows/service.js';
import { recordChange } from '../lib/events.js';
import { validateWebhookUrl, webhookSignature, type WakeupSender } from '../agents/webhooks.js';
const events = [
  'message.created',
  'message.updated',
  'message.deleted',
  'task.created',
  'task.updated',
  'task.transitioned',
  'task.comment_created',
  'knowledge.created',
  'knowledge.updated',
  'run.generated',
  'automation.escalated',
] as const;
const input = z
  .object({
    name: z.string().trim().min(2).max(100),
    url: z.url().max(2048),
    conversationIds: z.array(z.uuid()).min(1).max(100),
    events: z.array(z.enum(events)).min(1).max(events.length),
  })
  .strict();
type Row = Record<string, unknown>;
async function visible(tx: Sql, p: Identity, w: Row, e: Row) {
  if (
    !(w.conversation_ids as string[]).includes(String(e.conversation_id)) ||
    !(w.event_types as string[]).includes(String(e.event_type)) ||
    (e.audience_membership_id && e.audience_membership_id !== p.membershipId)
  )
    return false;
  const permission = String(e.event_type).startsWith('task.')
    ? 'tasks.read'
    : String(e.event_type).startsWith('knowledge.')
      ? 'knowledge.read'
      : String(e.event_type).startsWith('run.') || String(e.event_type).startsWith('automation.')
        ? 'execution.read'
        : 'messages.read';
  if (!hasPermission(p, permission)) return false;
  await tx.query('SET LOCAL ROLE ao_runtime');
  const [c] = await tx.query('SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2', [
    p.workspaceId,
    e.conversation_id,
  ]);
  if (!c) return false;
  if (String(e.event_type).startsWith('message.'))
    return Boolean(
      (
        await tx.query('SELECT id FROM messages WHERE workspace_id=$1 AND id=$2', [
          p.workspaceId,
          e.resource_id,
        ])
      )[0],
    );
  if (String(e.event_type).startsWith('task.'))
    return Boolean(
      (
        await tx.query(
          "SELECT id FROM tasks WHERE workspace_id=$1 AND id=CASE WHEN $3='task.comment_created' THEN (SELECT task_id FROM task_comments WHERE workspace_id=$1 AND id=$2) ELSE $2::uuid END",
          [p.workspaceId, e.resource_id, e.event_type],
        )
      )[0],
    );
  if (String(e.event_type).startsWith('knowledge.'))
    return Boolean(
      (
        await tx.query('SELECT id FROM knowledge_pages WHERE workspace_id=$1 AND id=$2', [
          p.workspaceId,
          e.resource_id,
        ])
      )[0],
    );
  return true;
}
export function developerWebhookRoutes(
  app: FastifyInstance,
  db: Database,
  secrets: IdentitySecrets,
  hosts: string[],
) {
  app.get('/v1/developer/webhooks', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    return db.query(
      'SELECT id,name,url,conversation_ids,event_types,version,enabled,created_at FROM developer_webhooks WHERE workspace_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 100',
      [p.workspaceId, p.membershipId],
    );
  });
  app.post('/v1/developer/webhooks', async (req, reply) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const v = input.parse(req.body),
      id = randomUUID(),
      secret = randomBytes(32).toString('base64url');
    await validateWebhookUrl(v.url, hosts);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      for (const c of v.conversationIds) await requireConversation(tx, p, c, true);
      const a = await workAuthority(tx, p),
        [count] = await tx.query(
          'SELECT count(*)::int count FROM developer_webhooks WHERE workspace_id=$1 AND owner_id=$2',
          [p.workspaceId, p.membershipId],
        );
      if (Number(count?.count) >= 100)
        throw new AppError(429, 'WEBHOOK_LIMIT', 'This account has reached its webhook limit.');
      await tx.query(
        'INSERT INTO developer_webhooks(id,workspace_id,owner_id,name,url,encrypted_secret,conversation_ids,event_types,auth_version,policy_version,cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT coalesce(max(id),0) FROM outbox_events WHERE workspace_id=$2))',
        [
          id,
          p.workspaceId,
          p.membershipId,
          v.name,
          v.url,
          secrets.seal('developer-webhook:' + p.workspaceId + ':' + id, secret),
          v.conversationIds,
          v.events,
          a.auth,
          a.policy,
        ],
      );
      await recordChange(tx, p, 'developer.webhook_created', id, null, p.membershipId);
    });
    return reply.code(201).send({ id, secret, version: 1 });
  });
  app.post('/v1/developer/webhooks/:id/control', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const id = z.uuid().parse((req.params as { id: string }).id),
      v = z
        .object({
          version: z.number().int().positive(),
          action: z.enum(['pause', 'resume', 'rotate']),
        })
        .strict()
        .parse(req.body),
      secret = v.action === 'rotate' ? randomBytes(32).toString('base64url') : null;
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const [w] = await tx.query(
        'SELECT * FROM developer_webhooks WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 FOR UPDATE',
        [p.workspaceId, id, p.membershipId],
      );
      if (!w) throw notFound();
      if (w.version !== v.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'The webhook changed.');
      for (const c of w.conversation_ids as string[]) await requireConversation(tx, p, c, true);
      const a = await workAuthority(tx, p);
      await tx.query(
        'UPDATE developer_webhooks SET enabled=$3,version=version+1,auth_version=$4,policy_version=$5,encrypted_secret=coalesce($6,encrypted_secret),cursor=CASE WHEN $3 THEN (SELECT coalesce(max(id),0) FROM outbox_events WHERE workspace_id=$1) ELSE cursor END WHERE workspace_id=$1 AND id=$2',
        [
          p.workspaceId,
          id,
          v.action !== 'pause',
          a.auth,
          a.policy,
          secret ? secrets.seal('developer-webhook:' + p.workspaceId + ':' + id, secret) : null,
        ],
      );
      await tx.query(
        "UPDATE developer_deliveries SET state='cancelled',lease_token=NULL WHERE workspace_id=$1 AND webhook_id=$2 AND state IN ('pending','sending')",
        [p.workspaceId, id],
      );
      return { version: v.version + 1, ...(secret ? { secret } : {}) };
    });
  });
  app.get('/v1/developer/webhooks/:id/deliveries', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const id = z.uuid().parse((req.params as { id: string }).id),
      q = z
        .object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .strict()
        .parse(req.query),
      rows = await db.query(
        'SELECT id,state,attempts,error_code,available_at,delivered_at,created_at FROM developer_deliveries WHERE workspace_id=$1 AND webhook_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',
        [p.workspaceId, id, q.after ?? null, q.limit + 1],
      );
    return {
      items: rows.slice(0, q.limit),
      next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
  app.post('/v1/developer/deliveries/:id/replay', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const id = z.uuid().parse((req.params as { id: string }).id),
      [r] = await db.query(
        "UPDATE developer_deliveries d SET state='pending',attempts=0,available_at=now(),error_code=NULL WHERE d.workspace_id=$1 AND d.id=$2 AND d.state='dead' AND EXISTS(SELECT 1 FROM developer_webhooks w WHERE w.workspace_id=d.workspace_id AND w.id=d.webhook_id AND w.owner_id=$3 AND w.enabled AND w.version=d.webhook_version) RETURNING id",
        [p.workspaceId, id, p.membershipId],
      );
    if (!r)
      throw new AppError(
        409,
        'DELIVERY_UNAVAILABLE',
        'Only a current dead-letter delivery may be replayed.',
      );
    return { ok: true };
  });
}
export class DeveloperWebhookWorker {
  private db: Database;
  private active: Promise<void> | null = null;
  constructor(
    db: Database,
    private secrets: IdentitySecrets,
    private send: WakeupSender,
    private onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    if (!this.active)
      this.active = this.sweep().finally(() => {
        this.active = null;
      });
    return this.active;
  }
  private async sweep() {
    for (const space of await dispatcherScope(() =>
      this.db.query('SELECT id FROM workspaces ORDER BY id'),
    ))
      await workerScope(String(space.id), async () => {
        const ws = String(space.id);
        await this.db.query(
          "UPDATE developer_deliveries SET state=CASE WHEN attempts>=8 THEN 'dead' ELSE 'pending' END,lease_token=NULL WHERE workspace_id=$1 AND state='sending' AND lease_expires_at<=now()",
          [ws],
        );
        const subscriptions = await this.db.query(
          'SELECT * FROM developer_webhooks WHERE workspace_id=$1 AND enabled ORDER BY id LIMIT 1000',
          [ws],
        );
        for (const w of subscriptions) {
          try {
            await this.db.transaction(async (tx) => {
              const [current] = await tx.query(
                'SELECT * FROM developer_webhooks WHERE workspace_id=$1 AND id=$2 AND enabled FOR UPDATE SKIP LOCKED',
                [ws, w.id],
              );
              if (!current) return;
              const p = await credentialOwner(tx, ws, String(current.owner_id), {
                auth: Number(current.auth_version),
                policy: Number(current.policy_version),
              });
              const rows = await tx.query(
                'SELECT * FROM outbox_events WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT 100',
                [ws, current.cursor],
              );
              for (const e of rows) {
                if (await visible(tx, p, current, e)) {
                  await tx.query('SET LOCAL ROLE ao_worker');
                  await tx.query(
                    'INSERT INTO developer_deliveries(id,workspace_id,webhook_id,webhook_version,event_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
                    [randomUUID(), ws, current.id, current.version, e.id],
                  );
                }
                await tx.query('SET LOCAL ROLE ao_worker');
              }
              if (rows.length)
                await tx.query(
                  'UPDATE developer_webhooks SET cursor=$3 WHERE workspace_id=$1 AND id=$2',
                  [ws, current.id, rows.at(-1)!.id],
                );
            });
          } catch {
            await this.db.query(
              'UPDATE developer_webhooks SET enabled=false,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$3',
              [ws, w.id, w.version],
            );
            this.onError('WEBHOOK_AUTHORITY_REVOKED');
          }
        }
        for (let i = 0; i < 5; i++) {
          const job = await this.db.transaction<(Row & { lease: string }) | null>(async (tx) => {
            const [d] = await tx.query(
              "SELECT d.*,w.url,w.encrypted_secret,w.owner_id,w.auth_version,w.policy_version,w.conversation_ids,w.event_types,e.event_type,e.resource_id,e.conversation_id,e.audience_membership_id FROM developer_deliveries d JOIN developer_webhooks w ON w.workspace_id=d.workspace_id AND w.id=d.webhook_id JOIN outbox_events e ON e.workspace_id=d.workspace_id AND e.id=d.event_id WHERE d.workspace_id=$1 AND d.state='pending' AND d.available_at<=now() AND w.enabled AND w.version=d.webhook_version ORDER BY d.available_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED",
              [ws],
            );
            if (!d) return null;
            await tx.query('SAVEPOINT delivery_auth');
            try {
              const p = await credentialOwner(tx, ws, String(d.owner_id), {
                auth: Number(d.auth_version),
                policy: Number(d.policy_version),
              });
              if (!(await visible(tx, p, d, d))) throw new Error('Audience revoked');
              await tx.query('SET LOCAL ROLE ao_worker');
            } catch {
              await tx.query('ROLLBACK TO SAVEPOINT delivery_auth');
              await tx.query(
                "UPDATE developer_deliveries SET state='cancelled',error_code='ACCESS_REVOKED' WHERE workspace_id=$1 AND id=$2",
                [ws, d.id],
              );
              return null;
            }
            const lease = randomUUID();
            await tx.query(
              "UPDATE developer_deliveries SET state='sending',attempts=attempts+1,lease_token=$3,lease_expires_at=now()+interval '30 seconds' WHERE workspace_id=$1 AND id=$2",
              [ws, d.id, lease],
            );
            return { ...d, lease };
          });
          if (!job) break;
          let ok = false;
          try {
            const [current] = await this.db.query(
              "SELECT 1 FROM developer_deliveries d JOIN developer_webhooks w ON w.workspace_id=d.workspace_id AND w.id=d.webhook_id WHERE d.workspace_id=$1 AND d.id=$2 AND d.lease_token=$3 AND d.state='sending' AND d.lease_expires_at>now() AND w.enabled AND w.version=d.webhook_version",
              [ws, job.id, job.lease],
            );
            if (!current) continue;
            await this.db.transaction(async (tx) => {
              const p = await credentialOwner(tx, ws, String(job.owner_id), {
                auth: Number(job.auth_version),
                policy: Number(job.policy_version),
              });
              if (!(await visible(tx, p, job, job))) throw new Error('Access changed');
            });
            const body = JSON.stringify({
                id: job.id,
                type: job.event_type,
                resourceId: job.resource_id,
                conversationId: job.conversation_id,
              }),
              timestamp = String(Math.floor(Date.now() / 1000)),
              secret = this.secrets.open(
                'developer-webhook:' + ws + ':' + String(job.webhook_id),
                String(job.encrypted_secret),
              );
            const status = await this.send(
              String(job.url),
              {
                'content-type': 'application/json',
                'webhook-id': String(job.id),
                'webhook-timestamp': timestamp,
                'webhook-signature':
                  'v1=' + webhookSignature(secret, String(job.id), timestamp, body),
              },
              body,
            );
            ok = status >= 200 && status < 300;
          } catch {
            this.onError('PUBLIC_WEBHOOK_DELIVERY_FAILED');
          }
          await this.db.query(
            "UPDATE developer_deliveries SET state=CASE WHEN $4 THEN 'delivered' WHEN attempts>=8 THEN 'dead' ELSE 'pending' END,delivered_at=CASE WHEN $4 THEN now() ELSE NULL END,error_code=CASE WHEN $4 THEN NULL ELSE 'DELIVERY_FAILED' END,available_at=now()+least(3600,15*power(2,attempts))*interval '1 second',lease_token=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='sending'",
            [ws, job.id, job.lease, ok],
          );
        }
      });
  }
  start() {
    const timer = setInterval(() => {
      void this.tick().catch(() => this.onError('PUBLIC_WEBHOOK_WORKER_FAILED'));
    }, 1000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.active;
    };
  }
}
