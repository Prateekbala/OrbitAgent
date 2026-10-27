import { Agent, request } from 'undici';
import type { ConnectorId } from '@ao/contracts/connections';
import { validatePublicEndpoint } from '../lib/safe-endpoint.js';
import { AppError } from '../lib/errors.js';
import { readNotion } from './notion.js';
import { ProviderFailure } from './provider-errors.js';
export { ProviderFailure } from './provider-errors.js';
export interface ProviderDocument {
  title: string;
  body: string;
  sourceUrl?: string;
  providerVersion?: string;
  truncated?: boolean;
}
export interface Credential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: 'Bearer' | 'raw';
  writeAllowed?: boolean;
  scopes?: string[];
}
export interface ConnectorRequest {
  provider: ConnectorId;
  operation: string;
  resource: string;
  credential: Credential;
  config: Record<string, string>;
  signal: AbortSignal;
  guard?: () => Promise<void>;
}
export interface ConnectorProvider {
  read(input: ConnectorRequest): Promise<ProviderDocument>;
}
export interface Plan {
  url: URL;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  headers: Record<string, string>;
  body?: string;
  plain?: boolean;
}
function parts(resource: string, count: number) {
  const values = resource.split('/');
  if (
    values.length !== count ||
    values.some((v) => !v || !/^[A-Za-z0-9_!.~-]+$/.test(v) || v === '.' || v === '..')
  )
    throw new AppError(
      400,
      'INVALID_RESOURCE',
      'Use the resource format documented in the connector catalog.',
    );
  return values.map((v) => encodeURIComponent(v));
}
function subdomain(value: string | undefined) {
  if (!value || !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(value))
    throw new AppError(400, 'INVALID_PROVIDER_ACCOUNT', 'Use the provider account subdomain.');
  return value;
}
function credentialObject(value: string, fields: string[]) {
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new AppError(
      400,
      'CREDENTIAL_FORMAT',
      'This provider requires a JSON credential with the documented fields.',
    );
  }
  const row = object(input);
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((k) => typeof row[k] !== 'string' || !row[k] || /[\r\n]/.test(String(row[k])))
  )
    throw new AppError(400, 'CREDENTIAL_FORMAT', 'Use exactly the documented credential fields.');
  return row as Record<string, string>;
}
export function providerPlan(input: ConnectorRequest, databaseHosts: string[] = []): Plan {
  const { provider, resource, credential } = input;
  const headers: Record<string, string> = {
    authorization:
      provider === 'linear' && credential.tokenType === 'raw'
        ? credential.accessToken
        : `Bearer ${credential.accessToken}`,
    accept: 'application/json',
  };
  let path: string;
  let body: string | undefined;
  switch (provider) {
    case 'github': {
      const [owner, repo, id] = parts(resource, 3);
      path = `https://api.github.com/repos/${owner}/${repo}/issues/${id}`;
      headers['x-github-api-version'] = '2022-11-28';
      break;
    }
    case 'gitlab': {
      const [project, id] = parts(resource, 2);
      path = `https://gitlab.com/api/v4/projects/${project}/issues/${id}`;
      break;
    }
    case 'linear':
      parts(resource, 1);
      path = 'https://api.linear.app/graphql';
      body = JSON.stringify({
        query:
          'query OrbitIssue($id: String!) { issue(id: $id) { id title description url updatedAt } }',
        variables: { id: resource },
      });
      break;
    case 'jira': {
      const [cloud, id] = parts(resource, 2);
      path = `https://api.atlassian.com/ex/jira/${cloud}/rest/api/3/issue/${id}?fields=summary,description,updated`;
      break;
    }
    case 'sentry':
      parts(resource, 1);
      path = `https://sentry.io/api/0/issues/${encodeURIComponent(resource)}/`;
      break;
    case 'vercel':
      parts(resource, 1);
      path = `https://api.vercel.com/v13/deployments/${encodeURIComponent(resource)}`;
      break;
    case 'notion':
      parts(resource, 1);
      path = `https://api.notion.com/v1/blocks/${encodeURIComponent(resource)}/children?page_size=100`;
      headers['notion-version'] = '2022-06-28';
      break;
    case 'google_drive':
      parts(resource, 1);
      path = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(resource)}/export?mimeType=text%2Fplain`;
      return { url: new URL(path), method: 'GET', headers, plain: true };
    case 'fireflies':
      parts(resource, 1);
      path = 'https://api.fireflies.ai/graphql';
      body = JSON.stringify({
        query:
          'query OrbitTranscript($id: String!) { transcript(id: $id) { id title transcript_url sentences { text } } }',
        variables: { id: resource },
      });
      break;
    case 'hubspot':
      parts(resource, 1);
      path = `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(resource)}?properties=firstname,lastname,email`;
      break;
    case 'attio': {
      const [object, id] = parts(resource, 2);
      path = `https://api.attio.com/v2/objects/${object}/records/${id}`;
      break;
    }
    case 'stripe':
      parts(resource, 1);
      path = `https://api.stripe.com/v1/customers/${encodeURIComponent(resource)}`;
      break;
    case 'posthog': {
      const [project, id] = parts(resource, 2);
      path = `https://us.posthog.com/api/projects/${project}/insights/${id}/`;
      break;
    }
    case 'honeycomb':
      parts(resource, 1);
      path = `https://api.honeycomb.io/1/boards/${encodeURIComponent(resource)}`;
      delete headers.authorization;
      headers['x-honeycomb-team'] = credential.accessToken;
      break;
    case 'datadog': {
      parts(resource, 1);
      const keys = credentialObject(credential.accessToken, ['apiKey', 'applicationKey']);
      path = `https://api.datadoghq.com/api/v1/monitor/${encodeURIComponent(resource)}`;
      delete headers.authorization;
      headers['dd-api-key'] = keys.apiKey!;
      headers['dd-application-key'] = keys.applicationKey!;
      break;
    }
    case 'microsoft365': {
      const [drive, item] = parts(resource, 2);
      path = `https://graph.microsoft.com/v1.0/drives/${drive}/items/${item}`;
      break;
    }
    case 'granola':
      parts(resource, 1);
      path = `https://public-api.granola.ai/v1/notes/${encodeURIComponent(resource)}?include=transcript`;
      break;
    case 'fathom':
      parts(resource, 1);
      path = `https://api.fathom.ai/external/v1/recordings/${encodeURIComponent(resource)}/transcript`;
      delete headers.authorization;
      headers['x-api-key'] = credential.accessToken;
      break;
    case 'ramp':
      parts(resource, 1);
      path = `https://api.ramp.com/developer/v1/transactions/${encodeURIComponent(resource)}`;
      break;
    case 'shopify': {
      parts(resource, 1);
      if (!/^\d+$/.test(resource))
        throw new AppError(400, 'INVALID_RESOURCE', 'Use a numeric product ID.');
      const shop = subdomain(input.config.shop);
      path = `https://${shop}.myshopify.com/admin/api/2026-10/graphql.json`;
      delete headers.authorization;
      headers['x-shopify-access-token'] = credential.accessToken;
      body = JSON.stringify({
        query:
          'query OrbitProduct($id: ID!) { product(id: $id) { id title description onlineStoreUrl updatedAt } }',
        variables: { id: 'gid://shopify/Product/' + resource },
      });
      break;
    }
    case 'zendesk':
      parts(resource, 1);
      path = `https://${subdomain(input.config.subdomain)}.zendesk.com/api/v2/tickets/${encodeURIComponent(resource)}.json`;
      break;
    case 'hex':
      parts(resource, 1);
      path = `https://app.hex.tech/api/v1/projects/${encodeURIComponent(resource)}`;
      break;
    case 'supabase': {
      if (
        !/^[a-z0-9]{20}$/.test(input.config.projectRef ?? '') ||
        !/^[A-Za-z_]\w{0,62}$/.test(input.config.table ?? '')
      )
        throw new AppError(
          400,
          'INVALID_DATABASE_RESOURCE',
          'Choose an explicit project and approved table.',
        );
      const columns = (input.config.columns ?? '').split(',').map((v) => v.trim());
      if (
        !columns.length ||
        columns.length > 20 ||
        columns.some(
          (c) =>
            !/^[A-Za-z_]\w{0,62}$/.test(c) ||
            /(password|secret|token|credential|api_key|authorization)/i.test(c),
        )
      )
        throw new AppError(
          400,
          'INVALID_DATABASE_COLUMNS',
          'Choose up to 20 approved nonsensitive columns.',
        );
      if (!/^[0-9a-f-]{36}$/i.test(resource))
        throw new AppError(400, 'INVALID_RESOURCE', 'Use a row UUID.');
      const keys = credentialObject(credential.accessToken, ['apiKey', 'accessToken']);
      let claims: Record<string, unknown>;
      try {
        claims = JSON.parse(
          Buffer.from(keys.accessToken!.split('.')[1] ?? '', 'base64url').toString('utf8'),
        ) as Record<string, unknown>;
      } catch {
        throw new AppError(
          400,
          'DELEGATED_DATABASE_IDENTITY_REQUIRED',
          'Use a delegated authenticated user JWT.',
        );
      }
      if (claims.role !== 'authenticated' || !keys.apiKey!.startsWith('sb_publishable_'))
        throw new AppError(
          400,
          'DELEGATED_DATABASE_IDENTITY_REQUIRED',
          'Use a publishable API key and a delegated authenticated user JWT. Secret and service-role keys are prohibited.',
        );
      path =
        `https://${input.config.projectRef}.supabase.co/rest/v1/${encodeURIComponent(input.config.table!)}?` +
        new URLSearchParams({ id: 'eq.' + resource, select: columns.join(','), limit: '1' });
      headers.apikey = keys.apiKey!;
      headers.authorization = 'Bearer ' + keys.accessToken!;
      break;
    }
    case 'database': {
      parts(resource, 1);
      let endpoint: URL;
      try {
        endpoint = new URL(input.config.endpoint ?? '');
      } catch {
        throw new AppError(
          400,
          'INVALID_DATABASE_PROXY',
          'Configure an operator-approved read proxy.',
        );
      }
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        (endpoint.port && endpoint.port !== '443') ||
        !databaseHosts.includes(endpoint.hostname) ||
        !/^\/[A-Za-z0-9/_-]*$/.test(endpoint.pathname) ||
        !/^[A-Za-z_]\w{0,62}$/.test(input.config.query ?? '')
      )
        throw new AppError(
          400,
          'DATABASE_PROXY_DENIED',
          'Use an operator-approved HTTPS read proxy and a named parameterized query.',
        );
      endpoint.pathname =
        endpoint.pathname.replace(/\/$/, '') +
        '/queries/' +
        encodeURIComponent(input.config.query!) +
        '/records/' +
        encodeURIComponent(resource);
      path = endpoint.href;
      break;
    }
    default:
      throw new AppError(
        409,
        'CONNECTOR_NOT_IMPLEMENTED',
        'This catalog entry has no native read adapter.',
      );
  }
  if (body) headers['content-type'] = 'application/json';
  return { url: new URL(path), method: body ? 'POST' : 'GET', headers, ...(body ? { body } : {}) };
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, depth = 0): string {
  if (depth > 10) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((v) => text(v, depth + 1))
      .filter(Boolean)
      .join('\n');
  const row = object(value);
  return [
    'text',
    'plain_text',
    'content',
    'description',
    'rich_text',
    'sentences',
    'title',
    'paragraph',
    'heading_1',
    'heading_2',
    'heading_3',
    'bulleted_list_item',
    'numbered_list_item',
    'quote',
    'code',
    'to_do',
  ]
    .map((k) => (row[k] === undefined ? '' : text(row[k], depth + 1)))
    .filter(Boolean)
    .join('\n');
}
function link(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) =>
        /token|secret|signature|credential|auth|key/i.test(key),
      )
    )
      return undefined;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}
export function normalizeDocument(
  provider: ConnectorId,
  resource: string,
  value: unknown,
): ProviderDocument {
  let row = object(value);
  if (row.errors) throw new ProviderFailure('PROVIDER_QUERY_FAILED');
  if (provider === 'linear') row = object(object(row.data).issue);
  if (provider === 'fireflies') row = object(object(row.data).transcript);
  if (provider === 'attio') row = object(row.data);
  if (provider === 'shopify') row = object(object(row.data).product);
  if (provider === 'zendesk') row = object(row.ticket);
  if (provider === 'ramp') row = object(row.data ?? row);
  if (provider === 'supabase') row = object(Array.isArray(value) ? value[0] : null);
  let title = String(row.title ?? row.name ?? row.subject ?? resource),
    body = '';
  if (provider === 'notion')
    body = text(
      (Array.isArray(row.results) ? row.results : []).map((v) => {
        const r = object(v);
        return r[String(r.type)];
      }),
    );
  else if (provider === 'jira') {
    title = String(object(row.fields).summary ?? resource);
    body = text(object(row.fields).description);
  } else if (provider === 'hubspot') {
    const p = object(row.properties);
    title = [p.firstname, p.lastname].filter(Boolean).join(' ') || resource;
    body = String(p.email ?? '');
  } else if (provider === 'stripe')
    body = [row.name, row.description, row.email].filter((v) => typeof v === 'string').join('\n');
  else if (provider === 'attio')
    body = text(
      Object.values(object(row.values)).map((v) =>
        Array.isArray(v) ? v.map((x) => object(x).value ?? object(x).full_name) : [],
      ),
    );
  else if (provider === 'granola')
    body = text([row.summary_text, row.summary_markdown, row.transcript]);
  else if (provider === 'fathom') body = text(row.transcript);
  else if (provider === 'microsoft365') body = text(row.description);
  else if (provider === 'datadog') body = text([row.message, row.query]);
  else if (provider === 'ramp') {
    title = String(row.merchant_name ?? resource);
    body = [row.memo, row.state, row.amount]
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .join('\n');
  } else if (provider === 'supabase')
    body = Object.entries(row)
      .map(
        ([key, value]) =>
          key +
          ': ' +
          (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : ''),
      )
      .join('\n');
  else if (provider === 'vercel')
    body = `Deployment ${String(row.name ?? resource)}\nState: ${String(row.readyState ?? 'unknown')}\nTarget: ${String(row.target ?? 'preview')}`;
  else body = text(row.description ?? row.body ?? row.sentences ?? row.title ?? row.name);
  const sourceUrl = link(
    row.html_url ??
      row.web_url ??
      row.webUrl ??
      row.url ??
      row.transcript_url ??
      row.onlineStoreUrl,
  );
  return {
    title: title.slice(0, 500),
    body: body.slice(0, 1000000),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(typeof row.updated_at === 'string' ? { providerVersion: row.updated_at } : {}),
    truncated:
      row.has_more === true ||
      row.hasMore === true ||
      (provider === 'notion' &&
        Array.isArray(row.results) &&
        row.results.some((v) => object(v).has_children === true)) ||
      body.length > 1000000,
  };
}
export interface ProviderResponse {
  status: number;
  body: string;
  retryAfter: number;
  etag?: string;
}
export type ProviderTransport = (plan: Plan, signal: AbortSignal) => Promise<ProviderResponse>;
export const providerTransport: ProviderTransport = async (plan, signal) => {
  const host = plan.url.hostname;
  const endpoint = await validatePublicEndpoint(plan.url.origin, [host], 'Connector');
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, options, callback) =>
        options.all
          ? callback(null, [endpoint.address])
          : callback(null, endpoint.address.address, endpoint.address.family),
    },
  });
  try {
    const response = await request(plan.url, {
      method: plan.method,
      headers: plan.headers,
      ...(plan.body ? { body: plan.body } : {}),
      dispatcher,
      signal,
      headersTimeout: 10000,
      bodyTimeout: 10000,
    });
    const retry = Number(response.headers['retry-after']);
    const retryAfter = Number.isFinite(retry) ? Math.min(3600, Math.max(1, retry)) : 60;
    const etag = typeof response.headers.etag === 'string' ? response.headers.etag : undefined;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.body.destroy();
      return { status: response.statusCode, body: '', retryAfter };
    }
    const pieces: Buffer[] = [];
    let bytes = 0;
    for await (const piece of response.body) {
      const data = Buffer.from(piece);
      bytes += data.length;
      if (bytes > 1024 * 1024) {
        response.body.destroy();
        throw new ProviderFailure('PROVIDER_RESPONSE_LIMIT');
      }
      pieces.push(data);
    }
    return {
      status: response.statusCode,
      body: Buffer.concat(pieces).toString('utf8'),
      retryAfter,
      ...(etag ? { etag } : {}),
    };
  } catch (error) {
    if (error instanceof AppError || error instanceof ProviderFailure) throw error;
    throw new ProviderFailure('PROVIDER_UNAVAILABLE');
  } finally {
    await dispatcher.close();
  }
};
export function connectorProvider(databaseHosts: string[] = []): ConnectorProvider {
  return {
    async read(input) {
      if (input.provider === 'notion') return readNotion(input, providerTransport);
      const plan = providerPlan(input, databaseHosts);
      await input.guard?.();
      const response = await providerTransport(plan, input.signal);
      if (response.status !== 200)
        throw new ProviderFailure(
          response.status === 429
            ? 'PROVIDER_RATE_LIMITED'
            : response.status === 401 || response.status === 403
              ? 'PROVIDER_AUTH_REQUIRED'
              : response.status === 404
                ? 'PROVIDER_RESOURCE_NOT_FOUND'
                : 'PROVIDER_READ_FAILED',
          response.retryAfter,
        );
      try {
        return plan.plain
          ? { title: input.resource, body: response.body }
          : normalizeDocument(input.provider, input.resource, JSON.parse(response.body));
      } catch (error) {
        if (error instanceof AppError || error instanceof ProviderFailure) throw error;
        throw new ProviderFailure('PROVIDER_RESPONSE_INVALID');
      }
    },
  };
}
