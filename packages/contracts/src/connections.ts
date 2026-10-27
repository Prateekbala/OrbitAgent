import { z } from 'zod';
export const connectorId = z.enum([
  'github',
  'gitlab',
  'linear',
  'jira',
  'sentry',
  'honeycomb',
  'vercel',
  'datadog',
  'notion',
  'google_drive',
  'microsoft365',
  'granola',
  'fathom',
  'fireflies',
  'hubspot',
  'attio',
  'stripe',
  'ramp',
  'shopify',
  'zendesk',
  'posthog',
  'hex',
  'supabase',
  'database',
]);
export type ConnectorId = z.infer<typeof connectorId>;
export const connectionInput = z
  .object({
    provider: connectorId,
    name: z.string().trim().min(1).max(120),
    audience: z.enum(['personal', 'workspace']),
    credential: z.string().min(1).max(20000),
    allowWrites: z.boolean().default(false),
    config: z.record(z.string().max(50), z.string().max(500)).default({}),
    subscriptions: z.array(z.string().min(1).max(100)).max(30).default([]),
  })
  .strict();
export const connectionGrant = z
  .object({
    memberId: z.uuid(),
    resources: z.array(z.string().min(1).max(500)).min(1).max(100),
    operations: z.array(z.string().min(1).max(100)).min(1).max(100),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const connectionImport = z
  .object({
    operation: z.string().min(1).max(100),
    resource: z.string().min(1).max(500),
    conversationId: z.uuid().optional(),
    retentionDays: z.number().int().min(1).max(365).default(30),
  })
  .strict();
export interface ConnectorOperation {
  id: string;
  label: string;
  effect: 'read' | 'write';
  scopes: string[];
  resourceFormat: string;
  fields?: string[];
  idempotency?: 'provider-key' | 'postcondition';
}
export interface ConnectorManifest {
  id: ConnectorId;
  name: string;
  category: 'engineering' | 'knowledge' | 'business' | 'data';
  documentation: string;
  operations: ConnectorOperation[];
  auth: 'bearer' | 'api_key' | 'custom';
  configuration: { key: string; label: string; required: boolean }[];
  credentialFormat: 'token' | 'json';
  rateLimit: { requestsPerMinute: number; respectRetryAfter: true };
  writes: 'approval-adapter-required' | 'native-approved';
  idempotency: 'read-only' | 'per-operation';
  reconciliation: 'resource-refetch' | 'postcondition-read';
  attribution: 'provider-resource';
  qualification: 'unvalidated';
  limitations: string[];
  nativeEvents?: string[];
}
