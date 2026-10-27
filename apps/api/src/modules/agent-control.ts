import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import { id } from '@ao/contracts';
import {
  agentConfiguration,
  credentialInput,
  inboxLeaseInput,
  inboxResultInput,
} from '@ao/contracts/agents';
import { authenticate } from './auth.js';
import { currentAgent, fenceAgent, insertCredential, reviseAgent } from '../agents/control.js';
import { deliveryLease, expireInbox, leaseInbox } from '../agents/inbox.js';
import { lockAdministrator, type Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import type { HostedRuntime } from '../execution/types.js';
import type { IdentitySecrets } from '../identity/secrets.js';
import { validateWebhookUrl } from '../agents/webhooks.js';
import { token, digest } from '../lib/security.js';
const pathId = (params: unknown) => id.parse((params as { id: string }).id);
export function agentControlRoutes(
  app: FastifyInstance,
  db: Database,
  runtime: HostedRuntime,
  secrets: IdentitySecrets,
  webhookHosts: string[] = [],
) {
  app.get('/v1/agents/:id', async (req) => {
    const p = await authenticate(db, req),
      agentId = pathId(req.params);
    const [agent] = await db.query(
      'SELECT a.id,a.version,a.revision,a.status,a.owner_id,a.runtime,v.configuration FROM agents a JOIN agent_revisions v ON v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision WHERE a.workspace_id=$1 AND a.id=$2',
      [p.workspaceId, agentId],
    );
    if (!agent) throw notFound();
    const credentials =
      p.kind === 'human' && ['owner', 'admin'].includes(p.role)
        ? await db.query(
            'SELECT id,name,scopes,conversation_ids,expires_at,revoked_at,last_used_at,created_at FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 100',
            [p.workspaceId, agentId],
          )
        : [];
    const [health] = await db.query(
      "SELECT a.last_seen_at,(SELECT count(*)::int FROM agent_runs r WHERE r.workspace_id=a.workspace_id AND r.agent_id=a.id AND r.status IN ('queued','running','awaiting_approval','outcome_unknown')) open_runs,(SELECT count(*)::int FROM agent_inbox i WHERE i.workspace_id=a.workspace_id AND i.agent_id=a.id AND i.state IN ('pending','leased')) pending_deliveries,(SELECT count(*)::int FROM agent_inbox i WHERE i.workspace_id=a.workspace_id AND i.agent_id=a.id AND i.state='dead') dead_letters FROM agents a WHERE a.workspace_id=$1 AND a.id=$2",
      [p.workspaceId, agentId],
    );
    return {
      ...agent,
      credentials,
      health,
      runtime: {
        configured:
          agent.runtime === 'managed' ? runtime.configured : Boolean(health?.last_seen_at),
        capabilities:
          agent.runtime === 'managed'
            ? (runtime.capabilities ?? { checkpointRecovery: 'settled_results_only' })
            : { inboxLeases: true, signedWakeups: true, realtime: true, durableCheckpoints: false },
      },
    };
  });
  app.get('/v1/agents/:id/revisions', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      q = z.object({ after: z.coerce.number().int().positive().optional() }).parse(req.query);
    const rows = await db.query(
      'SELECT revision::text id,revision,configuration,created_at,created_by FROM agent_revisions WHERE workspace_id=$1 AND agent_id=$2 AND ($3::int IS NULL OR revision<$3) ORDER BY revision DESC LIMIT 31',
      [p.workspaceId, agent, q.after ?? null],
    );
    return { items: rows.slice(0, 30), next: rows.length > 30 ? String(rows[29]!.revision) : null };
  });
  app.post('/v1/agents/:id/revisions', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      input = z
        .object({ version: z.number().int().positive(), configuration: agentConfiguration })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      return reviseAgent(tx, p, agent, input.version, input.configuration);
    });
  });
  app.post('/v1/agents/:id/lifecycle', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      input = z
        .object({
          version: z.number().int().positive(),
          status: z.enum(['active', 'paused', 'archived']),
          ownerId: z.uuid().optional(),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      await fenceAgent(tx, p.workspaceId, agent);
      const current = await currentAgent(tx, p, agent, input.version);
      if (input.ownerId) {
        const [owner] = await tx.query(
          "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND kind='human' AND status='active' AND access_type='member' AND coalesce((permissions->>'agents.manage')::boolean,true)",
          [p.workspaceId, input.ownerId],
        );
        if (!owner)
          throw new AppError(
            400,
            'INVALID_OWNER',
            'Choose an active full member with agent management permission.',
          );
      }
      const transferring = Boolean(input.ownerId && input.ownerId !== current.owner_id);
      await tx.query(
        'UPDATE agents SET status=$3,credential_issuer_id=CASE WHEN $5 THEN NULL ELSE credential_issuer_id END,owner_id=coalesce($4,owner_id),version=version+1 WHERE workspace_id=$1 AND id=$2',
        [
          p.workspaceId,
          agent,
          transferring ? 'paused' : input.status,
          input.ownerId ?? null,
          transferring,
        ],
      );
      await recordChange(
        tx,
        p,
        transferring ? 'agent.transferred' : 'agent.' + input.status,
        agent,
      );
      return { ok: true };
    });
  });
  app.post('/v1/agents/:id/credentials', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      input = credentialInput.parse(req.body);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      const row = await currentAgent(tx, p, agent);
      if (row.runtime !== 'external' || row.status === 'archived')
        throw new AppError(
          409,
          'AGENT_UNAVAILABLE',
          'Credentials require an unarchived external agent.',
        );
      return insertCredential(tx, p, agent, input);
    });
  });
  app.get('/v1/agents/:id/credentials', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      q = z.object({ after: z.uuid().optional() }).parse(req.query);
    if (p.kind !== 'human' || !['owner', 'admin'].includes(p.role))
      throw new AppError(403, 'FORBIDDEN', 'Credential history requires an administrator.');
    const rows = await db.query(
      'SELECT id,name,scopes,conversation_ids,expires_at,revoked_at,last_used_at,created_at FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 AND id=$3)) ORDER BY created_at DESC,id DESC LIMIT 31',
      [p.workspaceId, agent, q.after ?? null],
    );
    return { items: rows.slice(0, 30), next: rows.length > 30 ? rows[29]!.id : null };
  });
  app.post('/v1/agents/:id/credentials/rotate', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      requested = req.body && Object.keys(req.body).length ? credentialInput.parse(req.body) : null;
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      await fenceAgent(tx, p.workspaceId, agent);
      const row = await currentAgent(tx, p, agent);
      if (row.runtime !== 'external' || row.status === 'archived') throw notFound();
      const [previous] = await tx.query(
        'SELECT name,scopes,conversation_ids,created_at,expires_at FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
        [p.workspaceId, agent],
      );
      if (!requested && !previous)
        throw new AppError(
          409,
          'CREDENTIAL_POLICY_REQUIRED',
          'Create a scoped credential before rotating this connection.',
        );
      const input =
        requested ??
        credentialInput.parse({
          name: previous!.name,
          scopes: previous!.scopes,
          conversationIds: previous!.conversation_ids,
          expiresInDays: Math.max(
            1,
            Math.min(
              90,
              Math.round(
                (new Date(previous!.expires_at as Date | string).getTime() -
                  new Date(previous!.created_at as Date | string).getTime()) /
                  86400000,
              ),
            ),
          ),
        });
      await tx.query(
        "UPDATE agents SET key_hash=$3,status='paused',version=version+1,credential_issuer_id=$4 WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, agent, digest(token()), p.membershipId],
      );
      return insertCredential(tx, p, agent, input);
    });
  });
  app.delete('/v1/agents/:id/credentials/:credentialId', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      credential = id.parse((req.params as { credentialId: string }).credentialId);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      await fenceAgent(tx, p.workspaceId, agent);
      const rows = await tx.query(
        'UPDATE agent_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE workspace_id=$1 AND agent_id=$2 AND id=$3 RETURNING id',
        [p.workspaceId, agent, credential],
      );
      if (!rows.length) throw notFound();
      await recordChange(tx, p, 'agent.credential_revoked', agent);
      return { ok: true };
    });
  });
  app.get('/v1/agents/:id/deliveries', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      q = z
        .object({
          after: z.uuid().optional(),
          state: z.enum(['pending', 'leased', 'completed', 'dead', 'expired']).optional(),
        })
        .parse(req.query);
    const rows = await db.query(
      'SELECT id,state,attempts,fence,created_at,completed_at,expires_at,summary FROM agent_inbox WHERE workspace_id=$1 AND agent_id=$2 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM agent_inbox WHERE workspace_id=$1 AND id=$3 AND agent_id=$2)) AND ($4::text IS NULL OR state=$4) ORDER BY created_at DESC,id DESC LIMIT 31',
      [p.workspaceId, agent, q.after ?? null, q.state ?? null],
    );
    return { items: rows.slice(0, 30), next: rows.length > 30 ? rows[29]!.id : null };
  });
  app.post('/v1/agents/:id/deliveries/:deliveryId/retry', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      delivery = id.parse((req.params as { deliveryId: string }).deliveryId);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      const rows = await tx.query(
        "UPDATE agent_inbox SET state='pending',attempts=0,fence=fence+1,available_at=now(),expires_at=now()+interval '7 days',summary=NULL WHERE workspace_id=$1 AND agent_id=$2 AND id=$3 AND state IN ('dead','expired') RETURNING id",
        [p.workspaceId, agent, delivery],
      );
      if (!rows.length)
        throw new AppError(
          409,
          'DELIVERY_CHANGED',
          'Only dead or expired deliveries can be retried.',
        );
      await recordChange(tx, p, 'agent.delivery_retried', agent);
      return { ok: true };
    });
  });
  app.get('/v1/agent/inbox', async (req) => {
    const p = await authenticate(db, req);
    requireAgent(p);
    return db.transaction(async (tx) => {
      await expireInbox(tx);
      await tx.query(
        'UPDATE agents SET last_seen_at=now() WHERE workspace_id=$1 AND membership_id=$2',
        [p.workspaceId, p.membershipId],
      );
      return tx.query(
        "SELECT i.id,i.state,i.created_at,i.attempts,i.expires_at,m.id message_id,m.body,m.conversation_id,m.thread_id FROM agent_inbox i JOIN agents a ON a.workspace_id=i.workspace_id AND a.id=i.agent_id JOIN agent_revisions v ON v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision JOIN messages m ON m.workspace_id=i.workspace_id AND m.id=i.message_id WHERE i.workspace_id=$1 AND a.membership_id=$2 AND a.runtime='external' AND a.status='active' AND v.configuration->>'activation'='mentions' AND (jsonb_array_length(v.configuration->'conversationIds')=0 OR v.configuration->'conversationIds' ? m.conversation_id::text) AND i.state='pending' AND i.available_at<=now() AND i.expires_at>now() AND m.deleted_at IS NULL ORDER BY i.created_at,i.id LIMIT 50",
        [p.workspaceId, p.membershipId],
      );
    });
  });
  app.post('/v1/agent/inbox/:id/lease', async (req) => {
    const p = await authenticate(db, req),
      input = inboxLeaseInput.parse(req.body ?? {});
    return db.transaction((tx) => leaseInbox(tx, p, pathId(req.params), input.leaseSeconds));
  });
  app.post('/v1/agent/inbox/:id/accept', async (req) => {
    await authenticate(db, req);
    throw new AppError(
      409,
      'LEASE_REQUIRED',
      'Acquire a fenced lease and report completion; receipt acceptance is no longer sufficient.',
    );
  });
  app.post('/v1/agent/inbox/:id/heartbeat', async (req) => {
    const p = await authenticate(db, req),
      input = z
        .object({
          leaseToken: z.uuid(),
          fence: z.number().int().positive(),
          leaseSeconds: z.number().int().min(15).max(900).default(120),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      await deliveryLease(tx, p, pathId(req.params), input.leaseToken, input.fence);
      const [row] = await tx.query(
        "UPDATE agent_inbox SET lease_expires_at=least(expires_at,now()+$3*interval '1 second') WHERE workspace_id=$1 AND id=$2 RETURNING lease_expires_at",
        [p.workspaceId, pathId(req.params), input.leaseSeconds],
      );
      return row;
    });
  });
  app.post('/v1/agent/inbox/:id/result', async (req) => {
    const p = await authenticate(db, req),
      delivery = pathId(req.params),
      input = inboxResultInput.parse(req.body);
    return db.transaction(async (tx) => {
      const [done] = await tx.query(
        "SELECT id,summary FROM agent_inbox WHERE workspace_id=$1 AND id=$2 AND state='completed' AND credential_id=$3 AND lease_token=$4 AND fence=$5",
        [p.workspaceId, delivery, p.credentialId, input.leaseToken, input.fence],
      );
      if (done) {
        if (input.outcome !== 'completed' || done.summary !== input.summary)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This lease already completed with another result.',
          );
        return { ok: true, replayed: true };
      }
      const row = await deliveryLease(tx, p, delivery, input.leaseToken, input.fence),
        state =
          input.outcome === 'completed'
            ? 'completed'
            : input.outcome === 'failed' || Number(row.attempts) >= 5
              ? 'dead'
              : 'pending';
      await tx.query(
        "UPDATE agent_inbox SET state=$3,summary=$4,completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END,available_at=now()+least(3600,30*power(2,least(attempts,6)))*interval '1 second',lease_expires_at=NULL WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, delivery, state, input.summary],
      );
      return { ok: true, replayed: false };
    });
  });
  app.get('/v1/agents/:id/webhook', async (req) => {
    const p = await authenticate(db, req);
    return (
      (
        await db.query(
          'SELECT url,version,enabled FROM agent_webhooks WHERE workspace_id=$1 AND agent_id=$2',
          [p.workspaceId, pathId(req.params)],
        )
      )[0] ?? null
    );
  });
  app.get('/v1/agents/:id/wakeups', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      q = z.object({ after: z.uuid().optional() }).parse(req.query);
    const rows = await db.query(
      'SELECT d.id,d.state,d.attempts,d.error_code,d.delivered_at,d.created_at FROM agent_wakeups d JOIN agent_inbox i ON i.workspace_id=d.workspace_id AND i.id=d.inbox_id JOIN messages m ON m.workspace_id=i.workspace_id AND m.id=i.message_id WHERE d.workspace_id=$1 AND d.agent_id=$2 AND ($3::uuid IS NULL OR (d.created_at,d.id)<(SELECT created_at,id FROM agent_wakeups WHERE workspace_id=$1 AND agent_id=$2 AND id=$3)) ORDER BY d.created_at DESC,d.id DESC LIMIT 31',
      [p.workspaceId, agent, q.after ?? null],
    );
    return { items: rows.slice(0, 30), next: rows.length > 30 ? rows[29]!.id : null };
  });
  app.post('/v1/agents/:id/wakeups/:wakeupId/retry', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      wakeup = id.parse((req.params as { wakeupId: string }).wakeupId);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      const [row] = await tx.query(
        "UPDATE agent_wakeups d SET state='pending',attempts=0,available_at=now(),lease_token=NULL,lease_expires_at=NULL,error_code=NULL FROM agent_webhooks w,agent_inbox i,messages m WHERE d.workspace_id=$1 AND d.agent_id=$2 AND d.id=$3 AND d.state='dead' AND w.workspace_id=d.workspace_id AND w.agent_id=d.agent_id AND w.version=d.webhook_version AND w.enabled AND i.workspace_id=d.workspace_id AND i.id=d.inbox_id AND i.state='pending' AND i.expires_at>now() AND m.workspace_id=i.workspace_id AND m.id=i.message_id AND m.deleted_at IS NULL RETURNING d.id",
        [p.workspaceId, agent, wakeup],
      );
      if (!row)
        throw new AppError(
          409,
          'WAKEUP_CHANGED',
          'Only dead wake-ups for a current, pending delivery can be retried.',
        );
      await recordChange(tx, p, 'agent.wakeup_retried', agent);
      return { ok: true };
    });
  });
  app.put('/v1/agents/:id/webhook', async (req) => {
    const p = await authenticate(db, req),
      agent = pathId(req.params),
      input = z
        .object({ url: z.url().max(2000), version: z.number().int().min(0), enabled: z.boolean() })
        .strict()
        .parse(req.body);
    await validateWebhookUrl(input.url, webhookHosts);
    const signingSecret = token();
    const encrypted = secrets.seal(`agent-webhook:${p.workspaceId}:${agent}`, signingSecret);
    await db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      await currentAgent(tx, p, agent);
      const [row] = await tx.query(
        'SELECT version FROM agent_webhooks WHERE workspace_id=$1 AND agent_id=$2 FOR UPDATE',
        [p.workspaceId, agent],
      );
      if (Number(row?.version ?? 0) !== input.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'The webhook changed. Refresh before saving.');
      await tx.query(
        'INSERT INTO agent_webhooks(workspace_id,agent_id,url,encrypted_secret,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,agent_id) DO UPDATE SET url=excluded.url,encrypted_secret=excluded.encrypted_secret,enabled=excluded.enabled,version=agent_webhooks.version+1',
        [p.workspaceId, agent, input.url, encrypted, input.enabled],
      );
      await recordChange(tx, p, 'agent.webhook_changed', agent);
    });
    return { signingSecret };
  });
}
function requireAgent(p: Identity) {
  if (!p.credentialId) throw new AppError(403, 'AGENT_ONLY', 'Use a scoped agent credential.');
}
