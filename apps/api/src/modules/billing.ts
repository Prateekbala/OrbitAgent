import { Readable } from 'node:stream';
import { organizationActor } from '../identity/organizations.js';
import type { FastifyInstance } from 'fastify';
import { identityScope, type Database } from '@ao/database';
import { z } from 'zod';
import { billingBudget, trialInput } from '@ao/contracts/billing';
import { currentSession } from '../identity/security.js';
import { BillingService } from '../billing/service.js';
import type { CommerceProvider } from '../billing/stripe.js';
import { AppError } from '../lib/errors.js';
import { digest } from '../lib/security.js';
export function billingRoutes(app: FastifyInstance, db: Database, provider?: CommerceProvider) {
  const service = new BillingService(db, provider),
    org = (value: unknown) => z.object({ org: z.uuid() }).parse(value).org;
  app.get('/v1/organizations/:org/billing', async (req) =>
    service.summary(org(req.params), (await currentSession(db, req)).account_id),
  );
  app.put('/v1/organizations/:org/billing/budget', async (req) =>
    service.budget(
      org(req.params),
      (await currentSession(db, req)).account_id,
      billingBudget.parse(req.body),
    ),
  );
  app.post('/v1/organizations/:org/billing/trial', async (req) =>
    service.trial(
      org(req.params),
      (await currentSession(db, req)).account_id,
      trialInput.parse(req.body).clientId,
    ),
  );
  app.get('/v1/organizations/:org/billing/invoices', async (req) =>
    service.invoices(org(req.params), (await currentSession(db, req)).account_id),
  );
  app.post('/v1/organizations/:org/billing/preview', async (req) =>
    service.preview(
      org(req.params),
      (await currentSession(db, req)).account_id,
      z
        .object({ plan: z.enum(['team', 'enterprise']) })
        .strict()
        .parse(req.body).plan,
    ),
  );
  app.get('/v1/organizations/:org/billing/commands', async (req) =>
    service.commands(org(req.params), (await currentSession(db, req)).account_id),
  );
  app.post('/v1/organizations/:org/billing/commands', async (req) =>
    service.command(
      org(req.params),
      (await currentSession(db, req)).account_id,
      z
        .object({
          key: z.uuid(),
          kind: z.enum(['checkout', 'portal', 'cancel', 'plan_change']),
          plan: z.enum(['team', 'enterprise']).optional(),
          acknowledgeProration: z.boolean().optional(),
          quoteId: z.uuid().optional(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.get('/v1/organizations/:org/billing/export', async (req, reply) => {
    const organization = org(req.params),
      account = (await currentSession(db, req)).account_id;
    const summary = await service.summary(organization, account),
      cutoff = new Date().toISOString();
    async function* records() {
      await identityScope(() => organizationActor(db, organization, account, true));
      yield JSON.stringify({ type: 'summary', data: summary }) + '\n';
      for (const table of ['usage_ledger', 'billing_invoices'] as const) {
        let after = '';
        while (true) {
          const rows = await identityScope(async () => {
            await organizationActor(db, organization, account, true);
            const data = await db.query(
              table === 'usage_ledger'
                ? 'SELECT id,workspace_id,category,reference,units_delta::text,cost_micros::text,confidence,created_at FROM usage_ledger WHERE organization_id=$1 AND id::text>$2 AND created_at<=$3 ORDER BY id::text LIMIT 200'
                : 'SELECT id,currency,total_minor::text,status,period_start,period_end,hosted_url,issued_at FROM billing_invoices WHERE organization_id=$1 AND id>$2 AND issued_at<=$3 ORDER BY id LIMIT 200',
              [organization, after, cutoff],
            );
            await organizationActor(db, organization, account, true);
            return data;
          });
          for (const row of rows)
            yield JSON.stringify({
              type: table === 'usage_ledger' ? 'usage' : 'invoice',
              data: row,
            }) + '\n';
          if (rows.length < 200) break;
          after = String(rows.at(-1)!.id);
        }
      }
      yield JSON.stringify({ type: 'complete', cutoff }) + '\n';
    }
    return reply
      .header('content-disposition', 'attachment; filename="orbit-billing.ndjson"')
      .type('application/x-ndjson')
      .send(Readable.from(records()));
  });
  app.register(async (child) => {
    child.removeContentTypeParser('application/json');
    child.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    child.post('/v1/billing/stripe/webhook', async (req, reply) => {
      if (!provider)
        throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'The billing webhook is not configured.');
      if (!Buffer.isBuffer(req.body))
        throw new AppError(400, 'INVALID_WEBHOOK', 'Send a signed JSON event.');
      const payload = req.body;
      let event: ReturnType<CommerceProvider['verify']>;
      try {
        event = provider.verify(
          payload,
          z.string().max(4000).parse(req.headers['stripe-signature']),
        );
      } catch {
        throw new AppError(
          400,
          'INVALID_WEBHOOK_SIGNATURE',
          'The webhook signature is invalid or expired.',
        );
      }
      await identityScope(() =>
        db.query(
          "INSERT INTO billing_events(id,provider,state,payload_hash,subscription_id,invoice_id) VALUES($1,'stripe',$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
          [
            event.id,
            event.subscriptionId || event.invoiceId ? 'pending' : 'ignored',
            digest(payload.toString('utf8')),
            event.subscriptionId ?? null,
            event.invoiceId ?? null,
          ],
        ),
      );
      return reply.code(202).send({ received: true });
    });
  });
}
