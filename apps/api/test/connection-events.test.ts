import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { messagingFixture } from './messaging-fixture.js';
import { ConnectionService } from '../src/connections/service.js';
import { ConnectionEventWorker, eventSignature, verifyEvent } from '../src/connections/events.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
const secrets = new IdentitySecrets(Buffer.alloc(32, 5).toString('base64'));
let sends = 0;
beforeAll(async () => {
  f = await messagingFixture(undefined, undefined, {
    connectors: {
      async read() {
        return { title: 'Event refreshed', body: 'Refreshed bridge evidence' };
      },
    },
  });
});
afterAll(async () => {
  await f?.close();
});
async function setup(email = false) {
  const created = await f.call(f.owner, 'POST', '/v1/connections', {
      provider: 'github',
      name: 'Signed bridge',
      audience: 'personal',
      credential: 'bridge-provider-token',
    }),
    id = created.json().id;
  expect(created.statusCode, created.body).toBe(201);
  const channel = await f.channel('private');
  const response = await f.call(
    f.owner,
    'PUT',
    `/v1/connections/${id}/webhook`,
    email ? { emailChannelId: channel, emailSenders: ['sender@example.test'] } : {},
  );
  expect(response.statusCode, response.body).toBe(200);
  return {
    id,
    channel,
    ...(response.json() as { incomingSecret: string; outgoingSecret: string }),
  };
}
async function event(id: string, secret: string, payload: unknown, offset = 0) {
  const raw = JSON.stringify(payload),
    timestamp = String(Math.floor(Date.now() / 1000) + offset);
  return f.app.inject({
    method: 'POST',
    url: `/v1/connection-events/${f.ownerBoot.workspace.id}/${id}`,
    headers: {
      'content-type': 'application/json',
      'x-orbit-timestamp': timestamp,
      'x-orbit-signature': eventSignature(secret, timestamp, raw),
    },
    payload: raw,
  });
}
function worker() {
  return new ConnectionEventWorker(
    f.db,
    new ConnectionService(f.db, secrets, {
      async read() {
        return { title: 'Event refreshed', body: 'Refreshed bridge evidence' };
      },
    }),
    secrets,
    async () => {
      sends++;
      return 204;
    },
  );
}
describe('signed connection bridge', () => {
  it('verifies exact bytes, timestamps and replay IDs without trusting credentials as coverage', async () => {
    const hook = await setup(),
      payload = {
        eventId: 'evt-signature',
        kind: 'resource.changed',
        operation: 'issue.read',
        resource: 'acme/orbit/7',
      };
    expect((await event(hook.id, 'wrong-key', payload)).statusCode).toBe(401);
    expect((await event(hook.id, hook.incomingSecret, payload, -600)).statusCode).toBe(401);
    expect((await event(hook.id, hook.incomingSecret, payload)).statusCode).toBe(202);
    const duplicate = await event(hook.id, hook.incomingSecret, payload);
    expect(duplicate.statusCode, duplicate.body).toBe(202);
    expect(duplicate.json().duplicate).toBe(true);
    expect(
      (await event(hook.id, hook.incomingSecret, { ...payload, resource: 'acme/orbit/8' }))
        .statusCode,
    ).toBe(409);
    expect(verifyEvent(hook.incomingSecret, 'invalid', 'invalid', Buffer.from('{}'))).toBe(false);
  });
  it('dead letters events for ungranted resources and exposes metadata without retained event bodies', async () => {
    const hook = await setup();
    await event(hook.id, hook.incomingSecret, {
      eventId: 'evt-unknown-resource',
      kind: 'resource.changed',
      operation: 'issue.read',
      resource: 'acme/orbit/999',
    });
    await worker().tick();
    const listed = await f.call(f.owner, 'GET', `/v1/connections/${hook.id}/events`);
    expect(listed.json().items[0]).toMatchObject({
      state: 'dead',
      error_code: 'EVENT_RESOURCE_NOT_GRANTED',
    });
    expect(listed.body).not.toContain('payload');
  });
  it('delivers verified email once as a service identity and does not wake agents from email mentions', async () => {
    const hook = await setup(true),
      payload = {
        eventId: 'evt-email',
        kind: 'email.received',
        from: 'sender@example.test',
        subject: 'Launch update',
        body: 'External context @everyone',
        authentication: 'dkim-pass',
      };
    expect(
      (await event(hook.id, hook.incomingSecret, { ...payload, from: 'spoof@example.test' }))
        .statusCode,
    ).toBe(403);
    expect((await event(hook.id, hook.incomingSecret, payload)).statusCode).toBe(202);
    await worker().tick();
    await worker().tick();
    const messages = await f.messages(f.owner, hook.channel);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain('External email from sender@example.test');
    const [author] = await f.db.query(
      'SELECT m.kind,m.access_type FROM messages a JOIN memberships m ON m.id=a.author_id WHERE a.id=$1',
      [messages[0]!.id],
    );
    expect(author).toMatchObject({ kind: 'agent', access_type: 'service' });
    expect((await event(hook.id, hook.incomingSecret, payload)).json().duplicate).toBe(true);
    const [job] = await f.db.query('SELECT payload FROM connection_events WHERE connection_id=$1', [
      hook.id,
    ]);
    expect(JSON.stringify(job!.payload)).not.toContain('External context');
  });
  it('signs outbound status notifications, fences superseded destinations and stops after revocation', async () => {
    const hook = await setup();
    await f.db.query('UPDATE connection_webhooks SET endpoint=$2 WHERE connection_id=$1', [
      hook.id,
      'https://approved.example.test/hooks',
    ]);
    await event(hook.id, hook.incomingSecret, {
      eventId: 'evt-delete',
      kind: 'resource.deleted',
      resource: 'acme/orbit/7',
    });
    let observed = false;
    const sender = async (_url: string, headers: Record<string, string>, body: string) => {
      observed = true;
      expect(body).not.toContain('provider-token');
      expect(headers['x-orbit-signature']).toMatch(/^[a-f0-9]{64}$/);
      return 204;
    };
    const runner = new ConnectionEventWorker(
      f.db,
      new ConnectionService(f.db, secrets, {
        async read() {
          throw new Error('No read expected');
        },
      }),
      secrets,
      sender,
    );
    await runner.tick();
    expect(observed).toBe(true);
    await f.call(f.owner, 'DELETE', `/v1/connections/${hook.id}`, { version: 1 });
    expect(
      (
        await event(hook.id, hook.incomingSecret, {
          eventId: 'revoked',
          kind: 'resource.deleted',
          resource: 'acme/orbit/7',
        })
      ).statusCode,
    ).toBe(401);
    expect(sends).toBe(0);
  });
});
