import { z } from 'zod';
import type { ConnectorId, ConnectorOperation } from '@ao/contracts/connections';
import type { ProviderReceipt } from '../tools/provider.js';
import { AppError } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import {
  providerPlan,
  providerTransport,
  type ConnectorRequest,
  type Plan,
  type ProviderTransport,
  type ProviderResponse,
} from './provider.js';

const short = z.string().min(1).max(255),
  text = z.string().max(10000);
const schemas = {
  github: z
    .object({
      title: short.optional(),
      body: text.optional(),
      state: z.enum(['open', 'closed']).optional(),
    })
    .strict(),
  gitlab: z.object({ title: short.optional(), description: text.optional() }).strict(),
  linear: z.object({ title: short.optional(), description: text.optional() }).strict(),
  jira: z.object({ summary: short.optional() }).strict(),
  google_drive: z.object({ name: short.optional(), description: text.optional() }).strict(),
  microsoft365: z
    .object({
      name: short
        .refine((v) => !/[\\/\0]/.test(v), 'Use a file name without separators.')
        .optional(),
    })
    .strict(),
  hubspot: z
    .object({ firstname: z.string().max(255).optional(), lastname: z.string().max(255).optional() })
    .strict(),
  stripe: z.object({ description: text.optional() }).strict(),
  notion: z.object({ text: z.string().max(2000).optional() }).strict(),
};
type WriteProvider = keyof typeof schemas;
const details: Record<WriteProvider, { operation: string; scopes: string[]; format: string }> = {
  github: {
    operation: 'issue.update',
    scopes: ['Issues write permission (OAuth repo scope is broader)'],
    format: 'owner/repository/issue-number',
  },
  gitlab: { operation: 'issue.update', scopes: ['api'], format: 'project-id/issue-iid' },
  linear: { operation: 'issue.update', scopes: ['write'], format: 'issue UUID' },
  jira: { operation: 'issue.update', scopes: ['write:jira-work'], format: 'cloud-id/issue-key' },
  google_drive: {
    operation: 'file.update',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    format: 'Google Drive file ID',
  },
  microsoft365: {
    operation: 'item.rename',
    scopes: ['Files.ReadWrite'],
    format: 'drive-ID/item-ID',
  },
  hubspot: {
    operation: 'contact.update',
    scopes: ['crm.objects.contacts.write'],
    format: 'contact ID',
  },
  stripe: {
    operation: 'customer.update',
    scopes: ['Restricted key: Customers write'],
    format: 'customer ID',
  },
  notion: {
    operation: 'paragraph.replace',
    scopes: ['Update content capability'],
    format: 'paragraph block UUID',
  },
};
export function nativeOperations(provider: ConnectorId): ConnectorOperation[] {
  const d = details[provider as WriteProvider];
  if (!d) return [];
  return [
    {
      id: d.operation,
      label: d.operation.replace('.', ' '),
      effect: 'write',
      scopes: d.scopes,
      resourceFormat: d.format,
      fields: Object.keys(schemas[provider as WriteProvider].shape),
      idempotency: provider === 'stripe' ? 'provider-key' : 'postcondition',
    },
  ];
}
export interface NativeMutation {
  resource: string;
  patch: Record<string, string>;
  expected: Record<string, string>;
}
export function parseNativeMutation(
  provider: ConnectorId,
  operation: string,
  raw: string,
): NativeMutation {
  if (!nativeOperations(provider).some((o) => o.id === operation))
    throw new AppError(
      409,
      'NATIVE_OPERATION_UNAVAILABLE',
      'This provider has no implemented native write for that operation.',
    );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError(
      400,
      'INVALID_MUTATION',
      'Use a JSON object containing resource, patch and expected fields.',
    );
  }
  const input = z
    .object({
      resource: z.string().min(1).max(500),
      patch: z.record(z.string(), z.string().max(10000)),
      expected: z.record(z.string(), z.string().max(10000)),
    })
    .strict()
    .parse(value);
  const patch = schemas[provider as WriteProvider].parse(input.patch);
  if (provider === 'notion') z.uuid().parse(input.resource);
  const keys = Object.keys(patch).sort();
  if (!keys.length || JSON.stringify(keys) !== JSON.stringify(Object.keys(input.expected).sort()))
    throw new AppError(
      400,
      'EXPECTED_FIELDS_REQUIRED',
      'Review the previous value of every field being changed.',
    );
  providerPlan({
    provider,
    operation,
    resource: input.resource,
    credential: { accessToken: 'validation-only' },
    config: {},
    signal: AbortSignal.timeout(1),
  });
  return { ...input, patch: patch as Record<string, string> };
}
interface WritePlans {
  read: Plan;
  write: Plan;
  select(value: unknown): Record<string, unknown>;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function nativeWritePlans(
  input: ConnectorRequest,
  mutation: NativeMutation,
  key: string,
): WritePlans {
  const base = providerPlan(input),
    read: Plan = { ...base, headers: { ...base.headers }, plain: false };
  const write: Plan = {
    ...base,
    headers: { ...base.headers, 'content-type': 'application/json' },
    method: 'PATCH',
    body: JSON.stringify(mutation.patch),
    plain: false,
  };
  let select = (v: unknown) => object(v);
  if (input.provider === 'gitlab') write.method = 'PUT';
  if (input.provider === 'linear') {
    write.method = 'POST';
    write.body = JSON.stringify({
      query:
        'mutation OrbitUpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }',
      variables: { id: input.resource, input: mutation.patch },
    });
    select = (v) => {
      const row = object(v);
      if (row.errors) throw new Error('GraphQL read failed.');
      return object(object(row.data).issue);
    };
  }
  if (input.provider === 'jira') {
    write.url = new URL(base.url);
    write.url.search = '';
    write.method = 'PUT';
    write.body = JSON.stringify({ fields: mutation.patch });
    select = (v) => object(object(v).fields);
  }
  if (input.provider === 'google_drive') {
    const url = new URL(
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(input.resource),
    );
    url.searchParams.set('fields', 'id,name,description');
    read.url = url;
    read.method = 'GET';
    delete read.body;
    write.url = new URL(url);
  }
  if (input.provider === 'hubspot') {
    read.url = new URL(base.url);
    read.url.searchParams.set('properties', 'firstname,lastname');
    write.url = new URL(base.url);
    write.url.search = '';
    write.body = JSON.stringify({ properties: mutation.patch });
    select = (v) => object(object(v).properties);
  }
  if (input.provider === 'stripe') {
    write.method = 'POST';
    write.headers['content-type'] = 'application/x-www-form-urlencoded';
    write.headers['idempotency-key'] = key;
    write.body = new URLSearchParams(mutation.patch).toString();
  }
  if (input.provider === 'notion') {
    z.uuid().parse(input.resource);
    read.url = new URL('https://api.notion.com/v1/blocks/' + input.resource);
    read.method = 'GET';
    delete read.body;
    write.url = new URL(read.url);
    write.body = JSON.stringify({
      paragraph: { rich_text: [{ type: 'text', text: { content: mutation.patch.text } }] },
    });
    select = (value) => {
      const row = object(value),
        paragraph = object(row.paragraph);
      if (row.type !== 'paragraph' || !Array.isArray(paragraph.rich_text))
        throw new Error('Expected a plain paragraph block.');
      const content = paragraph.rich_text
        .map((item) => {
          const part = object(item),
            annotations = object(part.annotations);
          if (
            part.type !== 'text' ||
            object(part.text).link ||
            Object.entries(annotations).some(([key, v]) =>
              key === 'color' ? v !== 'default' : v === true,
            )
          )
            throw new Error('Formatted paragraphs require a separate operation.');
          return String(part.plain_text ?? object(part.text).content ?? '');
        })
        .join('');
      return { text: content };
    };
  }
  return { read, write, select };
}
function matches(value: Record<string, unknown>, fields: Record<string, string>) {
  return Object.entries(fields).every(
    ([key, expected]) =>
      (value[key] === null || value[key] === undefined ? '' : value[key]) === expected,
  );
}
export interface NativeWriteInput extends ConnectorRequest {
  mutation: NativeMutation;
  key: string;
  reconcile: boolean;
  guard(): Promise<void>;
  observe?(response: Pick<ProviderResponse, 'status' | 'retryAfter'>): Promise<void>;
}
export type NativeWriteProvider = (input: NativeWriteInput) => Promise<ProviderReceipt>;
export function nativeWriteProvider(
  transport: ProviderTransport = providerTransport,
): NativeWriteProvider {
  return async (input) => {
    let attempted = false;
    const receipt =
      'postcondition:' +
      digest(JSON.stringify([input.provider, input.resource, input.mutation.patch]));
    try {
      const plans = nativeWritePlans(input, input.mutation, input.key);
      const send = async (plan: Plan) => {
        const response = await transport(plan, input.signal);
        await input.observe?.(response);
        return response;
      };
      await input.guard();
      const before = await send(plans.read);
      if (before.status !== 200)
        return input.reconcile
          ? { status: 'unknown' }
          : { status: 'not_applied', receipt: 'preflight-rejected:' + input.key };
      const current = plans.select(JSON.parse(before.body));
      if (matches(current, input.mutation.patch)) return { status: 'succeeded', receipt };
      if (input.reconcile) return { status: 'unknown' };
      if (!matches(current, input.mutation.expected))
        return { status: 'not_applied', receipt: 'precondition-changed:' + input.key };
      if (['microsoft365', 'google_drive'].includes(input.provider) && before.etag)
        plans.write.headers['if-match'] = before.etag;
      await input.guard();
      attempted = true;
      const response = await send(plans.write);
      if ([400, 401, 403, 404, 412, 422, 429].includes(response.status))
        return { status: 'not_applied', receipt: 'provider-rejected:' + input.key };
      if (response.status < 200 || response.status >= 300) return { status: 'unknown' };
      if (input.provider === 'linear') {
        const result = object(JSON.parse(response.body));
        if (result.errors || object(object(result.data).issueUpdate).success !== true)
          return { status: 'unknown' };
      }
      await input.guard();
      const after = await send(plans.read);
      if (
        after.status !== 200 ||
        !matches(plans.select(JSON.parse(after.body)), input.mutation.patch)
      )
        return { status: 'unknown' };
      return { status: 'succeeded', receipt };
    } catch {
      return attempted || input.reconcile
        ? { status: 'unknown' }
        : { status: 'not_applied', receipt: 'preflight-failed:' + input.key };
    }
  };
}
