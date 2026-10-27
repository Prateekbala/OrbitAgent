import type { FastifyInstance } from 'fastify';
import { identityScope, type Database } from '@ao/database';
import { z } from 'zod';
import { currentSession } from '../identity/security.js';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import { AppError } from '../lib/errors.js';
export function operationRoutes(app: FastifyInstance, db: Database) {
  const org = (v: unknown) => z.object({ org: z.uuid() }).parse(v).org;
  app.get('/v1/status', async () => {
    const [row] = await db.query('SELECT published_status() incidents');
    return { incidents: row!.incidents };
  });
  app.get('/v1/organizations/:org/operations', async (req) => {
    const account = (await currentSession(db, req)).account_id,
      organization = org(req.params);
    return identityScope(async () => {
      await organizationActor(db, organization, account, true);
      const [queues] = await db.query('SELECT operations_queues($1) value', [organization]);
      return {
        queues: queues!.value,
        productMetrics: await db.query(
          'SELECT day,event,total::text FROM product_metrics WHERE organization_id=$1 AND day>=current_date-90 ORDER BY day DESC,event',
          [organization],
        ),
        deletionBacklog: await db.query(
          'SELECT state,count(*)::int total FROM lifecycle_jobs WHERE organization_id=$1 GROUP BY state',
          [organization],
        ),
      };
    });
  });
  app.post('/v1/organizations/:org/operations/replay', async (req) => {
    const account = (await currentSession(db, req)).account_id,
      organization = org(req.params),
      input = z
        .object({
          workspaceId: z.uuid(),
          kind: z.enum(['developer', 'connection']),
          id: z.uuid(),
          reason: z.string().trim().min(20).max(1000),
        })
        .strict()
        .parse(req.body);
    return identityScope(() =>
      db.transaction(async (tx) => {
        await organizationActor(tx, organization, account, true, true);
        const [result] = await tx.query('SELECT replay_delivery($1,$2,$3,$4) ok', [
          organization,
          input.workspaceId,
          input.kind,
          input.id,
        ]);
        if (!result?.ok)
          throw new AppError(
            409,
            'REPLAY_UNAVAILABLE',
            'Only failed, replay-safe deliveries in this organization may be retried.',
          );
        await tx.query(
          'INSERT INTO operation_replays(organization_id,workspace_id,delivery_id,kind,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6)',
          [organization, input.workspaceId, input.id, input.kind, account, input.reason],
        );
        await organizationAudit(
          tx,
          organization,
          account,
          'operations.delivery_replayed',
          input.id,
        );
        return { ok: true };
      }),
    );
  });
}
