import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { messagingFixture } from './messaging-fixture.js';
import { BillingWorker } from '../src/billing/worker.js';
import {
  StripeCommerce,
  type CommerceProvider,
  type SubscriptionSnapshot,
} from '../src/billing/stripe.js';
import { scopedDatabase, tenantScope, identifyPrincipal } from '@ao/database';
let f: Awaited<ReturnType<typeof messagingFixture>>, org: string;
const executions: { key: string; input: unknown }[] = [];
let fail = false;
let snapshot: SubscriptionSnapshot;
const provider: CommerceProvider = {
  priceReference: (plan) => 'price_' + plan,
  execute: async (_kind, input, key) => {
    executions.push({ key, input });
    if (fail) throw new Error('Connection lost');
    return { id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/test' };
  },
  verify: () => ({ id: 'evt_one', subscriptionId: 'sub_test' }),
  subscription: async () => snapshot,
  invoice: async () => {
    throw new Error('Unused');
  },
  seats: async () => {},
  preview: async () => ({
    amount: 1234,
    currency: 'usd',
    prorationDate: Math.floor(Date.now() / 1000),
    priceId: 'price_enterprise',
  }),
};
beforeAll(async () => {
  f = await messagingFixture(undefined, undefined, { commerce: provider });
  org = String(
    (
      await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
        f.ownerBoot.workspace.id,
      ])
    )[0]!.organization_id,
  );
  snapshot = {
    id: 'sub_test',
    organizationId: org,
    customerId: 'cus_test',
    plan: 'team',
    status: 'active',
    periodStart: Math.floor(Date.now() / 1000) - 1000,
    periodEnd: Math.floor(Date.now() / 1000) + 86400,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    quantity: 2,
  };
}, 30000);
afterAll(async () => f?.close());
it('isolates organization billing and offers a once-only idempotent trial', async () => {
  const path = `/v1/organizations/${org}/billing`;
  expect((await f.call(f.other, 'GET', path)).statusCode).toBe(404);
  expect((await f.call(f.mate, 'GET', path)).statusCode).toBe(403);
  const summary = await f.call(f.owner, 'GET', path);
  expect(summary.statusCode, summary.body).toBe(200);
  expect(summary.json().seats).toBe(2);
  expect(summary.json().usage).toHaveLength(5);
  const input = { clientId: randomUUID() };
  for (let i = 0; i < 2; i++)
    expect((await f.call(f.owner, 'POST', path + '/trial', input)).statusCode).toBe(200);
  expect(
    (await f.call(f.owner, 'POST', path + '/trial', { clientId: randomUUID() })).statusCode,
  ).toBe(409);
});
it('enforces hard budgets in self-hosted mode, idempotent settlement and an append-only ledger', async () => {
  await f.db.query(
    "UPDATE billing_accounts SET mode='self_hosted',budget_micros=100 WHERE organization_id=$1",
    [org],
  );
  const db = scopedDatabase(f.db),
    reference = randomUUID(),
    workspace = f.ownerBoot.workspace.id;
  const scoped = <T>(work: () => Promise<T>) =>
    tenantScope(workspace, async () => {
      identifyPrincipal(f.ownerBoot.me.id, 'member');
      return work();
    });
  for (let i = 0; i < 2; i++)
    await scoped(() =>
      db.query("SELECT commercial_reserve($1,'models',$2,10,80)", [workspace, reference]),
    );
  await expect(
    scoped(() =>
      db.query("SELECT commercial_reserve($1,'models',$2,10,21)", [workspace, randomUUID()]),
    ),
  ).rejects.toThrow(/budget exceeded/);
  await expect(
    scoped(() =>
      db.query("SELECT commercial_reserve($1,'models',$2,10,0)", [
        f.otherBoot.workspace.id,
        randomUUID(),
      ]),
    ),
  ).rejects.toThrow(/Invalid commercial admission/);
  for (let i = 0; i < 2; i++)
    await scoped(() =>
      db.query("SELECT commercial_settle($1,'models',$2,5,50,'test_receipt')", [
        workspace,
        reference,
      ]),
    );
  expect(
    await f.db.query('SELECT * FROM usage_ledger WHERE reference=$1', [reference]),
  ).toHaveLength(1);
  await expect(
    scoped(() => db.query('DELETE FROM usage_ledger WHERE reference=$1', [reference])),
  ).rejects.toThrow(/permission denied/);
  expect(
    (await f.call(f.owner, 'GET', `/v1/organizations/${org}/billing`)).json().spentMicros,
  ).toBe('50');
});
it('replays uncertain checkout with the same provider request and blocks concurrent mutations', async () => {
  const path = `/v1/organizations/${org}/billing/commands`,
    input = { key: randomUUID(), kind: 'checkout', plan: 'team' };
  fail = true;
  expect((await f.call(f.owner, 'POST', path, input)).json().error.code).toBe(
    'BILLING_OUTCOME_UNKNOWN',
  );
  expect((await f.call(f.owner, 'POST', path, { ...input, key: randomUUID() })).statusCode).toBe(
    409,
  );
  fail = false;
  expect((await f.call(f.owner, 'POST', path, input)).statusCode).toBe(200);
  expect(executions[0]).toEqual(executions[1]);
  expect((await f.call(f.owner, 'POST', path, input)).json().replayed).toBe(true);
  expect(executions).toHaveLength(2);
  expect((await f.call(f.owner, 'POST', path, { ...input, plan: 'enterprise' })).statusCode).toBe(
    409,
  );
});
it('deduplicates webhooks and retrieves canonical state before granting entitlements', async () => {
  for (let i = 0; i < 2; i++) {
    const r = await f.app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'fixture' },
      payload: '{}',
    });
    expect(r.statusCode, r.body).toBe(202);
  }
  expect(await f.db.query("SELECT * FROM billing_events WHERE id='evt_one'")).toHaveLength(1);
  const worker = new BillingWorker(f.db, provider);
  await worker.tick();
  let summary = (await f.call(f.owner, 'GET', `/v1/organizations/${org}/billing`)).json();
  expect(summary.plan).toBe('team');
  expect(summary.entitlements.dlp).toBe(true);
  snapshot = { ...snapshot, status: 'cancelled', periodStart: 1, periodEnd: 2 };
  await f.db.query('UPDATE billing_accounts SET reconcile_after=now() WHERE organization_id=$1', [
    org,
  ]);
  await worker.tick();
  summary = (await f.call(f.owner, 'GET', `/v1/organizations/${org}/billing`)).json();
  expect(summary.plan).toBe('free');
  expect(summary.entitlements.dlp).toBe(false);
  expect(new Date(summary.periodEnd).getTime()).toBeGreaterThan(Date.now());
});
it('checks real Stripe signatures and sends SDK idempotency headers', async () => {
  const requests: { url: string; key: string | null; body: string }[] = [];
  const stripe = new StripeCommerce(
    'sk_test_fixture',
    { team: 'price_team' },
    'whsec_fixture',
    'https://orbit.example',
    async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        key: new Headers(init?.headers).get('idempotency-key'),
        body: String(init?.body ?? ''),
      });
      return new Response(
        JSON.stringify(
          url.includes('/prices/')
            ? { id: 'price_team', currency: 'usd', active: true, recurring: { interval: 'month' } }
            : { id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/test' },
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' },
        },
      );
    },
  );
  const payload = JSON.stringify({
    id: 'evt_signed',
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_signed' } },
  });
  const signature = stripe.client.webhooks.generateTestHeaderString({
    payload,
    secret: 'whsec_fixture',
  });
  expect(stripe.verify(Buffer.from(payload), signature).subscriptionId).toBe('sub_signed');
  expect(() => stripe.verify(Buffer.from(payload + ' '), signature)).toThrow();
  const old = stripe.client.webhooks.generateTestHeaderString({
    payload,
    secret: 'whsec_fixture',
    timestamp: 1,
  });
  expect(() => stripe.verify(Buffer.from(payload), old)).toThrow();
  await stripe.execute(
    'checkout',
    { organizationId: org, customerId: null, subscriptionId: null, seats: 2, plan: 'team' },
    'orbit-test-key',
  );
  const rejected = new StripeCommerce(
    'sk_test_fixture',
    { team: 'price_team' },
    'whsec_fixture',
    'https://orbit.example',
    async (input) =>
      String(input).includes('/prices/')
        ? new Response(
            JSON.stringify({
              id: 'price_team',
              currency: 'usd',
              active: true,
              recurring: { interval: 'month' },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : new Response(
            JSON.stringify({
              error: { type: 'invalid_request_error', message: 'Invalid provider configuration' },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
  );
  await expect(
    rejected.execute(
      'checkout',
      { organizationId: org, customerId: null, subscriptionId: null, seats: 2, plan: 'team' },
      'rejected-key',
    ),
  ).rejects.toMatchObject({ status: 422, code: 'PAYMENT_PROVIDER_REJECTED' });
  expect(requests.at(-1)?.key).toBe('orbit-test-key');
  expect(new URLSearchParams(requests.at(-1)?.body).get('line_items[0][quantity]')).toBe('2');
});
it('appends operator receipt corrections without rewriting prior usage', async () => {
  const { reconcileUsage } = await import('../src/billing/reconciliation.js');
  const [source] = await f.db.query(
    "SELECT reference FROM billing_reservations WHERE workspace_id=$1 AND category='models' LIMIT 1",
    [f.ownerBoot.workspace.id],
  );
  const receipt = {
    id: 'provider-receipt-fixture',
    workspaceId: f.ownerBoot.workspace.id,
    category: 'models' as const,
    reference: String(source!.reference),
    expectedVersion: 1,
    units: '4',
    costMicros: '40',
  };
  expect(await reconcileUsage(f.db, receipt)).toEqual({ replayed: false });
  expect(await reconcileUsage(f.db, receipt)).toEqual({ replayed: true });
  await expect(reconcileUsage(f.db, { ...receipt, costMicros: '0' })).rejects.toThrow(
    /identity conflict/,
  );
  const summary = await f.call(f.owner, 'GET', `/v1/organizations/${org}/billing`);
  expect(summary.json().spentMicros).toBe('40');
  const exported = await f.call(f.owner, 'GET', `/v1/organizations/${org}/billing/export`);
  expect(exported.statusCode, exported.body).toBe(200);
  expect(exported.body).toContain('"type":"complete"');
  expect(exported.body).toContain('operator_provider_receipt');
});
it('persists only the signed-in account onboarding state and rejects stale writes', async () => {
  const initial = (await f.call(f.owner, 'GET', '/v1/account/onboarding')).json();
  const input = { version: initial.version, steps: ['profile'], dismissed: false };
  const saved = await f.call(f.owner, 'PUT', '/v1/account/onboarding', input);
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().steps).toEqual(['profile']);
  expect((await f.call(f.owner, 'PUT', '/v1/account/onboarding', input)).statusCode).toBe(409);
  expect((await f.call(f.mate, 'GET', '/v1/account/onboarding')).json().steps).toEqual([]);
});
