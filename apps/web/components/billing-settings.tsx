'use client';
import { useCallback, useEffect, useState } from 'react';
import type { BillingSummary } from '@ao/contracts/billing';
import { api, post, HttpError } from '../lib/api';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
interface Command {
  key: string;
  kind: 'checkout' | 'portal' | 'cancel' | 'plan_change';
  plan?: 'team' | 'enterprise';
  acknowledgeProration?: boolean;
  quoteId?: string;
}
interface Invoice {
  id: string;
  currency: string;
  total_minor: string;
  status: string;
  hosted_url: string | null;
  issued_at: string;
}
const units: Record<string, string> = {
  models: 'tokens',
  tools: 'invocations',
  runtime: 'seconds',
  storage: 'allocated bytes',
  media: 'participant seconds',
};
const money = (micros: string) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(BigInt(micros)) / 1000000);
export function BillingSettings({ organizationId }: { organizationId: string }) {
  const [summary, setSummary] = useState<BillingSummary>(),
    [invoices, setInvoices] = useState<Invoice[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState<Command>(),
    [plan, setPlan] = useState<'team' | 'enterprise'>('team'),
    [quote, setQuote] = useState<{ id: string; amount: number; currency: string }>();
  const path = `/organizations/${organizationId}/billing`;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const options = signal ? { signal } : {};
      const [data, rows, commands] = await Promise.all([
        api<BillingSummary>(path, options),
        api<Invoice[]>(path + '/invoices', options),
        api<(Command & { state: string })[]>(path + '/commands', options),
      ]);
      const held = commands.find((c) =>
        ['pending', 'sending', 'outcome_unknown'].includes(c.state),
      );
      setPending(
        held
          ? {
              key: held.key,
              kind: held.kind,
              ...(held.plan ? { plan: held.plan } : {}),
              ...(held.kind === 'plan_change' ? { acknowledgeProration: true } : {}),
            }
          : undefined,
      );
      setSummary(data);
      setInvoices(rows);
    },
    [path],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Unable to load billing.');
    });
    return () => controller.abort();
  }, [refresh]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update billing.');
    } finally {
      setBusy(false);
    }
  }
  async function command(input: Command) {
    setPending(input);
    try {
      const result = await post<{ url: string | null }>(path + '/commands', input);
      setPending(undefined);
      setQuote(undefined);
      if (result.url) {
        const url = new URL(result.url);
        if (
          url.protocol !== 'https:' ||
          !['checkout.stripe.com', 'billing.stripe.com'].includes(url.hostname)
        )
          throw new Error('The provider returned an invalid address.');
        window.location.assign(url.href);
      } else
        setMessage('Request accepted. Subscription changes appear after provider confirmation.');
    } catch (e) {
      if (e instanceof HttpError && e.code === 'BILLING_REJECTED') setPending(undefined);
      throw e;
    }
  }
  return (
    <Card asChild>
      <section className="settings-card commercial-panel" aria-label="Billing and usage">
        <div>
          <span className="eyebrow">COMMERCIAL CONTROLS</span>
          <h3>Plan & usage</h3>
          <p className="muted">Organization-wide seats, allowances, and spending controls.</p>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {!summary ? (
          <p role="status">Loading billing…</p>
        ) : (
          <>
            <div className="commercial-metrics">
              <div>
                <small>Current plan</small>
                <strong>{summary.mode === 'self_hosted' ? 'Self-hosted' : summary.plan}</strong>
                <span>{summary.status}</span>
              </div>
              <div>
                <small>Human seats</small>
                <strong>{summary.seats}</strong>
                <span>
                  {summary.mode === 'self_hosted'
                    ? 'Unlimited seats'
                    : `of ${summary.seatLimit.toLocaleString()}`}
                </span>
              </div>
              <div>
                <small>Recorded spend</small>
                <strong>{money(summary.spentMicros)}</strong>
                <span>{money(summary.reservedMicros)} reserved</span>
              </div>
              <div>
                <small>Period forecast</small>
                <strong>{money(summary.forecastMicros)}</strong>
                <span>Based on recorded usage</span>
              </div>
            </div>
            {summary.warnings.length > 0 && (
              <p role="status" className="runtime-notice">
                {summary.warnings.map((w) => w.replaceAll('_', ' ')).join(' · ')}. Unpriced meters
                are excluded from spending estimates.
              </p>
            )}
            <p className="muted">
              Period {new Date(summary.periodStart).toLocaleDateString()} –{' '}
              {new Date(summary.periodEnd).toLocaleDateString()}. People in multiple workspaces
              count once.
            </p>
            <ul className="commercial-usage" aria-label="Usage by category">
              {summary.usage.map((row) => (
                <li key={row.category}>
                  <strong>{row.category}</strong>
                  <span>
                    {BigInt(row.units).toLocaleString()} {units[row.category]} ·{' '}
                    {BigInt(row.reservedUnits).toLocaleString()} reserved
                  </span>
                  <small>
                    {summary.mode === 'managed'
                      ? `${summary.allowances[row.category]?.toLocaleString()} allowance`
                      : 'Operator managed'}
                  </small>
                </li>
              ))}
            </ul>
            <form
              key={summary.version}
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget),
                  value = String(form.get('budget')).trim();
                void perform(async () => {
                  await api(path + '/budget', {
                    method: 'PUT',
                    body: JSON.stringify({
                      version: summary.version,
                      budgetMicros: value || null,
                      warningPercent: Number(form.get('warning')),
                    }),
                  });
                  setMessage('Spending controls saved.');
                });
              }}
            >
              <label>
                Hard budget in USD microdollars
                <Input
                  name="budget"
                  inputMode="numeric"
                  pattern="[0-9]{1,15}"
                  defaultValue={summary.budgetMicros ?? ''}
                  placeholder="No organization hard cap"
                />
                <small>
                  1,000,000 microdollars = $1. Admissions include outstanding reservations.
                </small>
              </label>
              <label>
                Warning threshold (%)
                <Input
                  name="warning"
                  type="number"
                  min={1}
                  max={99}
                  defaultValue={summary.warningPercent}
                  required
                />
              </label>
              <Button disabled={busy}>Save spending controls</Button>
            </form>
            <div className="commercial-actions">
              <label>
                Plan
                <NativeSelect
                  value={plan}
                  onChange={(e) => {
                    setPlan(e.target.value as typeof plan);
                    setQuote(undefined);
                  }}
                >
                  <option value="team">Team</option>
                  <option value="enterprise">Enterprise</option>
                </NativeSelect>
              </label>
              {summary.status === 'free' && (
                <Button
                  disabled={busy || Boolean(pending)}
                  variant="outline"
                  onClick={() =>
                    void perform(async () => {
                      await post(path + '/trial', { clientId: crypto.randomUUID() });
                      setMessage('Your 14-day Team trial has started.');
                    })
                  }
                >
                  Start 14-day trial
                </Button>
              )}
              {summary.checkoutAvailable ? (
                <>
                  <Button
                    disabled={busy || Boolean(pending) || summary.status === 'active'}
                    onClick={() =>
                      void perform(() =>
                        command({ key: crypto.randomUUID(), kind: 'checkout', plan }),
                      )
                    }
                  >
                    Continue to checkout
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || Boolean(pending)}
                    onClick={() =>
                      void perform(() => command({ key: crypto.randomUUID(), kind: 'portal' }))
                    }
                  >
                    Customer portal
                  </Button>
                  {summary.status === 'active' && (
                    <>
                      <Button
                        variant="outline"
                        disabled={busy || Boolean(pending)}
                        onClick={() =>
                          void perform(async () => {
                            setQuote(await post(path + '/preview', { plan }));
                          })
                        }
                      >
                        Preview plan change
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy || Boolean(pending)}
                        onClick={() =>
                          void perform(() => command({ key: crypto.randomUUID(), kind: 'cancel' }))
                        }
                      >
                        Cancel at period end
                      </Button>
                    </>
                  )}
                </>
              ) : (
                <p className="muted">
                  Payments are awaiting provider setup. No checkout or live charge is available.
                </p>
              )}
              {pending && (
                <Button disabled={busy} onClick={() => void perform(() => command(pending))}>
                  Retry pending request safely
                </Button>
              )}
            </div>
            {quote && (
              <div className="runtime-notice">
                <p>
                  Provider preview:{' '}
                  {new Intl.NumberFormat(undefined, {
                    style: 'currency',
                    currency: quote.currency,
                  }).format(quote.amount / 100)}{' '}
                  due. Provider credits and the final invoice may affect the total.
                </p>
                <Button
                  disabled={busy || Boolean(pending)}
                  onClick={() =>
                    void perform(() =>
                      command({
                        key: crypto.randomUUID(),
                        kind: 'plan_change',
                        plan,
                        quoteId: quote.id,
                        acknowledgeProration: true,
                      }),
                    )
                  }
                >
                  Confirm plan change with proration
                </Button>
              </div>
            )}
            <details>
              <summary>Invoices ({invoices.length})</summary>
              <ul>
                {invoices.map((invoice) => (
                  <li key={invoice.id}>
                    {new Date(invoice.issued_at).toLocaleDateString()} ·{' '}
                    {new Intl.NumberFormat(undefined, {
                      style: 'currency',
                      currency: invoice.currency,
                    }).format(Number(invoice.total_minor) / 100)}{' '}
                    · {invoice.status}{' '}
                    {invoice.hosted_url && (
                      <a href={invoice.hosted_url} target="_blank" rel="noreferrer">
                        Open invoice
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              {!invoices.length && <p className="muted">No invoices yet.</p>}
            </details>
            <a href={`/api/v1${path}/export`}>Export usage and billing records</a>
          </>
        )}
      </section>
    </Card>
  );
}
