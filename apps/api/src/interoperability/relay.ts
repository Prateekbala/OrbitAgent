import { recordChange } from '../lib/events.js';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { workerScope, identifyPrincipal, type Database } from '@ao/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { migrationBatch } from '@ao/contracts/interoperability';
import { IdentitySecrets } from '../identity/secrets.js';
import { canonicalJson } from '../lib/canonical-json.js';
import { AppError } from '../lib/errors.js';
import type { Identity } from '../lib/policy.js';
import { sourceFor } from './authority.js';
import { ImportService } from './imports.js';
export class MigrationRelay {
  constructor(
    private db: Database,
    private secrets: IdentitySecrets,
  ) {}
  async rotate(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      const source = await sourceFor(tx, p, id);
      if (source.mode === 'import' || source.state === 'disconnected')
        throw new AppError(409, 'SYNC_SOURCE_REQUIRED', 'Use a connected synchronization source.');
      const token = randomBytes(32).toString('base64url');
      await tx.query(
        'UPDATE migration_sources SET relay_secret=$3,version=version+1,owner_auth_version=$4,owner_policy_version=$5 WHERE workspace_id=$1 AND id=$2',
        [
          p.workspaceId,
          id,
          this.secrets.seal('migration:' + id, token),
          p.authVersion,
          p.policyVersion,
        ],
      );
      await tx.query(
        "UPDATE migration_deliveries SET state='uncertain',lease_token=NULL,lease_until=NULL,version=version+1 WHERE workspace_id=$1 AND source_id=$2 AND state='leased'",
        [p.workspaceId, id],
      );
      await recordChange(tx, p, 'migration.relay_rotated', id, null, p.membershipId);
      return { secret: token };
    });
  }
  async signed<T>(req: FastifyRequest, work: (p: Identity, id: string) => Promise<T>) {
    const id = z.uuid().parse((req.params as { id: string }).id),
      workspace = z.uuid().parse(req.headers['x-orbit-workspace']);
    const timestamp = z
      .string()
      .regex(/^\d{13}$/)
      .parse(req.headers['x-orbit-timestamp']);
    if (Math.abs(Date.now() - Number(timestamp)) > 300000)
      throw new AppError(401, 'INVALID_RELAY_SIGNATURE', 'This relay request expired.');
    return workerScope(workspace, async () => {
      const [s] = await this.db.query(
        'SELECT s.*,m.name,m.role,m.permissions FROM migration_sources s JOIN memberships m ON m.workspace_id=s.workspace_id AND m.id=s.owner_id WHERE s.workspace_id=$1 AND s.id=$2',
        [workspace, id],
      );
      const signature = req.headers['x-orbit-signature'];
      if (
        !s?.relay_secret ||
        (s.state !== 'active' &&
          !(s.state === 'paused' && req.url.split('?')[0]?.endsWith('/batches'))) ||
        s.mode === 'import' ||
        typeof signature !== 'string' ||
        !/^v1=[0-9a-f]{64}$/.test(signature)
      )
        throw new AppError(401, 'INVALID_RELAY_SIGNATURE', 'This relay is unavailable.');
      const key = this.secrets.open('migration:' + id, String(s.relay_secret));
      const expected = createHmac('sha256', key)
        .update(
          timestamp +
            '\n' +
            req.method +
            '\n' +
            req.url.split('?')[0] +
            '\n' +
            canonicalJson(req.body ?? null),
        )
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex')))
        throw new AppError(401, 'INVALID_RELAY_SIGNATURE', 'Invalid relay proof.');
      const p: Identity = {
        workspaceId: workspace,
        membershipId: String(s.owner_id),
        name: String(s.name),
        kind: 'human',
        role: s.role as Identity['role'],
        accessType: 'member',
        authVersion: Number(s.owner_auth_version),
        policyVersion: Number(s.owner_policy_version),
        permissions: s.permissions as NonNullable<Identity['permissions']>,
      };
      identifyPrincipal(p.membershipId, 'member');
      await this.db.transaction((tx) => sourceFor(tx, p, id));
      return work(p, id);
    });
  }
  async history(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      await sourceFor(tx, p, id);
      return tx.query(
        'SELECT id,message_id,message_version,event_type,state,attempts,external_id,version,created_at FROM migration_deliveries WHERE workspace_id=$1 AND source_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200',
        [p.workspaceId, id],
      );
    });
  }
  async reconcile(
    p: Identity,
    id: string,
    delivery: string,
    input: {
      version: number;
      outcome: 'completed' | 'retry' | 'cancelled';
      externalId?: string | undefined;
      confirmedNotApplied?: boolean | undefined;
      evidence: string;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const source = await sourceFor(tx, p, id);
      const [d] = await tx.query(
        'SELECT * FROM migration_deliveries WHERE workspace_id=$1 AND source_id=$2 AND id=$3 FOR UPDATE',
        [p.workspaceId, id, delivery],
      );
      if (!d || d.version !== input.version || d.state !== 'uncertain')
        throw new AppError(
          409,
          'DELIVERY_NOT_UNCERTAIN',
          'Reload this uncertain delivery before reconciling it.',
        );
      if (
        input.outcome === 'retry' &&
        (input.confirmedNotApplied !== true || source.state !== 'active' || Number(d.attempts) >= 5)
      )
        throw new AppError(
          409,
          'RECONCILIATION_REQUIRED',
          'Retry requires a connected source, provider-confirmed non-execution, and fewer than five attempts.',
        );
      if (input.outcome === 'completed' && !input.externalId)
        throw new AppError(
          400,
          'PROVIDER_RECEIPT_REQUIRED',
          'Provide the confirmed provider message ID.',
        );
      await tx.query(
        'UPDATE migration_deliveries SET state=$4,external_id=$5,claim_request_id=NULL,version=version+1 WHERE workspace_id=$1 AND source_id=$2 AND id=$3',
        [
          p.workspaceId,
          id,
          delivery,
          input.outcome === 'retry' ? 'pending' : input.outcome,
          input.externalId ?? d.external_id,
        ],
      );
      await tx.query(
        'INSERT INTO migration_reconciliations(id,workspace_id,delivery_id,actor_id,outcome,evidence) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), p.workspaceId, delivery, p.membershipId, input.outcome, input.evidence],
      );
      await recordChange(tx, p, 'migration.delivery_reconciled', delivery, null, p.membershipId);
      return { ok: true };
    });
  }
  routes(app: FastifyInstance) {
    const config = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
    app.post('/v1/migration-relay/:id/batches', config, (req) =>
      this.signed(req, (p, id) =>
        new ImportService(this.db).stage(p, id, migrationBatch.parse(req.body)),
      ),
    );
    app.post('/v1/migration-relay/:id/claim', config, (req) =>
      this.signed(req, (p, id) =>
        this.db.transaction(async (tx) => {
          const s = await sourceFor(tx, p, id);
          if (s.mode !== 'bidirectional')
            throw new AppError(403, 'OUTBOUND_DISABLED', 'This source is inbound only.');
          const claim = z.object({ clientId: z.uuid() }).strict().parse(req.body);
          const [prior] = await tx.query(
            'SELECT id FROM migration_deliveries WHERE workspace_id=$1 AND source_id=$2 AND claim_request_id=$3',
            [p.workspaceId, id, claim.clientId],
          );
          if (prior) return { delivery: null, replayed: true };
          await tx.query(
            "UPDATE migration_deliveries SET state='uncertain',lease_token=NULL,lease_until=NULL,version=version+1 WHERE workspace_id=$1 AND source_id=$2 AND state='leased' AND lease_until<=now()",
            [p.workspaceId, id],
          );
          const [d] = await tx.query(
            "SELECT d.*,mc.external_id external_channel_id FROM migration_deliveries d JOIN migration_channels mc ON mc.workspace_id=d.workspace_id AND mc.source_id=d.source_id AND mc.conversation_id=d.conversation_id WHERE d.workspace_id=$1 AND d.source_id=$2 AND d.state='pending' ORDER BY d.created_at,d.id LIMIT 1 FOR UPDATE OF d",
            [p.workspaceId, id],
          );
          if (!d) return { delivery: null };
          const [m] = await tx.query(
            'SELECT id,body,version,deleted_at,thread_id,source_attribution,member_external_attribution(workspace_id,author_id) external_organization FROM messages WHERE workspace_id=$1 AND id=$2',
            [p.workspaceId, d.message_id],
          );
          const [allowed] = await tx.query(
            "SELECT id FROM conversations c WHERE c.workspace_id=$1 AND c.id=$2 AND c.archived_at IS NULL AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$3))",
            [p.workspaceId, d.conversation_id, p.membershipId],
          );
          const [blockedExport] = await tx.query(
            'SELECT EXISTS(SELECT 1 FROM shared_channel_grants_access($1,$2) policy WHERE NOT policy.export_allowed) blocked',
            [p.workspaceId, d.conversation_id],
          );
          if (
            !m ||
            !allowed ||
            m.version !== d.message_version ||
            m.external_organization ||
            blockedExport?.blocked
          ) {
            await tx.query(
              "UPDATE migration_deliveries SET state='cancelled' WHERE workspace_id=$1 AND id=$2",
              [p.workspaceId, d.id],
            );
            return { delivery: null };
          }
          const lease = randomUUID();
          await tx.query(
            "UPDATE migration_deliveries SET state='leased',lease_token=$3,lease_until=now()+interval '60 seconds',attempts=attempts+1,claim_request_id=$4,version=version+1 WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, d.id, lease, claim.clientId],
          );
          return {
            delivery: {
              id: d.id,
              leaseToken: lease,
              externalChannelId: d.external_channel_id,
              message: m,
              eventType: d.event_type,
              externalMessageId:
                (
                  await tx.query(
                    "SELECT external_id FROM migration_deliveries WHERE workspace_id=$1 AND source_id=$2 AND message_id=$3 AND state='completed' AND external_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
                    [p.workspaceId, id, d.message_id],
                  )
                )[0]?.external_id ??
                (
                  await tx.query(
                    'SELECT external_id FROM migration_origins WHERE workspace_id=$1 AND source_id=$2 AND message_id=$3',
                    [p.workspaceId, id, d.message_id],
                  )
                )[0]?.external_id ??
                null,
              authorName: (
                await tx.query(
                  'SELECT name FROM memberships WHERE workspace_id=$1 AND id=(SELECT author_id FROM messages WHERE workspace_id=$1 AND id=$2)',
                  [p.workspaceId, d.message_id],
                )
              )[0]?.name,
              reactions: await tx.query(
                'SELECT emoji,count(*)::int count FROM message_reactions WHERE workspace_id=$1 AND message_id=$2 GROUP BY emoji',
                [p.workspaceId, d.message_id],
              ),
              files: await tx.query(
                "SELECT f.id,f.name,f.size,f.sha256 FROM files f JOIN message_attachments a ON a.workspace_id=f.workspace_id AND a.file_id=f.id WHERE a.workspace_id=$1 AND a.message_id=$2 AND f.status='attached'",
                [p.workspaceId, d.message_id],
              ),
              attributionRequired: true,
              echoActionId: d.id,
            },
          };
        }),
      ),
    );
    app.post('/v1/migration-relay/:id/complete', config, (req) =>
      this.signed(req, (p, id) =>
        this.db.transaction(async (tx) => {
          await sourceFor(tx, p, id);
          const input = z
            .object({
              deliveryId: z.uuid(),
              leaseToken: z.uuid(),
              externalId: z.string().min(1).max(200),
              outcome: z.enum(['completed', 'uncertain']),
            })
            .strict()
            .parse(req.body);
          const [d] = await tx.query(
            "UPDATE migration_deliveries SET state=$5,external_id=$6,lease_token=NULL,lease_until=NULL,version=version+1 WHERE workspace_id=$1 AND source_id=$2 AND id=$3 AND lease_token=$4 AND state='leased' AND lease_until>now() RETURNING id",
            [
              p.workspaceId,
              id,
              input.deliveryId,
              input.leaseToken,
              input.outcome,
              input.externalId,
            ],
          );
          if (!d)
            throw new AppError(409, 'LEASE_FENCED', 'Reconcile this expired or revoked delivery.');
          return { ok: true };
        }),
      ),
    );
  }
}
