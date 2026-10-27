import { afterEach, describe, expect, it } from 'vitest';
import { messagingFixture } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
describe('public browser application boundary', () => {
  it('allows explicitly configured bearer origins without enabling cross-origin session credentials', async () => {
    f = await messagingFixture(undefined, undefined, {
      publicApiOrigins: ['https://client.example'],
    });
    const preflight = await f.app.inject({
      method: 'OPTIONS',
      url: '/public/v1/tasks',
      headers: {
        origin: 'https://client.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(preflight.statusCode, preflight.body).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://client.example');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    const cookie = await f.app.inject({
      url: '/public/v1/tasks',
      headers: { origin: 'https://client.example', cookie: 'ao_session=' + f.owner },
    });
    expect(cookie.statusCode).toBe(401);
    const internal = await f.app.inject({
      method: 'POST',
      url: '/v1/developer/keys',
      headers: { origin: 'https://client.example', cookie: 'ao_session=' + f.owner },
      payload: {},
    });
    expect(internal.statusCode).toBe(403);
    const denied = await f.app.inject({
      method: 'OPTIONS',
      url: '/public/v1/tasks',
      headers: { origin: 'https://unregistered.example', 'access-control-request-method': 'GET' },
    });
    expect(denied.statusCode).toBe(403);
  });
});
