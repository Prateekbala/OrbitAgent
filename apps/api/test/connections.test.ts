import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorManifest } from '@ao/contracts/connections';
import type { ConnectorRequest } from '../src/connections/provider.js';
import { providerPlan, normalizeDocument, ProviderFailure } from '../src/connections/provider.js';
import { connectorCatalog } from '../src/connections/catalog.js';
import { messagingFixture } from './messaging-fixture.js';
import { RetrievalWorker } from '../src/retrieval/worker.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
let duringRead: ((input: ConnectorRequest) => Promise<void>) | undefined;
let failure: ProviderFailure | undefined;
beforeAll(async () => {
  f = await messagingFixture(undefined, undefined, {
    connectors: {
      async read(input) {
        await duringRead?.(input);
        if (failure) throw failure;
        return {
          title: 'Connected deployment',
          body: 'ConnectedResourceEvidence is approved',
          sourceUrl: 'https://github.com/acme/orbit/issues/7',
        };
      },
    },
  });
});
afterAll(async () => {
  await f?.close();
});
const future = () => new Date(Date.now() + 86400000).toISOString();
async function connection(audience = 'workspace') {
  const r = await f.call(f.owner, 'POST', '/v1/connections', {
    provider: 'github',
    name: 'Engineering GitHub',
    audience,
    credential: 'fixture-secret-never-expose',
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
}
describe('owned provider connections', () => {
  it('lists explicitly bounded operations and keeps provider qualification separate from configuration', async () => {
    const response = await f.call(f.owner, 'GET', '/v1/connections/catalog');
    expect(response.statusCode).toBe(200);
    const catalog = response.json<{ items: ConnectorManifest[] }>().items;
    expect(catalog).toHaveLength(24);
    expect(catalog.every((v) => v.qualification === 'unvalidated')).toBe(true);
    const disabled = await f.call(f.owner, 'POST', '/v1/connections', {
      provider: 'github',
      name: 'No unqualified native events',
      audience: 'personal',
      credential: 'secret',
      subscriptions: ['native:issues'],
    });
    expect(disabled.statusCode).toBe(409);
  });
  it('encrypts credentials and keeps personal connections hidden from teammates and other tenants', async () => {
    const id = await connection('personal');
    const [secret] = await f.db.query(
      'SELECT encrypted_value FROM connection_secrets WHERE connection_id=$1',
      [id],
    );
    expect(secret!.encrypted_value).not.toContain('fixture-secret');
    const owner = await f.call(f.owner, 'GET', '/v1/connections');
    expect(owner.body).not.toContain('fixture-secret');
    expect(owner.body).not.toContain('encrypted_value');
    expect(
      (await f.call(f.mate, 'GET', '/v1/connections'))
        .json()
        .items.some((v: { id: string }) => v.id === id),
    ).toBe(false);
    expect((await f.call(f.other, 'GET', '/v1/connections')).json().items).toHaveLength(0);
    expect(
      (
        await f.call(f.mate, 'POST', `/v1/connections/${id}/import`, {
          operation: 'issue.read',
          resource: 'acme/orbit/7',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await f.call(f.owner, 'PUT', `/v1/connections/${id}/grants`, {
          memberId: f.mateBoot.me.id,
          operations: ['issue.read'],
          resources: ['acme/orbit/7'],
          expiresAt: future(),
        })
      ).statusCode,
    ).toBe(409);
  });
  it('imports selected resources with explicit grants, source citations and immediate revocation', async () => {
    const id = await connection();
    const imported = await f.call(f.owner, 'POST', `/v1/connections/${id}/import`, {
      operation: 'issue.read',
      resource: 'acme/orbit/7',
    });
    expect(imported.statusCode, imported.body).toBe(200);
    await new RetrievalWorker(f.db).tick();
    const search = () =>
      f.call(f.mate, 'POST', '/v1/search/retrieve', { q: 'ConnectedResourceEvidence' });
    expect((await search()).json().items).toHaveLength(0);
    const grant = await f.call(f.owner, 'PUT', `/v1/connections/${id}/grants`, {
      memberId: f.mateBoot.me.id,
      operations: ['issue.read'],
      resources: ['acme/orbit/7'],
      expiresAt: future(),
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const found = (await search()).json();
    expect(found.items.some((v: { id: string }) => v.id === imported.json().id)).toBe(true);
    await f.call(f.owner, 'DELETE', `/v1/connections/${id}/grants/${f.mateBoot.me.id}`);
    expect(
      (await search()).json().items.some((v: { id: string }) => v.id === imported.json().id),
    ).toBe(false);
    expect((await f.call(f.mate, 'GET', `/v1/search/contexts/${found.contextId}`)).statusCode).toBe(
      409,
    );
  });
  it('rechecks current ownership and connection generation after a provider response', async () => {
    const id = await connection();
    duringRead = async () => {
      await f.db.query("UPDATE connections SET state='revoked',version=version+1 WHERE id=$1", [
        id,
      ]);
    };
    try {
      const result = await f.call(f.owner, 'POST', `/v1/connections/${id}/import`, {
        operation: 'issue.read',
        resource: 'acme/orbit/8',
      });
      expect(result.statusCode).toBe(404);
      expect(
        await f.db.query('SELECT id FROM connection_resources WHERE connection_id=$1', [id]),
      ).toHaveLength(0);
    } finally {
      duringRead = undefined;
    }
  });
  it('rotates and revokes credentials with optimistic versions and bounds provider retries', async () => {
    const id = await connection();
    const rotated = await f.call(f.owner, 'POST', `/v1/connections/${id}/rotate`, {
      version: 1,
      credential: 'rotated-private-value',
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/connections/${id}/rotate`, {
          version: 1,
          credential: 'stale',
        })
      ).statusCode,
    ).toBe(409);
    failure = new ProviderFailure('PROVIDER_RATE_LIMITED', 120);
    try {
      expect(
        (
          await f.call(f.owner, 'POST', `/v1/connections/${id}/import`, {
            operation: 'issue.read',
            resource: 'acme/orbit/9',
          })
        ).statusCode,
      ).toBe(502);
    } finally {
      failure = undefined;
    }
    const [rate] = await f.db.query('SELECT next_request_at FROM connections WHERE id=$1', [id]);
    expect(new Date(String(rate!.next_request_at)).getTime()).toBeGreaterThan(Date.now() + 100000);
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/connections/${id}`, { version: 2 })).statusCode,
    ).toBe(200);
    expect(
      await f.db.query('SELECT encrypted_value FROM connection_secrets WHERE connection_id=$1', [
        id,
      ]),
    ).toHaveLength(0);
  });
  it('records per-operation test evidence without equating credentials to provider validation', async () => {
    const id = await connection();
    const before = await f.call(f.owner, 'GET', `/v1/connections/${id}/validation`);
    expect(before.json().items).toHaveLength(0);
    expect(before.json().credentialHealthIsCoverage).toBe(false);
    const record = await f.call(f.owner, 'POST', `/v1/connections/${id}/validation`, {
      operation: 'issue.read',
      environment: 'fixture',
      evidence: 'Local fixture import, revocation, and rate-limit verification.',
    });
    expect(record.statusCode, record.body).toBe(200);
    expect(record.json().attestedByOwner).toBe(true);
    expect(
      (await f.call(f.owner, 'GET', `/v1/connections/${id}/validation`)).json().items[0]
        .environment,
    ).toBe('fixture');
  });
  it('permanently revokes owned credentials and retained resources during member offboarding', async () => {
    const created = await f.call(f.mate, 'POST', '/v1/connections', {
      provider: 'github',
      name: 'Departing owner',
      audience: 'personal',
      credential: 'departing-secret',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const imported = await f.call(f.mate, 'POST', `/v1/connections/${id}/import`, {
      operation: 'issue.read',
      resource: 'acme/orbit/42',
    });
    expect(imported.statusCode, imported.body).toBe(200);
    await f.db.query("UPDATE memberships SET status='suspended' WHERE workspace_id=$1 AND id=$2", [
      f.ownerBoot.workspace.id,
      f.mateBoot.me.id,
    ]);
    expect(
      await f.db.query('SELECT encrypted_value FROM connection_secrets WHERE connection_id=$1', [
        id,
      ]),
    ).toHaveLength(0);
    expect((await f.db.query('SELECT state FROM connections WHERE id=$1', [id]))[0]!.state).toBe(
      'revoked',
    );
    expect(
      (await f.db.query('SELECT body FROM connection_resources WHERE connection_id=$1', [id]))[0]!
        .body,
    ).toBe('');
  });
});
describe('provider-specific request fixtures', () => {
  const resources: Record<string, string> = {
    github: 'acme/orbit/7',
    gitlab: '123/7',
    linear: 'issue-id',
    jira: 'cloud-id/ORB-7',
    sentry: '123',
    vercel: 'dpl_123',
    notion: 'page-id',
    google_drive: 'doc-id',
    fireflies: 'transcript-id',
    hubspot: '123',
    attio: 'people/record-id',
    stripe: 'cus_123',
    posthog: '1/7',
    honeycomb: 'board-123',
    datadog: '123',
    microsoft365: 'drive-id/item-id',
    granola: 'not_123',
    fathom: '123',
    ramp: 'transaction-id',
    shopify: '123',
    zendesk: '123',
    hex: 'project-id',
    supabase: '11111111-1111-4111-8111-111111111111',
    database: 'record-id',
  };
  for (const m of connectorCatalog.filter((m) => m.operations.length))
    it(`bounds ${m.id} to its fixed provider endpoint and explicit resource`, () => {
      const base = {
        provider: m.id,
        operation: m.operations[0]!.id,
        resource: resources[m.id]!,
        credential: {
          accessToken:
            m.id === 'datadog'
              ? JSON.stringify({ apiKey: 'test-api-key', applicationKey: 'test-app-key' })
              : m.id === 'supabase'
                ? JSON.stringify({
                    apiKey: 'sb_publishable_fixture',
                    accessToken:
                      'e30.' +
                      Buffer.from(JSON.stringify({ role: 'authenticated' })).toString('base64url') +
                      '.fixture',
                  })
                : 'private',
        },
        config:
          m.id === 'shopify'
            ? { shop: 'orbit-store' }
            : m.id === 'zendesk'
              ? { subdomain: 'orbit-support' }
              : m.id === 'supabase'
                ? { projectRef: 'a'.repeat(20), table: 'approved_records', columns: 'id,title' }
                : m.id === 'database'
                  ? { endpoint: 'https://read-proxy.example.test/v1', query: 'approved_record' }
                  : {},
        signal: AbortSignal.timeout(1000),
      };
      const plan = providerPlan(base, ['read-proxy.example.test']);
      expect(plan.url.protocol).toBe('https:');
      if (!['datadog', 'supabase', 'shopify', 'fathom', 'honeycomb'].includes(m.id))
        expect(plan.headers.authorization).toBe('Bearer private');
      expect(() => providerPlan({ ...base, resource: 'https://127.0.0.1/secret' })).toThrow();
      expect(
        normalizeDocument(m.id, base.resource, {
          title: 'Test',
          body: 'Public body',
          access_token: 'secret',
        }).body,
      ).not.toContain('secret');
    });
});
