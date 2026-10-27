import Stripe from 'stripe';
import { AppError } from '../lib/errors.js';
export interface CommerceRequest {
  organizationId: string;
  customerId: string | null;
  subscriptionId: string | null;
  seats: number;
  plan?: 'team' | 'enterprise';
  priceId?: string;
  prorationDate?: number;
}
export interface SubscriptionSnapshot {
  id: string;
  organizationId: string;
  customerId: string;
  plan: 'team' | 'enterprise';
  status: 'active' | 'trialing' | 'past_due' | 'cancelled';
  periodStart: number;
  periodEnd: number;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
  quantity: number;
}
export interface CommerceProvider {
  priceReference(plan: 'team' | 'enterprise'): string;
  execute(
    kind: 'checkout' | 'portal' | 'cancel' | 'plan_change',
    input: CommerceRequest,
    key: string,
  ): Promise<{ id: string; url?: string }>;
  verify(
    payload: Buffer,
    signature: string,
  ): { id: string; subscriptionId?: string; invoiceId?: string };
  subscription(id: string): Promise<SubscriptionSnapshot>;
  invoice(id: string): Promise<{
    id: string;
    customerId: string;
    currency: string;
    total: number;
    status: string;
    url: string | null;
    periodStart: number;
    periodEnd: number;
    created: number;
  }>;
  seats(subscriptionId: string, quantity: number, key: string): Promise<void>;
  preview(
    subscriptionId: string,
    plan: 'team' | 'enterprise',
    seats: number,
  ): Promise<{ amount: number; currency: string; prorationDate: number; priceId: string }>;
}
function external(url: string, hostname: string) {
  const u = new URL(url);
  if (
    u.protocol !== 'https:' ||
    Boolean(u.port) ||
    u.hostname !== hostname ||
    u.username ||
    u.password
  )
    throw new Error('Untrusted payment URL.');
  return url;
}
export class StripeCommerce implements CommerceProvider {
  readonly client: Stripe;
  constructor(
    secret: string,
    private readonly prices: Partial<Record<'team' | 'enterprise', string>>,
    private readonly webhookSecret: string,
    private readonly origin: string,
    request?: typeof fetch,
  ) {
    this.client = new Stripe(secret, {
      maxNetworkRetries: 0,
      timeout: 10000,
      ...(request ? { httpClient: Stripe.createFetchHttpClient(request) } : {}),
    });
  }
  priceReference(plan: 'team' | 'enterprise') {
    return this.price(plan);
  }
  private price(plan: 'team' | 'enterprise' | undefined) {
    const value = plan && this.prices[plan];
    if (!value)
      throw new AppError(503, 'PLAN_UNAVAILABLE', 'This plan is not configured for checkout.');
    return value;
  }
  async execute(
    kind: 'checkout' | 'portal' | 'cancel' | 'plan_change',
    input: CommerceRequest,
    key: string,
  ) {
    try {
      return await this.perform(kind, input, key);
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeError &&
        error.statusCode &&
        [400, 401, 402, 403, 404, 422].includes(error.statusCode)
      )
        throw new AppError(
          422,
          'PAYMENT_PROVIDER_REJECTED',
          'The payment provider rejected the request. Check the configured account and price.',
        );
      throw error;
    }
  }
  private async perform(
    kind: 'checkout' | 'portal' | 'cancel' | 'plan_change',
    input: CommerceRequest,
    key: string,
  ) {
    if (kind === 'checkout') {
      const priceId = input.priceId ?? this.price(input.plan),
        price = await this.client.prices.retrieve(priceId);
      if (price.currency !== 'usd' || !price.recurring || !price.active)
        throw new AppError(503, 'PRICE_NOT_QUALIFIED', 'Configure an active recurring USD price.');
      const session = await this.client.checkout.sessions.create(
        {
          mode: 'subscription',
          client_reference_id: input.organizationId,
          ...(input.customerId ? { customer: input.customerId } : {}),
          line_items: [{ price: priceId, quantity: input.seats }],
          subscription_data: { metadata: { organizationId: input.organizationId } },
          success_url: this.origin + '/app?billing=return',
          cancel_url: this.origin + '/app?billing=cancelled',
        },
        { idempotencyKey: key },
      );
      if (!session.url) throw new Error('Checkout outcome requires reconciliation.');
      return { id: session.id, url: external(session.url, 'checkout.stripe.com') };
    }
    if (kind === 'portal') {
      if (!input.customerId)
        throw new AppError(
          409,
          'CUSTOMER_REQUIRED',
          'Create a subscription before opening customer administration.',
        );
      const session = await this.client.billingPortal.sessions.create(
        { customer: input.customerId, return_url: this.origin + '/app' },
        { idempotencyKey: key },
      );
      return { id: session.id, url: external(session.url, 'billing.stripe.com') };
    }
    if (!input.subscriptionId)
      throw new AppError(409, 'SUBSCRIPTION_REQUIRED', 'There is no subscription to update.');
    if (kind === 'cancel') {
      const sub = await this.client.subscriptions.update(
        input.subscriptionId,
        { cancel_at_period_end: true },
        { idempotencyKey: key },
      );
      return { id: sub.id };
    }
    const sub = await this.client.subscriptions.retrieve(input.subscriptionId);
    if (sub.items.data.length !== 1)
      throw new AppError(
        409,
        'SUBSCRIPTION_REVIEW_REQUIRED',
        'Review this subscription in customer administration.',
      );
    const changed = await this.client.subscriptions.update(
      sub.id,
      {
        items: [
          {
            id: sub.items.data[0]!.id,
            price: input.priceId ?? this.price(input.plan),
            quantity: input.seats,
          },
        ],
        proration_behavior: 'create_prorations',
        ...(input.prorationDate ? { proration_date: input.prorationDate } : {}),
        payment_behavior: 'pending_if_incomplete',
      },
      { idempotencyKey: key },
    );
    return { id: changed.id };
  }
  verify(payload: Buffer, signature: string) {
    const event = this.client.webhooks.constructEvent(payload, signature, this.webhookSecret, 300),
      object = event.data.object as unknown as Record<string, unknown>;
    if (event.type.startsWith('customer.subscription.'))
      return { id: event.id, subscriptionId: String(object.id) };
    if (event.type.startsWith('invoice.')) return { id: event.id, invoiceId: String(object.id) };
    if (event.type === 'checkout.session.completed' && typeof object.subscription === 'string')
      return { id: event.id, subscriptionId: object.subscription };
    return { id: event.id };
  }
  async subscription(id: string): Promise<SubscriptionSnapshot> {
    const sub = await this.client.subscriptions.retrieve(id);
    if (sub.items.data.length !== 1) throw new Error('Unsupported subscription items.');
    const item = sub.items.data[0]!,
      plan = Object.entries(this.prices).find(([, price]) => price === item.price.id)?.[0];
    if (!plan || !sub.metadata.organizationId) throw new Error('Unmapped subscription.');
    return {
      id: sub.id,
      organizationId: sub.metadata.organizationId,
      customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
      plan: plan as 'team' | 'enterprise',
      status:
        sub.status === 'active'
          ? 'active'
          : sub.status === 'trialing'
            ? 'trialing'
            : ['canceled', 'incomplete_expired'].includes(sub.status)
              ? 'cancelled'
              : 'past_due',
      periodStart: item.current_period_start,
      periodEnd: item.current_period_end,
      trialEnd: sub.trial_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      quantity: item.quantity ?? 1,
    };
  }
  async invoice(id: string) {
    const invoice = await this.client.invoices.retrieve(id);
    if (!invoice.customer) throw new Error('Invoice customer missing.');
    return {
      id: invoice.id,
      customerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id,
      currency: invoice.currency,
      total: invoice.total,
      status: invoice.status ?? 'draft',
      url: invoice.hosted_invoice_url
        ? external(invoice.hosted_invoice_url, 'invoice.stripe.com')
        : null,
      periodStart: invoice.period_start,
      periodEnd: invoice.period_end,
      created: invoice.created,
    };
  }
  async seats(id: string, quantity: number, key: string) {
    const sub = await this.client.subscriptions.retrieve(id);
    if (sub.items.data.length !== 1 || !['active', 'trialing'].includes(sub.status)) return;
    const item = sub.items.data[0]!;
    if (item.quantity !== quantity)
      await this.client.subscriptions.update(
        id,
        { items: [{ id: item.id, quantity }], proration_behavior: 'create_prorations' },
        { idempotencyKey: key },
      );
  }
  async preview(id: string, plan: 'team' | 'enterprise', seats: number) {
    const sub = await this.client.subscriptions.retrieve(id);
    if (sub.items.data.length !== 1)
      throw new AppError(
        409,
        'SUBSCRIPTION_REVIEW_REQUIRED',
        'Review this subscription in customer administration.',
      );
    const prorationDate = Math.floor(Date.now() / 1000),
      priceId = this.price(plan);
    const invoice = await this.client.invoices.createPreview({
      subscription: id,
      subscription_details: {
        items: [{ id: sub.items.data[0]!.id, price: priceId, quantity: seats }],
        proration_behavior: 'create_prorations',
        proration_date: prorationDate,
      },
    });
    return { amount: invoice.amount_due, currency: invoice.currency, prorationDate, priceId };
  }
}
export function configuredCommerce(
  env: NodeJS.ProcessEnv,
  origin: string,
): CommerceProvider | undefined {
  if (!env.STRIPE_SECRET_KEY) return undefined;
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required.');
  if (env.STRIPE_SECRET_KEY.startsWith('sk_live_') && env.STRIPE_LIVE_ENABLED !== 'true')
    throw new Error('Live Stripe credentials require explicit STRIPE_LIVE_ENABLED.');
  return new StripeCommerce(
    env.STRIPE_SECRET_KEY,
    {
      ...(env.STRIPE_TEAM_PRICE_ID ? { team: env.STRIPE_TEAM_PRICE_ID } : {}),
      ...(env.STRIPE_ENTERPRISE_PRICE_ID ? { enterprise: env.STRIPE_ENTERPRISE_PRICE_ID } : {}),
    },
    env.STRIPE_WEBHOOK_SECRET,
    origin,
  );
}
