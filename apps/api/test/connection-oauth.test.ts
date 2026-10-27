import { afterEach, describe, it, expect } from 'vitest';
import { messagingFixture } from './messaging-fixture.js';
import type { Credential } from '../src/connections/provider.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
function provider(
  exchange: (code: string, verifier: string) => Promise<Credential>,
  refresh?: () => Promise<Credential>,
) {
  return {
    authorization: (state: string, challenge: string) =>
      'https://oauth.example.test/consent?' + new URLSearchParams({ state, challenge }),
    exchange,
    refresh: refresh ?? (async () => ({ accessToken: 'refreshed' })),
  };
}
async function start() {
  const r = await f.call(f.owner, 'POST', '/v1/connections/oauth/start', {
    provider: 'google_drive',
    name: 'Owned Google Drive',
    audience: 'personal',
  });
  expect(r.statusCode, r.body).toBe(200);
  return new URL(r.json().url).searchParams.get('state')!;
}
const callback = (state: string) =>
  '/v1/connections/oauth/google_drive/callback?' +
  new URLSearchParams({ state, code: 'one-time-provider-code' });
describe('connector OAuth consent and credential refresh', () => {
  it('consumes a denied consent without exchanging a code or persisting credentials', async () => {
    let exchanges = 0;
    f = await messagingFixture(undefined, undefined, {
      connectorOAuth: {
        google_drive: provider(async () => {
          exchanges++;
          return { accessToken: 'unused' };
        }),
      },
    });
    const state = await start();
    const denied = await f.call(
      f.owner,
      'GET',
      '/v1/connections/oauth/google_drive/callback?' +
        new URLSearchParams({
          state,
          error: 'access_denied',
          error_description: 'provider-private-diagnostic',
        }),
    );
    expect(denied.statusCode).toBe(302);
    expect(denied.headers.location).toBe('http://localhost:3000/app?connection=denied');
    expect(denied.body).not.toContain('provider-private');
    expect((await f.call(f.owner, 'GET', callback(state))).statusCode).toBe(400);
    expect(exchanges).toBe(0);
  });
  it('reconnects the same record with explicitly chosen write access and clears old audiences and grants', async () => {
    f = await messagingFixture(undefined, undefined, {
      connectorOAuth: {
        google_drive: provider(async () => ({ accessToken: 'new-account-secret' })),
      },
    });
    const created = await f.call(f.owner, 'POST', '/v1/connections', {
      provider: 'google_drive',
      name: 'Reconnect Drive',
      audience: 'workspace',
      credential: 'old-account-secret',
    });
    const id = created.json().id;
    await f.call(f.owner, 'PUT', `/v1/connections/${id}/grants`, {
      memberId: f.mateBoot.me.id,
      resources: ['file-1'],
      operations: ['document.read'],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const consent = await f.call(f.owner, 'POST', '/v1/connections/oauth/start', {
      provider: 'google_drive',
      name: 'ignored',
      audience: 'personal',
      connectionId: id,
      access: 'write',
    });
    const state = new URL(consent.json().url).searchParams.get('state')!;
    const result = await f.call(f.owner, 'GET', callback(state));
    expect(result.statusCode, result.body).toBe(302);
    const list = (await f.call(f.owner, 'GET', '/v1/connections')).json().items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, write_enabled: true, version: 2, audience: 'workspace' });
    const grants = (await f.call(f.owner, 'GET', `/v1/connections/${id}/grants`)).json();
    expect(grants[0].revoked_at).toBeTruthy();
  });
  it('fences OAuth reconnect persistence after a concurrent credential rotation', async () => {
    let id = '';
    f = await messagingFixture(undefined, undefined, {
      connectorOAuth: {
        google_drive: provider(async () => {
          const rotated = await f.call(f.owner, 'POST', `/v1/connections/${id}/rotate`, {
            version: 1,
            credential: 'concurrently-rotated-secret',
          });
          expect(rotated.statusCode, rotated.body).toBe(200);
          return { accessToken: 'must-not-replace-rotation' };
        }),
      },
    });
    id = (
      await f.call(f.owner, 'POST', '/v1/connections', {
        provider: 'google_drive',
        name: 'Versioned Drive',
        audience: 'personal',
        credential: 'old',
      })
    ).json().id;
    const consent = await f.call(f.owner, 'POST', '/v1/connections/oauth/start', {
      provider: 'google_drive',
      name: 'Drive',
      audience: 'personal',
      connectionId: id,
    });
    const state = new URL(consent.json().url).searchParams.get('state')!;
    expect((await f.call(f.owner, 'GET', callback(state))).statusCode).toBe(409);
    expect((await f.call(f.owner, 'GET', '/v1/connections')).json().items[0].version).toBe(2);
  });
  it('binds PKCE consent to the authenticated workspace session and consumes authorization codes once', async () => {
    let exchanges = 0;
    f = await messagingFixture(undefined, undefined, {
      connectorOAuth: {
        google_drive: provider(async (code, verifier) => {
          exchanges++;
          expect(code).toBe('one-time-provider-code');
          expect(verifier.length).toBeGreaterThan(40);
          return {
            accessToken: 'private-oauth-token',
            refreshToken: 'private-refresh-token',
            expiresAt: Date.now() + 3600000,
          };
        }),
      },
    });
    const state = await start();
    expect((await f.call(f.mate, 'GET', callback(state))).statusCode).toBe(400);
    const connected = await f.call(f.owner, 'GET', callback(state));
    expect(connected.statusCode, connected.body).toBe(302);
    expect(connected.headers.location).toBe('http://localhost:3000/app?connection=connected');
    expect(exchanges).toBe(1);
    expect((await f.call(f.owner, 'GET', callback(state))).statusCode).toBe(400);
    const listing = await f.call(f.owner, 'GET', '/v1/connections');
    expect(listing.json().items).toHaveLength(1);
    expect(listing.body).not.toContain('private-');
  });
  it('refreshes expiring tokens with a fenced generation and never returns provider credentials', async () => {
    let refreshes = 0;
    f = await messagingFixture(undefined, undefined, {
      connectorOAuth: {
        google_drive: provider(
          async () => ({
            accessToken: 'expired',
            expiresAt: Date.now() - 1000,
            refreshToken: 'refresh-private',
          }),
          async () => {
            refreshes++;
            return {
              accessToken: 'refreshed-private',
              expiresAt: Date.now() + 3600000,
              refreshToken: 'rotated-private',
            };
          },
        ),
      },
      connectors: {
        async read(input) {
          expect(input.credential.accessToken).toBe('refreshed-private');
          return { title: 'OAuth document', body: 'Provider-approved document content' };
        },
      },
    });
    const state = await start();
    await f.call(f.owner, 'GET', callback(state));
    const id = (await f.call(f.owner, 'GET', '/v1/connections')).json().items[0].id;
    const result = await f.call(f.owner, 'POST', `/v1/connections/${id}/import`, {
      operation: 'document.read',
      resource: 'doc-123',
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(refreshes).toBe(1);
    expect(result.body).not.toContain('private');
    const [secret] = await f.db.query(
      'SELECT generation FROM connection_secrets WHERE connection_id=$1',
      [id],
    );
    expect(secret!.generation).toBe(2);
  });
  it('rejects a policy change during provider token exchange before persisting a connection', async () => {
    f = await messagingFixture(undefined, undefined, {
      connectorOAuth: {
        google_drive: provider(async () => {
          await f.db.query(
            'UPDATE organizations SET version=version+1 WHERE id=(SELECT organization_id FROM workspaces WHERE id=$1)',
            [f.ownerBoot.workspace.id],
          );
          return { accessToken: 'must-not-be-saved' };
        }),
      },
    });
    const state = await start();
    const result = await f.call(f.owner, 'GET', callback(state));
    expect(result.statusCode, result.body).toBe(409);
    expect(
      await f.db.query('SELECT id FROM connections WHERE workspace_id=$1', [
        f.ownerBoot.workspace.id,
      ]),
    ).toHaveLength(0);
  });
});
