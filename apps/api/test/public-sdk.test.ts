import { publicScopes } from '@ao/contracts/developer';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OrbitClient, OrbitError } from '../../../packages/sdk/src/index.js';
import { publicOperations, operationInput, openApi } from '../src/developer/operations.js';
describe('public SDK compatibility', () => {
  it('generates one operation contract for REST, MCP and the TypeScript client', () => {
    const spec = openApi();
    for (const scope of publicScopes)
      expect(publicOperations.some((o) => o.scope === scope)).toBe(true);
    expect(new Set(publicOperations.map((o) => o.id)).size).toBe(publicOperations.length);
    for (const o of publicOperations)
      expect(spec.paths[o.path]![o.method.toLowerCase()]).toHaveProperty('operationId', o.id);
    expect(
      operationInput(publicOperations.find((o) => o.id === 'getTask')!).safeParse({}).success,
    ).toBe(false);
  });
  it('encodes path/query values, preserves idempotency input and never retries errors', async () => {
    let calls = 0;
    const id = randomUUID(),
      clientId = randomUUID();
    const client = new OrbitClient(
      'https://workspace.example/api/public/v1',
      () => 'test-private-credential',
      async (input, init) => {
        calls++;
        expect(String(input)).toBe('https://workspace.example/api/public/v1/tasks');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer test-private-credential',
        );
        expect(JSON.parse(String(init?.body)).clientId).toBe(clientId);
        expect(init?.redirect).toBe('error');
        return new Response(JSON.stringify({ id, replayed: false }), { status: 201 });
      },
    );
    expect(
      await client.request('createTask', {
        body: { clientId, title: 'SDK contract', conversationId: randomUUID() },
      }),
    ).toEqual({ id, replayed: false });
    expect(calls).toBe(1);
    const denied = new OrbitClient(
      'https://workspace.example/api/public/v1',
      () => 'test-private-credential',
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            error: { code: 'INSUFFICIENT_SCOPE', message: 'Missing scope', requestId: 'request-1' },
          }),
          { status: 403 },
        );
      },
    );
    const error = await denied.request('getTask', { path: { id } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrbitError);
    expect((error as OrbitError).code).toBe('INSUFFICIENT_SCOPE');
    expect(String(error)).not.toContain('test-private-credential');
    expect(calls).toBe(2);
  });
});
