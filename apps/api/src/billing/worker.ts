import { randomUUID } from 'node:crypto';
import { identityScope, scopedDatabase, type Database } from '@ao/database';
import type { CommerceProvider } from './stripe.js';
export class BillingWorker {
  private readonly db: Database;
  private pending: Promise<void> | undefined;
  constructor(
    db: Database,
    private readonly provider?: CommerceProvider,
    private readonly onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    if (this.pending) return this.pending;
    this.pending = identityScope(() => this.process()).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  start() {
    const timer = setInterval(
      () => void this.tick().catch(() => this.onError('BILLING_WORKER_FAILED')),
      10000,
    );
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
  async synchronize(subscriptionId: string, heldLease?: string) {
    if (!this.provider) return;
    const initial = await this.provider.subscription(subscriptionId),
      lease = heldLease ?? randomUUID();
    if (!heldLease) {
      const [claim] = await this.db.query(
        "UPDATE billing_accounts SET reconcile_lease=$2,reconcile_lease_until=now()+interval '2 minutes' WHERE organization_id=$1 AND (reconcile_lease_until IS NULL OR reconcile_lease_until<now()) RETURNING organization_id",
        [initial.organizationId, lease],
      );
      if (!claim) throw new Error('Billing reconciliation is busy.');
    }
    try {
      const sub = await this.provider.subscription(subscriptionId);
      if (sub.organizationId !== initial.organizationId)
        throw new Error('Subscription ownership changed.');
      const accepted = await this.db.transaction(async (tx) => {
        const [a] = await tx.query(
          'SELECT * FROM billing_accounts WHERE organization_id=$1 AND reconcile_lease=$2 AND reconcile_lease_until>now() FOR UPDATE',
          [sub.organizationId, lease],
        );
        if (!a) throw new Error('Billing reconciliation lease expired.');
        if (a.provider_customer_id && a.provider_customer_id !== sub.customerId)
          throw new Error('Customer mismatch.');
        if (
          a.provider_subscription_id &&
          a.provider_subscription_id !== sub.id &&
          a.status !== 'cancelled'
        )
          return false;
        await tx.query(
          "UPDATE billing_accounts SET mode='managed',plan_id=$2,status=$3,provider_customer_id=$4,provider_subscription_id=$5,period_start=CASE WHEN $3='cancelled' AND to_timestamp($7)<=now() THEN date_trunc('month',now()) ELSE to_timestamp($6) END,period_end=CASE WHEN $3='cancelled' AND to_timestamp($7)<=now() THEN date_trunc('month',now())+interval '1 month' ELSE to_timestamp($7) END,trial_ends_at=CASE WHEN $8::bigint IS NULL THEN trial_ends_at ELSE to_timestamp($8) END,cancel_at_period_end=$9,version=version+1 WHERE organization_id=$1",
          [
            sub.organizationId,
            sub.plan,
            sub.status,
            sub.customerId,
            sub.id,
            sub.periodStart,
            sub.periodEnd,
            sub.trialEnd,
            sub.cancelAtPeriodEnd,
          ],
        );
        return true;
      });
      if (!accepted) return;
      const [count] = await this.db.query(
        'SELECT commercial_seats($1) total,seat_epoch FROM billing_accounts WHERE organization_id=$1 AND reconcile_lease=$2 AND reconcile_lease_until>now()',
        [sub.organizationId, lease],
      );
      if (!count) throw new Error('Billing reconciliation lease expired.');
      if (sub.quantity !== Math.max(1, Number(count.total)))
        await this.provider.seats(
          sub.id,
          Math.max(1, Number(count.total)),
          `orbit-seats/${sub.id}/${Math.max(1, Number(count.total))}/${count.seat_epoch}`,
        );
    } finally {
      await this.db.query(
        "UPDATE billing_accounts SET reconcile_after=now()+interval '5 minutes',reconcile_lease=NULL,reconcile_lease_until=NULL WHERE organization_id=$1 AND reconcile_lease=$2",
        [initial.organizationId, lease],
      );
    }
  }
  private async process() {
    await this.db.query(
      "UPDATE billing_accounts SET period_start=date_trunc('month',now()),period_end=date_trunc('month',now())+interval '1 month' WHERE (provider_subscription_id IS NULL OR status='cancelled') AND period_end<=now()",
    );
    if (!this.provider) return;
    for (let index = 0; index < 20; index++) {
      const lease = randomUUID();
      const [event] = await this.db.query(
        "UPDATE billing_events SET lease_token=$1,lease_until=now()+interval '1 minute',attempts=attempts+1 WHERE id IN(SELECT id FROM billing_events WHERE provider='stripe' AND state='pending' AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
        [lease],
      );
      if (!event) break;
      try {
        if (event.subscription_id) await this.synchronize(String(event.subscription_id));
        if (event.invoice_id) {
          const invoice = await this.provider.invoice(String(event.invoice_id)),
            [account] = await this.db.query(
              'SELECT organization_id FROM billing_accounts WHERE provider_customer_id=$1',
              [invoice.customerId],
            );
          if (account)
            await this.db.query(
              'INSERT INTO billing_invoices(id,organization_id,currency,total_minor,status,period_start,period_end,hosted_url,issued_at) VALUES($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7),$8,to_timestamp($9)) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,total_minor=EXCLUDED.total_minor,hosted_url=EXCLUDED.hosted_url WHERE billing_invoices.organization_id=EXCLUDED.organization_id',
              [
                invoice.id,
                account.organization_id,
                invoice.currency,
                invoice.total,
                invoice.status,
                invoice.periodStart,
                invoice.periodEnd,
                invoice.url,
                invoice.created,
              ],
            );
        }
        await this.db.query(
          "UPDATE billing_events SET state='processed',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2",
          [event.id, lease],
        );
      } catch {
        this.onError('BILLING_RECONCILIATION_FAILED');
        await this.db.query(
          "UPDATE billing_events SET state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,error_code='PROVIDER_RECONCILIATION_FAILED',available_at=now()+interval '1 minute'*least(60,power(2,attempts)),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
          [event.id, lease],
        );
      }
    }
    for (let i = 0; i < 20; i++) {
      const lease = randomUUID();
      const [account] = await this.db.query(
        "UPDATE billing_accounts SET reconcile_lease=$1,reconcile_lease_until=now()+interval '2 minutes' WHERE organization_id IN(SELECT organization_id FROM billing_accounts WHERE provider_subscription_id IS NOT NULL AND reconcile_after<=now() AND (reconcile_lease_until IS NULL OR reconcile_lease_until<now()) ORDER BY reconcile_after,organization_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING organization_id,provider_subscription_id",
        [lease],
      );
      if (!account) break;
      try {
        await this.synchronize(String(account.provider_subscription_id), lease);
      } catch {
        this.onError('BILLING_PERIODIC_RECONCILIATION_FAILED');
      } finally {
        await this.db.query(
          "UPDATE billing_accounts SET reconcile_after=now()+interval '5 minutes',reconcile_lease=NULL,reconcile_lease_until=NULL WHERE organization_id=$1 AND reconcile_lease=$2",
          [account.organization_id, lease],
        );
      }
    }
  }
}
