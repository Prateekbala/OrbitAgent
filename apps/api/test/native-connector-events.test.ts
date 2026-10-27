import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeEvent } from '../src/connections/native-events.js';
import { messagingFixture } from './messaging-fixture.js';
import { ConnectionService } from '../src/connections/service.js';
import { ConnectionEventWorker } from '../src/connections/events.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
import { ProviderFailure, type ConnectorProvider } from '../src/connections/provider.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => f?.close());
const sign = (secret: string, raw: string) =>
  createHmac('sha256', secret).update(raw).digest('hex');
describe('native connector webhook signatures', () => {
  it('verifies GitHub exact bytes and selects only issue resources', () => {
    const raw = JSON.stringify({
      action: 'edited',
      repository: { full_name: 'acme/orbit' },
      issue: { number: 7, body: 'Private provider text never retained' },
    });
    const headers = {
      'x-hub-signature-256': 'sha256=' + sign('secret', raw),
      'x-github-delivery': randomUUID(),
      'x-github-event': 'issues',
    };
    expect(nativeEvent('github', 'secret', headers, Buffer.from(raw))).toMatchObject({
      kind: 'resource.changed',
      operation: 'issue.read',
      resource: 'acme/orbit/7',
    });
    expect(() => nativeEvent('github', 'secret', headers, Buffer.from(raw + ' '))).toThrow();
  });
  it('enforces Linear’s signed body timestamp and does not trust an unsigned timestamp header', () => {
    const raw = JSON.stringify({
      type: 'Issue',
      action: 'remove',
      data: { id: randomUUID() },
      webhookTimestamp: Date.now() - 120000,
    });
    expect(() =>
      nativeEvent(
        'linear',
        'secret',
        {
          'linear-signature': sign('secret', raw),
          'linear-delivery': randomUUID(),
          'linear-event': 'Issue',
          'linear-timestamp': String(Date.now()),
        },
        Buffer.from(raw),
      ),
    ).toThrow();
    const fresh = JSON.stringify({ ...JSON.parse(raw), webhookTimestamp: Date.now() });
    expect(
      nativeEvent(
        'linear',
        'secret',
        {
          'linear-signature': sign('secret', fresh),
          'linear-delivery': randomUUID(),
          'linear-event': 'Issue',
        },
        Buffer.from(fresh),
      ),
    ).toMatchObject({ kind: 'resource.deleted' });
  });
  it('uses GitLab Standard Webhooks signing tokens and rejects the legacy plain token header', () => {
    const key = Buffer.alloc(32, 5),
      secret = 'whsec_' + key.toString('base64'),
      timestamp = String(Math.floor(Date.now() / 1000)),
      delivery = randomUUID();
    const raw = JSON.stringify({
      object_kind: 'issue',
      project: { id: 1 },
      object_attributes: { iid: 7, action: 'update' },
    });
    const signature = createHmac('sha256', key)
      .update(delivery + '.' + timestamp + '.' + raw)
      .digest('base64');
    expect(
      nativeEvent(
        'gitlab',
        secret,
        {
          'webhook-id': delivery,
          'webhook-timestamp': timestamp,
          'webhook-signature': 'v1,' + signature,
          'x-gitlab-event': 'Issue Hook',
        },
        Buffer.from(raw),
      ),
    ).toMatchObject({ resource: '1/7' });
    expect(() =>
      nativeEvent('gitlab', secret, { 'x-gitlab-token': secret }, Buffer.from(raw)),
    ).toThrow();
  });
  it('validates Stripe timestamped signatures, including key rotation headers', () => {
    const raw = JSON.stringify({
        id: 'evt_123',
        type: 'customer.updated',
        data: { object: { id: 'cus_123' } },
      }),
      timestamp = String(Math.floor(Date.now() / 1000)),
      signature = sign('whsec_secret', timestamp + '.' + raw);
    expect(
      nativeEvent(
        'stripe',
        'whsec_secret',
        { 'stripe-signature': `t=${timestamp},v1=bad,v1=${signature}` },
        Buffer.from(raw),
      ),
    ).toMatchObject({ operation: 'customer.read', resource: 'cus_123' });
    expect(() =>
      nativeEvent(
        'stripe',
        'whsec_secret',
        { 'stripe-signature': `t=1000000000,v1=${signature}` },
        Buffer.from(raw),
      ),
    ).toThrow();
  });
});
describe('native event ingestion and reconciliation', () => {
  async function setup() {
    let absent = false,
      expireLease = false,
      reads = 0;
    const provider: ConnectorProvider = {
      async read() {
        reads++;
        if (expireLease)
          await f.db.query(
            "UPDATE connection_events SET lease_until=now()-interval '1 second' WHERE state='leased'",
          );
        if (absent) throw new ProviderFailure('PROVIDER_RESOURCE_NOT_FOUND');
        return { title: 'Native issue', body: 'Current provider evidence ' + reads };
      },
    };
    f = await messagingFixture(undefined, undefined, { connectors: provider });
    const c = await f.call(f.owner, 'POST', '/v1/connections', {
      provider: 'github',
      name: 'Native webhook repository',
      audience: 'workspace',
      credential: 'private-provider-token',
    });
    const id = c.json().id;
    await f.call(f.owner, 'POST', `/v1/connections/${id}/import`, {
      operation: 'issue.read',
      resource: 'acme/orbit/7',
    });
    const configured = await f.call(f.owner, 'PUT', `/v1/connections/${id}/native-webhook`, {});
    expect(configured.statusCode, configured.body).toBe(200);
    const hook = configured.json(),
      secrets = new IdentitySecrets(Buffer.alloc(32, 5).toString('base64')),
      connections = new ConnectionService(f.db, secrets, provider),
      worker = new ConnectionEventWorker(f.db, connections, secrets, async () => 204);
    const deliver = (action = 'edited', delivery = randomUUID(), number = 7) => {
      const raw = JSON.stringify({
        action,
        repository: { full_name: 'acme/orbit' },
        issue: { number, body: 'Must not be stored from webhook bytes' },
      });
      return f.app.inject({
        method: 'POST',
        url: hook.incomingPath.replace('/api', ''),
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=' + sign(hook.incomingSecret, raw),
          'x-github-event': 'issues',
          'x-github-delivery': delivery,
        },
        payload: raw,
      });
    };
    const ready = () =>
      f.db.query("UPDATE connections SET next_request_at=now()-interval '1 second' WHERE id=$1", [
        id,
      ]);
    return {
      id,
      hook,
      worker,
      deliver,
      ready,
      remove: () => {
        absent = true;
      },
      expire: () => {
        expireLease = true;
      },
    };
  }
  it('deduplicates exact signed deliveries, rejects reused IDs with different bytes, and never imports an unselected resource', async () => {
    const s = await setup(),
      delivery = randomUUID();
    expect((await s.deliver('edited', delivery)).statusCode).toBe(202);
    expect((await s.deliver('edited', delivery)).json().duplicate).toBe(true);
    expect((await s.deliver('edited', randomUUID())).json().duplicate).toBe(true);
    expect((await s.deliver('closed', delivery)).statusCode).toBe(409);
    expect((await s.deliver('edited', randomUUID(), 999)).json().ignored).toBe(true);
    const [event] = await f.db.query('SELECT * FROM connection_events');
    expect(event!.protocol).toBe('native');
    expect(JSON.stringify(event)).not.toContain('Must not be stored');
    await s.ready();
    await s.worker.tick();
    const [done] = await f.db.query('SELECT state FROM connection_events');
    expect(done!.state).toBe('completed');
    expect((await f.call(f.mate, 'GET', `/v1/connections/${s.id}/native-webhook`)).statusCode).toBe(
      404,
    );
  });
  it('does not persist a provider refresh after losing its execution lease', async () => {
    const s = await setup();
    s.expire();
    await s.deliver();
    await s.ready();
    await s.worker.tick();
    const [resource] = await f.db.query('SELECT body FROM connection_resources');
    expect(resource!.body).toBe('Current provider evidence 1');
    const [job] = await f.db.query('SELECT state,error_code FROM connection_events');
    expect(job).toMatchObject({ state: 'pending', error_code: 'EVENT_LEASE_LOST' });
  });
  it('checks remote deletion and does not erase a still-existing resource after a delayed delete event', async () => {
    const s = await setup();
    await s.deliver('deleted');
    await s.ready();
    await s.worker.tick();
    let [resource] = await f.db.query('SELECT deleted_at FROM connection_resources');
    expect(resource!.deleted_at).toBeNull();
    const [pending] = await f.db.query('SELECT state,error_code FROM connection_events');
    expect(pending).toMatchObject({ state: 'pending', error_code: 'NATIVE_DELETION_UNCONFIRMED' });
    s.remove();
    await s.deliver('deleted');
    await f.db.query('UPDATE connection_events SET available_at=now()');
    await s.ready();
    await s.worker.tick();
    [resource] = await f.db.query('SELECT deleted_at,body FROM connection_resources');
    expect(resource!.deleted_at).toBeTruthy();
    expect(resource!.body).toBe('');
  });
  it('fences queued jobs when the native secret is rotated and never returns a stored secret', async () => {
    const s = await setup();
    await s.deliver();
    await f.call(f.owner, 'PUT', `/v1/connections/${s.id}/native-webhook`, {});
    const detail = await f.call(f.owner, 'GET', `/v1/connections/${s.id}/native-webhook`);
    expect(detail.body).not.toContain(s.hook.incomingSecret);
    await s.ready();
    await s.worker.tick();
    const [job] = await f.db.query('SELECT state,error_code FROM connection_events');
    expect(job!.state).not.toBe('completed');
    expect(job!.error_code).toBe('NATIVE_SUBSCRIPTION_REVOKED');
    expect((await s.deliver()).statusCode).toBe(401);
  });
});
