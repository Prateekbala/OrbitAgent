import assert from 'node:assert/strict';
import { Client } from 'eve/client';
const host = process.env.EVE_RUNTIME_URL,
  secret = process.env.EVE_SERVICE_TOKEN;
assert(host && secret, 'Set EVE_RUNTIME_URL and EVE_SERVICE_TOKEN for the runtime smoke test.');
const client = new Client({ host, auth: { bearer: secret }, redirect: 'error' });
const health = await client.health();
assert.equal(health.status, 'ready');
const denied = await fetch(host + '/eve/v1/session', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
  redirect: 'error',
  signal: AbortSignal.timeout(10000),
});
assert.equal(denied.status, 401);
const info = await client.info();
assert.equal(info.tools.static.length, 0);
assert.equal(info.tools.dynamic.length, 0);
assert.equal(info.connections.length, 0);
const { session } = await client.sessions.create({ signal: AbortSignal.timeout(15000) });
assert(session.state.sessionId);
await session.reset({
  reason: 'No-inference authentication smoke test completed.',
  signal: AbortSignal.timeout(10000),
});
console.log(
  'Runtime health, authentication, disabled tool catalog and session lifecycle passed. No model prompt was sent.',
);
