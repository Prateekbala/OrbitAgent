import { randomUUID } from 'node:crypto';
import { identityScope, type Database } from '@ao/database';
import { usageCategories, type BillingSummary, type billingBudget } from '@ao/contracts/billing';
import type { z } from 'zod';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import { AppError, notFound } from '../lib/errors.js';
import type { CommerceProvider } from './stripe.js';
import { digest } from '../lib/security.js';
export class BillingService {
  constructor(
    private readonly db: Database,
    private readonly provider?: CommerceProvider,
  ) {}
  async summary(org: string, accountId: string): Promise<BillingSummary> {
    return identityScope(async () => {
      await organizationActor(this.db, org, accountId, true);
      const [a] = await this.db.query('SELECT * FROM billing_accounts WHERE organization_id=$1', [
        org,
      ]);
      if (!a) throw notFound();
      const plan =
        a.status === 'trialing' && new Date(String(a.trial_ends_at)).getTime() > Date.now()
          ? 'team'
          : a.status === 'active'
            ? String(a.plan_id)
            : 'free';
      const [p] = await this.db.query('SELECT * FROM billing_plans WHERE id=$1 AND revision=1', [
        plan,
      ]);
      const [seats] = await this.db.query('SELECT commercial_seats($1) total', [org]);
      const usage = await this.db.query(
        'SELECT category,sum(units_delta)::text units,sum(cost_micros)::text cost_micros FROM usage_ledger WHERE organization_id=$1 AND created_at>=$2 AND created_at<$3 GROUP BY category',
        [org, a.period_start, a.period_end],
      );
      const reserved = await this.db.query(
        "SELECT category,sum(units)::text units,sum(cost_micros)::text cost FROM billing_reservations WHERE organization_id=$1 AND state='reserved' GROUP BY category",
        [org],
      );
      const [storage] = await this.db.query(
        'SELECT coalesce(sum(storage_bytes),0)::text total FROM workspaces WHERE organization_id=$1',
        [org],
      );
      const spent = usage.reduce((total, row) => total + BigInt(String(row.cost_micros)), 0n),
        held = reserved.reduce((total, row) => total + BigInt(String(row.cost)), 0n),
        budget = a.budget_micros === null ? null : BigInt(String(a.budget_micros));
      const elapsed = Math.max(3600000, Date.now() - new Date(String(a.period_start)).getTime()),
        duration =
          new Date(String(a.period_end)).getTime() - new Date(String(a.period_start)).getTime(),
        forecast =
          ((spent > 0n ? spent : 0n) * BigInt(Math.max(1, duration)) + BigInt(elapsed) - 1n) /
          BigInt(elapsed);
      const warnings: string[] = [];
      if (budget !== null && spent + held >= budget) warnings.push('hard_budget_reached');
      else if (
        budget !== null &&
        (spent + held) * 100n >= budget * BigInt(Number(a.warning_percent))
      )
        warnings.push('budget_warning');
      if (budget !== null && forecast > budget) warnings.push('forecast_exceeds_budget');
      if (a.status === 'trialing' && new Date(String(a.trial_ends_at)).getTime() < Date.now())
        warnings.push('trial_expired');
      if (usage.some((row) => row.category !== 'models')) warnings.push('unpriced_usage_present');
      return {
        organizationId: org,
        mode: a.mode,
        status: a.status,
        plan,
        version: Number(a.version),
        trialEndsAt: a.trial_ends_at,
        periodStart: a.period_start,
        periodEnd: a.period_end,
        seats: Number(seats!.total),
        seatLimit: a.mode === 'self_hosted' ? Number.MAX_SAFE_INTEGER : Number(p!.human_seats),
        budgetMicros: budget?.toString() ?? null,
        warningPercent: Number(a.warning_percent),
        spentMicros: spent.toString(),
        reservedMicros: held.toString(),
        forecastMicros: forecast.toString(),
        warnings,
        usage: usageCategories.map((category) => ({
          category,
          units:
            category === 'storage'
              ? String(storage?.total ?? 0)
              : String(usage.find((r) => r.category === category)?.units ?? 0),
          costMicros: String(usage.find((r) => r.category === category)?.cost_micros ?? 0),
          reservedUnits: String(reserved.find((r) => r.category === category)?.units ?? 0),
        })),
        allowances: p!.allowances as Record<string, number>,
        entitlements:
          a.mode === 'self_hosted'
            ? { hosted_execution: true, dlp: true, sso: true, scim: true }
            : (p!.features as Record<string, boolean>),
        checkoutAvailable: Boolean(this.provider),
      } as BillingSummary;
    });
  }
  async budget(org: string, accountId: string, input: z.infer<typeof billingBudget>) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        await organizationActor(tx, org, accountId, true, true);
        const [row] = await tx.query(
          'UPDATE billing_accounts SET budget_micros=$3,warning_percent=$4,version=version+1 WHERE organization_id=$1 AND version=$2 RETURNING version',
          [org, input.version, input.budgetMicros, input.warningPercent],
        );
        if (!row)
          throw new AppError(
            409,
            'VERSION_CONFLICT',
            'Refresh the billing settings before saving.',
          );
        await organizationAudit(tx, org, accountId, 'billing.budget_changed', org);
        return { version: row.version };
      }),
    );
  }
  async trial(org: string, accountId: string, key: string) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        await organizationActor(tx, org, accountId, true, true);
        const [row] = await tx.query(
          'SELECT * FROM billing_accounts WHERE organization_id=$1 FOR UPDATE',
          [org],
        );
        if (row?.trial_key === key) return { ok: true, replayed: true };
        if (!row || row.trial_used || row.status === 'active')
          throw new AppError(
            409,
            'TRIAL_UNAVAILABLE',
            'This organization has already used its trial or has an active subscription.',
          );
        await tx.query(
          "UPDATE billing_accounts SET mode='managed',status='trialing',trial_used=true,trial_key=$2,trial_ends_at=now()+interval '14 days',version=version+1 WHERE organization_id=$1",
          [org, key],
        );
        await organizationAudit(tx, org, accountId, 'billing.trial_started', org);
        return { ok: true, replayed: false };
      }),
    );
  }
  async commands(org: string, accountId: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, accountId, true);
      return this.db.query(
        "SELECT request_key key,kind,state,error_code,created_at,payload->>'plan' plan FROM billing_commands WHERE organization_id=$1 ORDER BY (state IN ('pending','sending','outcome_unknown')) DESC,created_at DESC,id DESC LIMIT 100",
        [org],
      );
    });
  }
  async invoices(org: string, accountId: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, accountId, true);
      return this.db.query(
        'SELECT id,currency,total_minor::text,status,period_start,period_end,hosted_url,issued_at FROM billing_invoices WHERE organization_id=$1 ORDER BY issued_at DESC,id DESC LIMIT 100',
        [org],
      );
    });
  }
  async preview(org: string, accountId: string, plan: 'team' | 'enterprise') {
    if (!this.provider)
      throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Payment-provider setup is pending.');
    const data = await identityScope(async () => {
      await organizationActor(this.db, org, accountId, true);
      const [a] = await this.db.query(
        'SELECT *,commercial_seats($1) seats FROM billing_accounts WHERE organization_id=$1',
        [org],
      );
      if (!a?.provider_subscription_id)
        throw new AppError(
          409,
          'SUBSCRIPTION_REQUIRED',
          'Start a subscription before changing plans.',
        );
      return a;
    });
    const preview = await this.provider.preview(
        String(data.provider_subscription_id),
        plan,
        Math.max(1, Number(data.seats)),
      ),
      id = randomUUID();
    await identityScope(() =>
      this.db.query(
        'INSERT INTO billing_quotes(id,organization_id,plan,price_id,subscription_id,seats,seat_epoch,amount_minor,currency,proration_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          org,
          plan,
          preview.priceId,
          data.provider_subscription_id,
          Math.max(1, Number(data.seats)),
          data.seat_epoch,
          preview.amount,
          preview.currency,
          preview.prorationDate,
        ],
      ),
    );
    return { id, amount: preview.amount, currency: preview.currency };
  }
  async command(
    org: string,
    accountId: string,
    input: {
      key: string;
      kind: 'checkout' | 'portal' | 'cancel' | 'plan_change';
      plan?: 'team' | 'enterprise' | undefined;
      acknowledgeProration?: boolean | undefined;
      quoteId?: string | undefined;
    },
  ) {
    if (!this.provider)
      throw new AppError(
        503,
        'PAYMENTS_UNAVAILABLE',
        'Payment-provider setup is pending. No payment was created.',
      );
    const provider = this.provider,
      hash = digest(JSON.stringify({ kind: input.kind, plan: input.plan ?? null }));
    const prepared = await identityScope(() =>
      this.db.transaction(async (tx) => {
        await organizationActor(tx, org, accountId, true, true);
        const [account] = await tx.query(
          'SELECT * FROM billing_accounts WHERE organization_id=$1 FOR UPDATE',
          [org],
        );
        if (!account) throw notFound();
        const [existing] = await tx.query(
          'SELECT * FROM billing_commands WHERE organization_id=$1 AND request_key=$2 FOR UPDATE',
          [org, input.key],
        );
        if (existing) {
          if (existing.request_hash !== hash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This request key has different billing parameters.',
            );
          if (existing.state === 'succeeded') return { done: true, url: existing.result_url };
          if (Date.now() - new Date(String(existing.created_at)).getTime() > 23 * 3600000)
            throw new AppError(
              409,
              'BILLING_RECONCILIATION_REQUIRED',
              'Reconcile the previous provider outcome before retrying.',
            );
          if (
            existing.state === 'sending' &&
            new Date(String(existing.lease_until)).getTime() > Date.now()
          )
            throw new AppError(409, 'BILLING_IN_PROGRESS', 'This billing request is in progress.');
        }
        if (!existing && input.kind !== 'portal') {
          const [pending] = await tx.query(
            "SELECT id FROM billing_commands WHERE organization_id=$1 AND kind<>'portal' AND state IN ('pending','sending','outcome_unknown') LIMIT 1",
            [org],
          );
          if (pending)
            throw new AppError(
              409,
              'BILLING_RECONCILIATION_REQUIRED',
              'Retry or reconcile the pending billing request first.',
            );
        }
        if (!existing && input.kind === 'checkout') {
          const [pending] = await tx.query(
            "SELECT id FROM billing_commands WHERE organization_id=$1 AND kind='checkout' AND state IN ('pending','sending','outcome_unknown') LIMIT 1",
            [org],
          );
          if (
            pending ||
            account.status === 'active' ||
            (account.provider_subscription_id && account.status !== 'cancelled')
          )
            throw new AppError(
              409,
              'SUBSCRIPTION_EXISTS',
              'Manage the existing subscription or reconcile the pending checkout.',
            );
        }
        if (input.kind === 'plan_change' && !input.acknowledgeProration)
          throw new AppError(
            400,
            'PRORATION_ACKNOWLEDGEMENT',
            'Confirm the provider proration preview before changing plans.',
          );
        let quote: Record<string, unknown> | undefined;
        if (input.kind === 'plan_change' && !existing) {
          [quote] = await tx.query(
            'SELECT * FROM billing_quotes WHERE organization_id=$1 AND id=$2 AND expires_at>now() AND seat_epoch=$3 AND subscription_id=$4 AND plan=$5',
            [
              org,
              input.quoteId ?? null,
              account.seat_epoch,
              account.provider_subscription_id,
              input.plan,
            ],
          );
          if (!quote)
            throw new AppError(
              409,
              'QUOTE_EXPIRED',
              'Preview this plan change again before confirming.',
            );
        }
        const [count] = await tx.query('SELECT commercial_seats($1) total', [org]);
        const payload = existing?.payload ?? {
          organizationId: org,
          customerId: account.provider_customer_id,
          subscriptionId: account.provider_subscription_id,
          seats: Math.max(1, Number(count!.total)),
          plan: input.plan,
          ...(input.plan
            ? { priceId: quote?.price_id ?? provider.priceReference(input.plan) }
            : {}),
          ...(quote ? { prorationDate: Number(quote.proration_date) } : {}),
        };
        const id = String(existing?.id ?? randomUUID()),
          lease = randomUUID();
        if (!existing)
          await tx.query(
            "INSERT INTO billing_commands(id,organization_id,request_key,kind,request_hash,state,payload) VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb)",
            [id, org, input.key, input.kind, hash, JSON.stringify(payload)],
          );
        await tx.query(
          "UPDATE billing_commands SET state='sending',lease_token=$3,lease_until=now()+interval '1 minute' WHERE organization_id=$1 AND id=$2",
          [org, id, lease],
        );
        return {
          done: false,
          id,
          lease,
          payload: payload as Parameters<CommerceProvider['execute']>[1],
        };
      }),
    );
    if (prepared.done) return { url: prepared.url, replayed: true };
    try {
      const result = await provider.execute(
        input.kind,
        prepared.payload!,
        'orbit-billing/' + prepared.id,
      );
      await identityScope(() =>
        this.db.query(
          "UPDATE billing_commands SET state='succeeded',provider_id=$4,result_url=$5,lease_token=NULL,lease_until=NULL WHERE organization_id=$1 AND id=$2 AND lease_token=$3",
          [org, prepared.id, prepared.lease, result.id, result.url ?? null],
        ),
      );
      return { url: result.url ?? null, replayed: false };
    } catch (error) {
      const uncertain = !(error instanceof AppError && error.status < 500);
      await identityScope(() =>
        this.db.query(
          'UPDATE billing_commands SET state=$4,error_code=$5,lease_token=NULL,lease_until=NULL WHERE organization_id=$1 AND id=$2 AND lease_token=$3',
          [
            org,
            prepared.id,
            prepared.lease,
            uncertain ? 'outcome_unknown' : 'failed',
            uncertain ? 'PROVIDER_OUTCOME_UNKNOWN' : 'PROVIDER_REJECTED',
          ],
        ),
      );
      throw new AppError(
        502,
        uncertain ? 'BILLING_OUTCOME_UNKNOWN' : 'BILLING_REJECTED',
        uncertain
          ? 'The provider outcome is uncertain. Retry this same request to reconcile it.'
          : 'The payment provider rejected this request.',
      );
    }
  }
}
