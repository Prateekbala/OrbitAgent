import { describe, expect, it } from 'vitest';
import {
  nativeOperations,
  nativeWritePlans,
  nativeWriteProvider,
  parseNativeMutation,
  type NativeWriteInput,
} from '../src/connections/mutations.js';
import type { ConnectorId } from '@ao/contracts/connections';
import type { Plan } from '../src/connections/provider.js';
const cases: [ConnectorId, string, string, string, string][] = [
  ['github', 'acme/project/12', 'title', 'api.github.com', 'PATCH'],
  ['gitlab', '1/12', 'title', 'gitlab.com', 'PUT'],
  ['linear', 'c9bdd67c-e3f6-4994-84bc-c79c538457da', 'title', 'api.linear.app', 'POST'],
  ['jira', 'cloud/ORB-12', 'summary', 'api.atlassian.com', 'PUT'],
  ['google_drive', 'document-12', 'description', 'www.googleapis.com', 'PATCH'],
  ['microsoft365', 'drive/item', 'name', 'graph.microsoft.com', 'PATCH'],
  ['hubspot', '123', 'firstname', 'api.hubapi.com', 'PATCH'],
  ['stripe', 'cus_example', 'description', 'api.stripe.com', 'POST'],
];
function input(provider: ConnectorId, resource: string, field: string): NativeWriteInput {
  const operation = nativeOperations(provider)[0]!.id;
  const mutation = parseNativeMutation(
    provider,
    operation,
    JSON.stringify({ resource, patch: { [field]: 'After' }, expected: { [field]: 'Before' } }),
  );
  return {
    provider,
    resource,
    operation,
    mutation,
    credential: { accessToken: 'private-native-secret' },
    config: {},
    signal: AbortSignal.timeout(10000),
    key: 'fixed-action-key',
    reconcile: false,
    guard: async () => {},
  };
}
describe('native mutation provider contracts', () => {
  it.each(cases)(
    'plans the bounded %s update and verifies the resulting fields',
    async (provider, resource, field, host, method) => {
      const i = input(provider, resource, field),
        plans = nativeWritePlans(i, i.mutation, i.key),
        calls: Plan[] = [];
      expect(plans.write.url.hostname).toBe(host);
      expect(plans.write.method).toBe(method);
      expect(plans.write.url.username).toBe('');
      expect(plans.write.headers.authorization).toBe('Bearer private-native-secret');
      const response = (after: boolean) =>
        provider === 'linear'
          ? { data: { issue: { [field]: after ? 'After' : 'Before' } } }
          : provider === 'jira'
            ? { fields: { [field]: after ? 'After' : 'Before' } }
            : provider === 'hubspot'
              ? { properties: { [field]: after ? 'After' : 'Before' } }
              : { [field]: after ? 'After' : 'Before' };
      const invoke = nativeWriteProvider(async (plan) => {
        calls.push(plan);
        const writing = calls.length === 2;
        return {
          status: 200,
          body: JSON.stringify(
            writing && provider === 'linear'
              ? { data: { issueUpdate: { success: true } } }
              : response(calls.length >= 3),
          ),
          retryAfter: 2,
          etag: '"provider-version"',
        };
      });
      const result = await invoke(i);
      expect(result.status).toBe('succeeded');
      expect(calls).toHaveLength(3);
      if (provider === 'stripe') expect(calls[1]!.headers['idempotency-key']).toBe(i.key);
      if (['google_drive', 'microsoft365'].includes(provider))
        expect(calls[1]!.headers['if-match']).toBe('"provider-version"');
      expect(JSON.stringify(result)).not.toContain('private-native-secret');
    },
  );
  it('requires previous values, rejects unsupported fields and prevents resource path injection', () => {
    for (const payload of [
      { resource: 'acme/project/1', patch: { title: 'After' }, expected: {} },
      {
        resource: 'acme/project/1',
        patch: { assignees: 'admin' },
        expected: { assignees: 'user' },
      },
      { resource: 'acme/../1', patch: { title: 'After' }, expected: { title: 'Before' } },
      { resource: 'https://localhost/', patch: { title: 'After' }, expected: { title: 'Before' } },
    ])
      expect(() =>
        parseNativeMutation('github', 'issue.update', JSON.stringify(payload)),
      ).toThrow();
  });
  it('checks uncertain outcomes by reads only and never retries a timed-out mutation', async () => {
    const i = input('github', 'acme/project/1', 'title');
    let writes = 0,
      applied = false;
    const invoke = nativeWriteProvider(async (plan) => {
      if (plan.method === 'PATCH') {
        writes++;
        applied = true;
        throw new Error('provider timeout after commit private-native-secret');
      }
      return {
        status: 200,
        body: JSON.stringify({ title: applied ? 'After' : 'Before' }),
        retryAfter: 2,
      };
    });
    expect((await invoke(i)).status).toBe('unknown');
    expect((await invoke({ ...i, reconcile: true })).status).toBe('succeeded');
    expect(writes).toBe(1);
    applied = false;
    expect((await invoke({ ...i, reconcile: true })).status).toBe('unknown');
    expect(writes).toBe(1);
  });
  it('rechecks authority before dispatch and does not overwrite changed provider fields', async () => {
    const i = input('github', 'acme/project/1', 'title');
    let calls = 0;
    const invoke = nativeWriteProvider(async () => {
      calls++;
      return {
        status: 200,
        body: JSON.stringify({ title: 'Changed by someone else' }),
        retryAfter: 2,
      };
    });
    expect((await invoke(i)).status).toBe('not_applied');
    expect(calls).toBe(1);
    calls = 0;
    let checks = 0;
    const revoked = nativeWriteProvider(async () => {
      calls++;
      return { status: 200, body: JSON.stringify({ title: 'Before' }), retryAfter: 2 };
    });
    expect(
      (
        await revoked({
          ...i,
          guard: async () => {
            if (++checks === 2) throw new Error('revoked');
          },
        })
      ).status,
    ).toBe('not_applied');
    expect(calls).toBe(1);
  });
});
