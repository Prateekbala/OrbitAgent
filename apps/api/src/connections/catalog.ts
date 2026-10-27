import type { ConnectorId, ConnectorManifest } from '@ao/contracts/connections';
import { nativeOperations } from './mutations.js';
import { nativeEventProviders } from './native-events.js';
type Entry = [ConnectorId, string, ConnectorManifest['category'], string, string?, string?];
const entries: Entry[] = [
  [
    'github',
    'GitHub',
    'engineering',
    'https://docs.github.com/en/rest/issues/issues',
    'issue.read',
    'owner/repository/issue-number',
  ],
  [
    'gitlab',
    'GitLab',
    'engineering',
    'https://docs.gitlab.com/api/issues/',
    'issue.read',
    'project-id/issue-iid',
  ],
  [
    'linear',
    'Linear',
    'engineering',
    'https://linear.app/developers/graphql',
    'issue.read',
    'issue UUID',
  ],
  [
    'jira',
    'Jira',
    'engineering',
    'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
    'issue.read',
    'cloud-id/issue-key',
  ],
  ['sentry', 'Sentry', 'engineering', 'https://docs.sentry.io/api/', 'issue.read', 'issue ID'],
  [
    'honeycomb',
    'Honeycomb',
    'engineering',
    'https://docs.honeycomb.io/api/',
    'board.read',
    'board ID',
  ],
  [
    'vercel',
    'Vercel',
    'engineering',
    'https://vercel.com/docs/rest-api',
    'deployment.read',
    'deployment ID',
  ],
  [
    'datadog',
    'Datadog',
    'engineering',
    'https://docs.datadoghq.com/api/latest/',
    'monitor.read',
    'monitor ID',
  ],
  [
    'notion',
    'Notion',
    'knowledge',
    'https://developers.notion.com/reference/get-block',
    'blocks.read',
    'page UUID',
  ],
  [
    'google_drive',
    'Google Drive',
    'knowledge',
    'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export',
    'document.read',
    'Google document file ID',
  ],
  [
    'microsoft365',
    'Microsoft 365',
    'knowledge',
    'https://learn.microsoft.com/en-us/graph/api/driveitem-get',
    'item.read',
    'drive-ID/item-ID',
  ],
  ['granola', 'Granola', 'knowledge', 'https://docs.granola.ai/', 'note.read', 'note ID'],
  [
    'fathom',
    'Fathom',
    'knowledge',
    'https://developers.fathom.ai/',
    'transcript.read',
    'recording ID',
  ],
  [
    'fireflies',
    'Fireflies',
    'knowledge',
    'https://docs.fireflies.ai/graphql-api/query/transcript',
    'transcript.read',
    'transcript ID',
  ],
  [
    'hubspot',
    'HubSpot',
    'business',
    'https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide',
    'contact.read',
    'contact ID',
  ],
  [
    'attio',
    'Attio',
    'business',
    'https://docs.attio.com/rest-api/endpoint-reference/records/get-a-record',
    'record.read',
    'object/record UUID',
  ],
  [
    'stripe',
    'Stripe',
    'business',
    'https://docs.stripe.com/api/customers/retrieve',
    'customer.read',
    'customer ID',
  ],
  ['ramp', 'Ramp', 'business', 'https://docs.ramp.com/', 'transaction.read', 'transaction ID'],
  [
    'shopify',
    'Shopify',
    'business',
    'https://shopify.dev/docs/api/admin-graphql',
    'product.read',
    'numeric product ID',
  ],
  [
    'zendesk',
    'Zendesk',
    'business',
    'https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/',
    'ticket.read',
    'ticket ID',
  ],
  [
    'posthog',
    'PostHog',
    'data',
    'https://posthog.com/docs/api',
    'insight.read',
    'project ID/insight ID',
  ],
  [
    'hex',
    'Hex',
    'data',
    'https://learn.hex.tech/docs/api/api-overview',
    'project.read',
    'project UUID',
  ],
  ['supabase', 'Supabase', 'data', 'https://supabase.com/docs/guides/api', 'row.read', 'row UUID'],
  [
    'database',
    'Approved database',
    'data',
    'https://www.postgresql.org/docs/current/ddl-rowsecurity.html',
    'record.read',
    'record ID',
  ],
];
const scopes: Partial<Record<ConnectorId, string[]>> = {
  github: ['Fine-grained Issues read permission'],
  gitlab: ['read_api'],
  linear: ['read'],
  jira: ['read:jira-work'],
  sentry: ['event:read'],
  vercel: ['Deployment read access'],
  notion: ['Read content capability'],
  google_drive: ['https://www.googleapis.com/auth/drive.readonly'],
  fireflies: ['API-key transcript access'],
  hubspot: ['crm.objects.contacts.read'],
  attio: ['record_permission:read'],
  stripe: ['Restricted key: Customers read'],
  posthog: ['insight:read'],
  honeycomb: ['Configuration-key board read access'],
  datadog: ['monitors_read'],
  microsoft365: ['Files.Read'],
  granola: ['Personal notes or workspace API note access'],
  fathom: ['API-key transcript access'],
  ramp: ['Transaction read access'],
  shopify: ['read_products'],
  zendesk: ['Read access to the selected ticket'],
  hex: ['Project read access'],
  supabase: ['Delegated authenticated user and approved-table SELECT RLS'],
  database: ['Named query with a constrained read-only database identity'],
};
const configuration: Partial<
  Record<ConnectorId, { key: string; label: string; required: boolean }[]>
> = {
  shopify: [{ key: 'shop', label: 'Store subdomain', required: true }],
  zendesk: [{ key: 'subdomain', label: 'Zendesk subdomain', required: true }],
  supabase: [
    { key: 'projectRef', label: 'Project reference', required: true },
    { key: 'table', label: 'Approved table', required: true },
    { key: 'columns', label: 'Approved columns, comma separated', required: true },
  ],
  database: [
    { key: 'endpoint', label: 'Approved read proxy HTTPS endpoint', required: true },
    { key: 'query', label: 'Approved parameterized query name', required: true },
  ],
};
export const connectorCatalog: ConnectorManifest[] = entries.map(
  ([id, name, category, documentation, operation, format]) => ({
    id,
    name,
    category,
    documentation,
    operations: [
      ...(operation
        ? [
            {
              id: operation,
              label: operation.replace('.', ' '),
              effect: 'read' as const,
              scopes: scopes[id] ?? [],
              resourceFormat: format!,
            },
          ]
        : []),
      ...nativeOperations(id),
    ],
    auth: ['datadog', 'supabase'].includes(id)
      ? 'custom'
      : ['honeycomb', 'fathom', 'shopify'].includes(id)
        ? 'api_key'
        : 'bearer',
    rateLimit: { requestsPerMinute: 30, respectRetryAfter: true },
    writes: nativeOperations(id).length ? 'native-approved' : 'approval-adapter-required',
    idempotency: nativeOperations(id).length ? 'per-operation' : 'read-only',
    reconciliation: nativeOperations(id).length ? 'postcondition-read' : 'resource-refetch',
    attribution: 'provider-resource',
    qualification: 'unvalidated',
    nativeEvents: nativeEventProviders.some((provider) => provider === id)
      ? ['resource.changed', 'resource.deleted']
      : [],
    configuration: configuration[id] ?? [],
    credentialFormat: ['datadog', 'supabase'].includes(id) ? 'json' : 'token',
    limitations: operation
      ? [
          'Single explicitly selected resource per import.',
          'Provider test-account validation is required before production use.',
          'Live provider qualification and native event subscriptions remain provider-specific.',
          ...(nativeOperations(id).length
            ? [
                'Native field updates require explicit write consent, exact resource grants, reviewed previous values and the hosted action approval ledger. Unknown outcomes are reconciled by read-only postcondition checks, never automatic write replay. Providers without conditional updates cannot guarantee an atomic compare-and-set.',
              ]
            : []),
          ...(id === 'notion'
            ? [
                'Complete block-tree traversal within 20 requests, 1,000 blocks, eight levels and 1 MB; larger trees fail closed. Native paragraph replacement accepts only plain, unformatted paragraph blocks. Database row exports require a separate operation.',
              ]
            : []),
          ...(id === 'posthog'
            ? [
                'US Cloud private API endpoint; EU and self-hosted variants require separate qualification.',
              ]
            : []),
          ...(id === 'microsoft365'
            ? [
                'This operation imports file metadata; binary bodies require a separately qualified export adapter.',
              ]
            : []),
          ...(id === 'database'
            ? [
                'Named read proxy protocol only; direct SQL and database credentials are not accepted.',
              ]
            : []),
          ...(id === 'supabase'
            ? [
                'Requires a publishable API key and a delegated authenticated user JWT. Service-role and secret keys are rejected.',
              ]
            : []),
        ]
      : [
          'Catalog entry only; native adapter is not implemented. Use a separately qualified approval adapter.',
        ],
  }),
);
export function manifest(provider: ConnectorId) {
  return connectorCatalog.find((m) => m.id === provider)!;
}

export function validateConnectionConfiguration(
  provider: ConnectorId,
  config: Record<string, string>,
) {
  const identifier = (value: string | undefined) =>
    Boolean(value && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value));
  if (provider === 'shopify' || provider === 'zendesk') {
    const value = config[provider === 'shopify' ? 'shop' : 'subdomain'];
    if (!value || !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(value)) return false;
  }
  if (provider === 'supabase') {
    const columns = (config.columns ?? '').split(',').map((v) => v.trim());
    if (
      !/^[a-z0-9]{20}$/.test(config.projectRef ?? '') ||
      !identifier(config.table) ||
      !columns.length ||
      columns.length > 20 ||
      columns.some(
        (c) => !identifier(c) || /password|secret|token|credential|api_key|authorization/i.test(c),
      )
    )
      return false;
  }
  if (provider === 'database') {
    try {
      const endpoint = new URL(config.endpoint ?? '');
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        (endpoint.port && endpoint.port !== '443') ||
        !/^\/[A-Za-z0-9/_-]*$/.test(endpoint.pathname) ||
        !identifier(config.query)
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}
