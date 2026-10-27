import { beforeAll, afterAll, it, expect } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { messagingFixture } from './messaging-fixture.js';
import { buildApp } from '../src/app.js';
import { IdentitySecrets, parsePreviousIdentityKeys } from '../src/identity/secrets.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
}, 30000);
afterAll(async () => f?.close());
it('shares rate limits across replicas, separates routes, and ignores forged forwarding headers', async () => {
  const options = {
    sharedRateLimits: true,
    realtimeKey: Buffer.alloc(32, 7).toString('base64'),
    metricsToken: 'operator-test-token',
  };
  const a = await buildApp(f.db, options),
    b = await buildApp(f.db, options);
  a.get('/limiter-probe', { config: { rateLimit: { max: 2, timeWindow: 60000 } } }, async () => ({
    ok: true,
  }));
  b.get('/limiter-probe', { config: { rateLimit: { max: 2, timeWindow: 60000 } } }, async () => ({
    ok: true,
  }));
  try {
    for (const app of [a, b])
      expect(
        (await app.inject({ method: 'GET', url: '/limiter-probe', remoteAddress: '127.99.2.1' }))
          .statusCode,
      ).toBe(200);
    expect(
      (
        await a.inject({
          method: 'GET',
          url: '/limiter-probe',
          remoteAddress: '127.99.2.1',
          headers: { 'x-forwarded-for': '1.2.3.4' },
        })
      ).statusCode,
    ).toBe(429);
    const metrics = await a.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { authorization: 'Bearer operator-test-token' },
    });
    expect(metrics.statusCode, metrics.body).toBe(200);
    expect(metrics.body).toContain('orbit_http_requests_total');
    expect(metrics.body).not.toContain('127.99.2.1');
    expect(
      (await b.inject({ method: 'GET', url: '/health', remoteAddress: '127.99.2.1' })).statusCode,
    ).toBe(200);
  } finally {
    await a.close();
    await b.close();
  }
});
it('opens legacy and retained-key envelopes, writes only with the current key, and rejects AAD substitution', () => {
  const old = randomBytes(32),
    current = randomBytes(32).toString('base64'),
    legacy = new IdentitySecrets(old.toString('base64')),
    ring = new IdentitySecrets(current, [old.toString('base64')]);
  const sealed = legacy.seal('provider:test', 'a private credential');
  expect(ring.open('provider:test', sealed)).toBe('a private credential');
  expect(ring.needsRewrap(sealed)).toBe(true);
  const migrated = ring.seal('provider:test', ring.open('provider:test', sealed));
  expect(ring.needsRewrap(migrated)).toBe(false);
  expect(() => new IdentitySecrets(current).open('provider:other', migrated)).toThrow();
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', old, iv);
  cipher.setAAD(Buffer.from('mfa:test'));
  const data = Buffer.concat([cipher.update('legacy secret'), cipher.final()]);
  const v1 = [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join('.');
  expect(ring.open('mfa:test', v1)).toBe('legacy secret');
  expect(() => parsePreviousIdentityKeys('not a keyring')).toThrow(/decrypt-only keys/);
});
it('rewraps persistent credentials in bounded batches without exposing plaintext or retiring keys', async () => {
  const { rewrapCredentials } = await import('../src/governance/rotation.js');
  const old = new IdentitySecrets(Buffer.alloc(32, 4).toString('base64')),
    ring = new IdentitySecrets(Buffer.alloc(32, 9).toString('base64'), [
      Buffer.alloc(32, 4).toString('base64'),
    ]);
  const account = (
    await f.db.query('SELECT account_id FROM memberships WHERE id=$1', [f.ownerBoot.me.id])
  )[0]!.account_id;
  await f.db.query('INSERT INTO account_mfa(account_id,secret) VALUES($1,$2)', [
    account,
    old.seal('mfa:' + account, 'TEST-MFA-SECRET'),
  ]);
  const dry = await rewrapCredentials(f.db, ring);
  expect(dry.inventory.find((x) => x.table === 'account_mfa')?.scanned).toBe(1);
  expect(dry.inventory.find((x) => x.table === 'account_mfa')?.changed).toBe(0);
  const result = await rewrapCredentials(f.db, ring, true);
  expect(result.retirementApproved).toBe(false);
  expect(JSON.stringify(result)).not.toContain('TEST-MFA-SECRET');
  const secret = (
    await f.db.query('SELECT secret FROM account_mfa WHERE account_id=$1', [account])
  )[0]!.secret;
  expect(ring.needsRewrap(String(secret))).toBe(false);
  expect(
    new IdentitySecrets(Buffer.alloc(32, 9).toString('base64')).open(
      'mfa:' + account,
      String(secret),
    ),
  ).toBe('TEST-MFA-SECRET');
});
