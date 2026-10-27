import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FixedConnectorOAuth,
  oauthProfiles,
  type OAuthProviderId,
} from '../src/connections/oauth.js';
afterEach(() => vi.unstubAllGlobals());
describe('fixed provider OAuth profiles', () => {
  it.each(Object.keys(oauthProfiles) as OAuthProviderId[])(
    'exchanges and refreshes %s without exposing provider bodies',
    async (provider) => {
      const profile = oauthProfiles[provider],
        client = new FixedConnectorOAuth(
          provider,
          'registered-client',
          'private-client-secret',
          'https://orbit.example/api/callback',
        );
      const url = new URL(client.authorization('session-bound-state', 'pkce-challenge', 'write'));
      expect(url.origin).toBe(new URL(profile.authorize).origin);
      expect(url.searchParams.get('state')).toBe('session-bound-state');
      expect(url.searchParams.get('code_challenge')).toBe(profile.pkce ? 'pkce-challenge' : null);
      expect(url.href).not.toContain('private-client-secret');
      let requests = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (endpoint: string, init: RequestInit) => {
          expect(endpoint).toBe(profile.token);
          expect(init.redirect).toBe('error');
          requests++;
          const headers = new Headers(init.headers);
          const fields =
            profile.encoding === 'form'
              ? Object.fromEntries(new URLSearchParams(String(init.body)))
              : JSON.parse(String(init.body));
          if (profile.encoding === 'basic-json')
            expect(headers.get('authorization')).toBe(
              'Basic ' + Buffer.from('registered-client:private-client-secret').toString('base64'),
            );
          else expect(fields.client_secret).toBe('private-client-secret');
          if (requests === 1)
            expect(fields.code_verifier).toBe(profile.pkce ? 'session-verifier' : undefined);
          else expect(fields.refresh_token).toBe('private-refresh-token');
          return new Response(
            JSON.stringify({
              access_token: 'private-access-token',
              refresh_token: 'private-refresh-token',
              expires_in: 3600,
              token_type: 'bearer',
              ...(profile.write.length ? { scope: profile.write.join(' ') } : {}),
            }),
          );
        }),
      );
      const token = await client.exchange('authorization-code', 'session-verifier', 'write');
      expect(token.writeAllowed).toBe(true);
      const refreshed = await client.refresh(token);
      expect(refreshed.refreshToken).toBe('private-refresh-token');
      expect(requests).toBe(2);
    },
  );
  it('handles documented non-expiring tokens and rejects scope downgrades or response secrets in errors', async () => {
    const client = new FixedConnectorOAuth(
      'github',
      'id',
      'secret',
      'https://orbit.example/callback',
    );
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ access_token: 'token', token_type: 'bearer', scope: 'repo' }),
        ),
    );
    expect((await client.exchange('code', 'verifier')).expiresAt).toBeUndefined();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ access_token: 'must-stay-private', scope: 'read:user' })),
    );
    await expect(client.exchange('code', 'verifier', 'write')).rejects.toMatchObject({
      code: 'CONNECTOR_OAUTH_FAILED',
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('must-stay-private');
    });
    await expect(client.exchange('code', 'verifier')).rejects.toThrow(
      'The provider could not authorize',
    );
  });
});
