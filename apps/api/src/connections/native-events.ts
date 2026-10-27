import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { IncomingHttpHeaders } from 'node:http';
import type { Sql } from '@ao/database';
import { AppError } from '../lib/errors.js';
import type { connectionEvent } from './events.js';
export const nativeEventProviders = ['github', 'gitlab', 'linear', 'stripe'] as const;
export type NativeEventProvider = (typeof nativeEventProviders)[number];
type NativeResourceEvent = Exclude<z.infer<typeof connectionEvent>, { kind: 'email.received' }>;
export const nativeHookContext = (workspace: string, id: string) =>
  `native-hook:${workspace}:${id}`;
const equal = (actual: string, expected: string) => {
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
function header(headers: IncomingHttpHeaders, key: string) {
  const v = headers[key];
  return typeof v === 'string' && v.length <= 1000 ? v : '';
}
function recent(timestamp: string, milliseconds = false, window = 300000, now = Date.now()) {
  return (
    /^\d{10,13}$/.test(timestamp) &&
    Math.abs(now - Number(timestamp) * (milliseconds ? 1 : 1000)) <= window
  );
}
const id = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9_-]+$/);
export function nativeEvent(
  provider: NativeEventProvider,
  secret: string,
  headers: IncomingHttpHeaders,
  raw: Buffer,
  now = Date.now(),
): NativeResourceEvent | null {
  const hmac = (body: Buffer | string, key: Buffer | string = secret) =>
    createHmac('sha256', key).update(body).digest('hex');
  let delivery = '';
  if (provider === 'github') {
    if (!equal(header(headers, 'x-hub-signature-256'), 'sha256=' + hmac(raw))) throw invalid();
    delivery = id.parse(header(headers, 'x-github-delivery'));
  } else if (provider === 'linear') {
    if (!equal(header(headers, 'linear-signature'), hmac(raw))) throw invalid();
    delivery = id.parse(header(headers, 'linear-delivery'));
  } else if (provider === 'gitlab') {
    delivery = id.parse(header(headers, 'webhook-id'));
    const timestamp = header(headers, 'webhook-timestamp');
    if (!/^whsec_[A-Za-z0-9+/]+=*$/.test(secret) || !recent(timestamp, false, 300000, now))
      throw invalid();
    const expected =
      'v1,' +
      createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
        .update(delivery + '.' + timestamp + '.')
        .update(raw)
        .digest('base64');
    if (
      !header(headers, 'webhook-signature')
        .split(' ')
        .some((signature) => equal(signature, expected))
    )
      throw invalid();
  } else {
    const fields = header(headers, 'stripe-signature')
        .split(',')
        .map((v) => v.trim()),
      timestamps = fields.filter((v) => v.startsWith('t='));
    if (timestamps.length !== 1) throw invalid();
    const timestamp = timestamps[0]!.slice(2);
    if (!recent(timestamp, false, 300000, now)) throw invalid();
    const expected = hmac(Buffer.concat([Buffer.from(timestamp + '.'), raw]));
    if (!fields.some((v) => v.startsWith('v1=') && equal(v.slice(3), expected))) throw invalid();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_EVENT_JSON', 'Send a valid signed JSON event.');
  }
  const object = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const row = object(value);
  let resource: string,
    deleted: boolean,
    operation = 'issue.read';
  if (provider === 'github') {
    if (header(headers, 'x-github-event') === 'ping') return null;
    if (header(headers, 'x-github-event') !== 'issues') return null;
    const parsed = z
      .object({
        action: z.string(),
        repository: z.object({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }),
        issue: z.object({ number: z.number().int().positive() }),
      })
      .parse(row);
    resource = parsed.repository.full_name + '/' + parsed.issue.number;
    deleted = parsed.action === 'deleted';
  } else if (provider === 'linear') {
    if (!recent(String(row.webhookTimestamp), true, 60000, now)) throw invalid();
    if (row.type !== 'Issue' || header(headers, 'linear-event') !== 'Issue') return null;
    resource = z.uuid().parse(object(row.data).id);
    deleted = row.action === 'remove';
  } else if (provider === 'gitlab') {
    if (row.object_kind !== 'issue' || header(headers, 'x-gitlab-event') !== 'Issue Hook')
      return null;
    const parsed = z
      .object({
        project: z.object({ id: z.number().int().positive() }),
        object_attributes: z.object({ iid: z.number().int().positive(), action: z.string() }),
      })
      .parse(row);
    resource = parsed.project.id + '/' + parsed.object_attributes.iid;
    deleted = parsed.object_attributes.action === 'delete';
  } else {
    delivery = id.parse(row.id);
    if (!['customer.updated', 'customer.deleted'].includes(String(row.type))) return null;
    resource = z
      .string()
      .regex(/^cus_[A-Za-z0-9]+$/)
      .parse(object(object(row.data).object).id);
    deleted = row.type === 'customer.deleted';
    operation = 'customer.read';
  }
  const eventId = 'native:' + provider + ':' + delivery;
  return deleted
    ? { eventId, kind: 'resource.deleted', resource }
    : { eventId, kind: 'resource.changed', resource, operation };
}
function invalid() {
  return new AppError(
    401,
    'INVALID_EVENT_SIGNATURE',
    'The native event signature is invalid or expired.',
  );
}
export async function currentNativeHook(
  tx: Sql,
  workspace: string,
  connection: string,
  version: number,
) {
  const [hook] = await tx.query(
    'SELECT 1 FROM connection_native_hooks WHERE workspace_id=$1 AND connection_id=$2 AND version=$3 AND enabled AND expires_at>now() FOR SHARE',
    [workspace, connection, version],
  );
  if (!hook)
    throw new AppError(
      409,
      'NATIVE_SUBSCRIPTION_REVOKED',
      'The native webhook subscription changed.',
    );
}
