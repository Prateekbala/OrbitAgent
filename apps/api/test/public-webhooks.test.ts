import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('../src/lib/safe-endpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/safe-endpoint.js')>();
  return {
    ...actual,
    validatePublicEndpoint: vi.fn(async (value: string, hosts: string[]) => {
      const url = new URL(value);
      if (url.hostname !== 'hooks.fixture.test' || !hosts.includes(url.hostname))
        throw new Error('Unapproved test host');
      return { url, address: { address: '8.8.8.8', family: 4 } };
    }),
  };
});
import { messagingFixture } from './messaging-fixture.js';
import { DeveloperWebhookWorker } from '../src/developer/webhooks.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
import { webhookSignature } from '../src/agents/webhooks.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
async function subscription(channel: string) {
  const r = await f.call(f.owner, 'POST', '/v1/developer/webhooks', {
    name: 'Fixture delivery',
    url: 'https://hooks.fixture.test/orbit',
    conversationIds: [channel],
    events: ['message.created'],
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; secret: string };
}
describe('public webhook delivery', () => {
  it('signs a stable metadata-only event and enforces current source audience before delivery', async () => {
    f = await messagingFixture(undefined, undefined, {
      developerWebhookHosts: ['hooks.fixture.test'],
    });
    const channel = await f.channel('private'),
      sub = await subscription(channel),
      secrets = new IdentitySecrets(Buffer.alloc(32, 5).toString('base64'));
    let calls = 0;
    const worker = new DeveloperWebhookWorker(f.db, secrets, async (_url, headers, body) => {
      calls++;
      expect(headers['webhook-signature']).toBe(
        'v1=' +
          webhookSignature(sub.secret, headers['webhook-id']!, headers['webhook-timestamp']!, body),
      );
      expect(body).not.toContain('Confidential body');
      return 200;
    });
    await f.send(f.owner, channel, 'Confidential body ' + randomUUID());
    await worker.tick();
    expect(calls).toBe(1);
    expect(
      (await f.call(f.owner, 'GET', `/v1/developer/webhooks/${sub.id}/deliveries`)).json().items[0]
        .state,
    ).toBe('delivered');
    await f.send(f.owner, channel, 'Earlier source');
    await f.db.query(
      'DELETE FROM conversation_members WHERE conversation_id=$1 AND membership_id=$2',
      [channel, f.ownerBoot.me.id],
    );
    await worker.tick();
    expect(calls).toBe(1);
  });
  it('retries with the same event identifier, dead-letters failures and fences paused subscriptions', async () => {
    f = await messagingFixture(undefined, undefined, {
      developerWebhookHosts: ['hooks.fixture.test'],
    });
    const channel = await f.channel(),
      sub = await subscription(channel),
      ids: string[] = [],
      worker = new DeveloperWebhookWorker(
        f.db,
        new IdentitySecrets(Buffer.alloc(32, 5).toString('base64')),
        async (_u, h) => {
          ids.push(h['webhook-id']!);
          return 503;
        },
      );
    await f.send(f.owner, channel, 'Delivery test');
    await worker.tick();
    await f.db.query(
      "UPDATE developer_deliveries SET available_at=now()-interval '1 minute',attempts=7 WHERE webhook_id=$1",
      [sub.id],
    );
    await worker.tick();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    const [d] = await f.db.query('SELECT * FROM developer_deliveries WHERE webhook_id=$1', [
      sub.id,
    ]);
    expect(d!.state).toBe('dead');
    expect(
      (await f.call(f.owner, 'POST', `/v1/developer/deliveries/${d!.id}/replay`, {})).statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/developer/webhooks/${sub.id}/control`, {
          version: 1,
          action: 'pause',
        })
      ).statusCode,
    ).toBe(200);
    await worker.tick();
    expect(ids).toHaveLength(2);
    expect(
      (await f.db.query('SELECT state FROM developer_deliveries WHERE id=$1', [d!.id]))[0]!.state,
    ).toBe('cancelled');
  });
});
