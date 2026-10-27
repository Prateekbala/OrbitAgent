import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { messagingFixture } from './messaging-fixture.js';
import type { CallMedia } from '../src/calls/provider.js';
import { CallWorker } from '../src/calls/worker.js';
import { NotificationDeliveryWorker } from '../src/notifications/delivery-worker.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
import { testEmail, TestMailbox } from './email.js';
import { DeliveryError, type EmailProvider } from '../src/email/provider.js';
import type { PushMessage, PushProvider } from '../src/notifications/delivery-providers.js';
import { deliveryPreferences } from '@ao/contracts/delivery';
import { nextDeliveryAt } from '../src/notifications/delivery-policy.js';
import { scopedDatabase, tenantScope, identifyPrincipal } from '@ao/database';

class Media implements CallMedia {
  url = 'ws://localhost:7880';
  recording = true;
  removed: string[] = [];
  closed: string[] = [];
  starts = 0;
  async mute() {}
  async ensureRoom() {}
  async ticket(room: string, id: string) {
    return room + ':' + id;
  }
  async remove(_room: string, id: string) {
    this.removed.push(id);
  }
  async close(room: string) {
    this.closed.push(room);
  }
  async recordings() {
    return [];
  }
  async record() {
    this.starts++;
    return 'egress-fixture';
  }
  async stopRecording() {}
}
const media = new Media(),
  pushes: PushMessage[] = [];
const push: PushProvider = {
  publicKey: 'fixture',
  supports: () => true,
  async send(_target, message) {
    pushes.push(message);
    return 'provider-id';
  },
};
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture(undefined, undefined, { media, push });
}, 30000);
afterAll(async () => f?.close());
const settings = () =>
  f.call(f.mate, 'PUT', '/v1/notification-delivery/preferences', {
    push: true,
    email: 'off',
    batchMinutes: 0,
  });
async function device() {
  return f.call(f.mate, 'POST', '/v1/notification-delivery/devices', {
    clientId: randomUUID(),
    name: 'Test browser',
    platform: 'browser',
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/' + randomUUID(),
      keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
    },
  });
}
const worker = () =>
  new NotificationDeliveryWorker(
    f.db,
    new IdentitySecrets(Buffer.alloc(32, 5).toString('base64')),
    testEmail(),
    push,
  );
describe('calls and private notification delivery', () => {
  it('requires explicit recording consent, separates agent consent, fences transcript corrections, and ends on withdrawal', async () => {
    const channel = await f.channel('private');
    const created = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/calls`, {
      clientId: randomUUID(),
      mode: 'retained_recording',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    expect((await f.call(f.mate, 'GET', `/v1/calls/${id}`)).statusCode).toBe(404);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/calls/${id}/join`, {
          clientId: randomUUID(),
          consent: false,
        })
      ).statusCode,
    ).toBe(409);
    const joined = await f.call(f.owner, 'POST', `/v1/calls/${id}/join`, {
      clientId: randomUUID(),
      consent: true,
    });
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json().call.participants[0].voice_consent).toBe(false);
    const caption = await f.call(f.owner, 'POST', `/v1/calls/${id}/transcript`, {
      clientId: randomUUID(),
      text: 'We should review the launch.',
      startMs: 0,
      endMs: 2000,
    });
    expect(caption.statusCode, caption.body).toBe(200);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/calls/${id}/transcript/${caption.json().id}`, {
          version: 1,
          text: 'Review the launch on Friday.',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/calls/${id}/transcript/${caption.json().id}`, {
          version: 1,
          text: 'Stale correction',
        })
      ).statusCode,
    ).toBe(409);
    const notes = await f.call(f.owner, 'PUT', `/v1/calls/${id}/notes`, {
      version: 1,
      summary: 'Launch review',
      chapters: [{ startMs: 0, title: 'Launch' }],
      proposedActions: [
        { title: 'Review launch', assigneeId: null, sourceSegmentIds: [caption.json().id] },
      ],
    });
    expect(notes.statusCode, notes.body).toBe(200);
    await new CallWorker(f.db, media).tick();
    expect(media.starts).toBe(1);
    await f.call(f.owner, 'POST', `/v1/calls/${id}/leave`, {
      participantId: joined.json().participantId,
      withdraw: true,
    });
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/calls/${id}/join`, {
          clientId: randomUUID(),
          consent: true,
        })
      ).statusCode,
    ).toBe(409);
    await new CallWorker(f.db, media).tick();
    expect(media.closed).toContain(created.json().room_name);
    expect((await f.call(f.owner, 'GET', `/v1/calls/${id}`)).json().state).toBe('ended');
  });
  it('never retains content in no-recording or transient-caption modes and enforces tenant RLS', async () => {
    const channel = await f.channel();
    const response = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/calls`, {
      clientId: randomUUID(),
      mode: 'transient_captions',
    });
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json().id;
    await f.call(f.owner, 'POST', `/v1/calls/${id}/join`, {
      clientId: randomUUID(),
      consent: true,
    });
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/calls/${id}/transcript`, {
          clientId: randomUUID(),
          text: 'Do not save this.',
          startMs: 1,
          endMs: 100,
        })
      ).statusCode,
    ).toBe(409);
    expect((await f.call(f.other, 'GET', `/v1/calls/${id}`)).statusCode).toBe(404);
    const rows = await tenantScope(f.otherBoot.workspace.id, async () => {
      identifyPrincipal(f.otherBoot.me.id, 'member');
      return scopedDatabase(f.db).query('SELECT id FROM calls WHERE id=$1', [id]);
    });
    expect(rows).toEqual([]);
  });
  it('delivers a generic push once, encrypts endpoints, and accepts scoped idempotent receipts', async () => {
    await settings();
    const registered = await device();
    expect(registered.statusCode, registered.body).toBe(200);
    const channel = (
      await f.call(f.owner, 'POST', '/v1/conversations/direct', { membershipId: f.mateBoot.me.id })
    ).json().id;
    await f.send(f.owner, channel, 'Confidential source text');
    const before = pushes.length;
    await worker().tick();
    expect(pushes.length).toBe(before + 1);
    expect(JSON.stringify(pushes.at(-1))).not.toContain('Confidential');
    await worker().tick();
    expect(pushes.length).toBe(before + 1);
    const [stored] = await f.db.query('SELECT ciphertext FROM notification_devices WHERE id=$1', [
      registered.json().id,
    ]);
    expect(String(stored!.ciphertext)).not.toContain('fcm.googleapis.com');
    const receipt = pushes.at(-1)!.receipt;
    expect(
      (
        await f.call('', 'POST', '/v1/notification-delivery/receipts', {
          ...receipt,
          state: 'opened',
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.call(f.mate, 'GET', '/v1/notification-delivery/history')).json()[0].state).toBe(
      'opened',
    );
    expect((await f.call(f.owner, 'GET', '/v1/notification-delivery/history')).json()).toEqual([]);
  });
  it('rechecks revoked access, deleted messages, preferences and session/device ownership before dispatch', async () => {
    const id = (await device()).json().id;
    await settings();
    const channel = (
      await f.call(f.owner, 'POST', '/v1/conversations/direct', { membershipId: f.mateBoot.me.id })
    ).json().id;
    const sent = await f.send(f.owner, channel, 'Retracted before delivery');
    await f.call(f.owner, 'DELETE', `/v1/messages/${sent.json().id}`, { version: 1 });
    const before = pushes.length;
    await worker().tick();
    expect(pushes.length).toBe(before);
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/notification-delivery/devices/${id}`)).statusCode,
    ).toBe(404);
    expect(
      (await f.call(f.mate, 'DELETE', `/v1/notification-delivery/devices/${id}`)).statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.mate, 'POST', '/v1/notification-delivery/devices', {
          clientId: randomUUID(),
          name: 'SSRF',
          platform: 'browser',
          subscription: {
            endpoint: 'https://127.0.0.1/admin',
            keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
          },
        })
      ).statusCode,
    ).toBe(400);
  });
});
describe('timezone delivery policy', () => {
  it('crosses spring and autumn DST transitions without constructing nonexistent local times', () => {
    const p = deliveryPreferences.parse({
      timezone: 'America/New_York',
      quietStart: 22 * 60,
      quietEnd: 8 * 60,
      batchMinutes: 0,
    });
    expect(nextDeliveryAt(new Date('2026-03-08T06:30:00Z'), p, 'push').toISOString()).toBe(
      '2026-03-08T12:00:00.000Z',
    );
    expect(nextDeliveryAt(new Date('2026-11-01T05:30:00Z'), p, 'push').toISOString()).toBe(
      '2026-11-01T13:00:00.000Z',
    );
    expect(deliveryPreferences.safeParse({ quietStart: 0, quietEnd: 0 }).success).toBe(false);
  });
  it('defers a daily digest past quiet hours even when 9 AM is quiet', () => {
    const p = deliveryPreferences.parse({
      email: 'daily',
      timezone: 'Asia/Kolkata',
      quietStart: 8 * 60,
      quietEnd: 20 * 60,
      batchMinutes: 0,
    });
    expect(nextDeliveryAt(new Date('2026-10-26T02:00:00Z'), p, 'email').toISOString()).toBe(
      '2026-10-26T14:30:00.000Z',
    );
  });
});
describe('revocation and delivery failure boundaries', () => {
  it('applies agent preferences to agent-authored messages as well as run alerts', async () => {
    await f.db.query('DELETE FROM notifications');
    await settings();
    await device();
    const channel = await f.channel(),
      created = await f.call(f.owner, 'POST', '/v1/agents', {
        name: 'Delivery agent',
        role: 'Answer team questions safely.',
        runtime: 'external',
      });
    expect(created.statusCode, created.body).toBe(201);
    await f.call(f.mate, 'PUT', `/v1/conversations/${channel}/notification-preferences`, {
      mode: 'all',
    });
    const muted = await f.call(f.mate, 'PUT', '/v1/notification-delivery/scopes', {
      scope: 'agent',
      resourceId: created.json().id,
      mode: 'muted',
    });
    expect(muted.statusCode, muted.body).toBe(200);
    const send = () =>
      f.app.inject({
        method: 'POST',
        url: `/v1/conversations/${channel}/messages`,
        headers: { authorization: 'Bearer ' + created.json().key },
        payload: { clientId: randomUUID(), body: 'Agent update' },
      });
    const sent = await send();
    expect(sent.statusCode, sent.body).toBe(201);
    const before = pushes.length;
    await worker().tick();
    expect(pushes).toHaveLength(before);
    await f.call(f.mate, 'PUT', '/v1/notification-delivery/scopes', {
      scope: 'agent',
      resourceId: created.json().id,
      mode: 'high',
    });
    expect((await send()).statusCode).toBe(201);
    await worker().tick();
    expect(pushes).toHaveLength(before + 1);
  });
  it('escalates high-priority push only after the configured unread delay', async () => {
    await f.db.query('DELETE FROM notifications');
    await device();
    const preferences = await f.call(f.mate, 'PUT', '/v1/notification-delivery/preferences', {
      push: true,
      email: 'immediate',
      batchMinutes: 0,
      escalationMinutes: 15,
    });
    expect(preferences.statusCode, preferences.body).toBe(200);
    const channel = (
      await f.call(f.owner, 'POST', '/v1/conversations/direct', { membershipId: f.mateBoot.me.id })
    ).json().id;
    expect(
      (
        await f.call(f.mate, 'PUT', '/v1/notification-delivery/scopes', {
          scope: 'conversation',
          resourceId: channel,
          mode: 'high',
        })
      ).statusCode,
    ).toBe(200);
    await f.send(f.owner, channel, 'Review this privately.');
    const mailbox = new TestMailbox(),
      delivery = new NotificationDeliveryWorker(
        f.db,
        new IdentitySecrets(Buffer.alloc(32, 5).toString('base64')),
        testEmail(mailbox),
        push,
      );
    await delivery.tick();
    expect(mailbox.messages).toHaveLength(0);
    expect(
      await f.db.query(
        "SELECT id FROM notification_deliveries WHERE channel='push' AND state='sent'",
      ),
    ).toHaveLength(1);
    await f.db.query(
      "UPDATE notification_deliveries SET sent_at=now()-interval '20 minutes' WHERE channel='push'",
    );
    await delivery.tick();
    expect(mailbox.messages).toHaveLength(1);
    await delivery.tick();
    expect(mailbox.messages).toHaveLength(1);
    await f.call(f.mate, 'PUT', '/v1/notification-delivery/scopes', {
      scope: 'conversation',
      resourceId: channel,
      mode: 'default',
    });
  });
  it('removes a live participant after private-channel access is revoked and rejects old snapshots', async () => {
    const channel = await f.channel('private');
    await f.db.query(
      'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id) VALUES($1,$2,$3)',
      [f.ownerBoot.workspace.id, channel, f.mateBoot.me.id],
    );
    const created = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/calls`, {
      clientId: randomUUID(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const joined = await f.call(f.mate, 'POST', `/v1/calls/${id}/join`, {
      clientId: randomUUID(),
      consent: false,
    });
    expect(joined.statusCode, joined.body).toBe(200);
    await f.db.query(
      'DELETE FROM conversation_members WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3',
      [f.ownerBoot.workspace.id, channel, f.mateBoot.me.id],
    );
    expect((await f.call(f.mate, 'GET', `/v1/calls/${id}`)).statusCode).toBe(404);
    await new CallWorker(f.db, media).tick();
    expect(media.removed).toContain(joined.json().participantId);
  });
  it('invalidates retained evidence immediately on deletion and purges correction history', async () => {
    const channel = await f.channel();
    const call = (
      await f.call(f.owner, 'POST', `/v1/conversations/${channel}/calls`, {
        clientId: randomUUID(),
        mode: 'retained_recording',
      })
    ).json();
    await f.call(f.owner, 'POST', `/v1/calls/${call.id}/join`, {
      clientId: randomUUID(),
      consent: true,
    });
    const segment = await f.call(f.owner, 'POST', `/v1/calls/${call.id}/transcript`, {
      clientId: randomUUID(),
      text: 'Retention evidence',
      startMs: 0,
      endMs: 1000,
    });
    expect(segment.statusCode, segment.body).toBe(200);
    const [transcript] = await f.db.query(
      'SELECT body FROM retained_transcripts WHERE call_id=$1',
      [call.id],
    );
    expect(transcript!.body).toContain('Retention evidence');
    const deletion = await f.call(f.owner, 'DELETE', `/v1/calls/${call.id}/content`);
    expect(deletion.statusCode, deletion.body).toBe(200);
    expect((await f.call(f.owner, 'GET', `/v1/calls/${call.id}/transcript`)).statusCode).toBe(404);
    expect(
      await f.db.query('SELECT id FROM retained_transcripts WHERE call_id=$1', [call.id]),
    ).toEqual([]);
    await new CallWorker(f.db, media).tick();
    expect(
      await f.db.query('SELECT * FROM call_segment_versions WHERE segment_id=$1', [
        segment.json().id,
      ]),
    ).toEqual([]);
  });
  it('never blindly retries an ambiguous SMTP send and never includes message content', async () => {
    await f.db.query('DELETE FROM notifications');
    let sends = 0,
      body = '';
    const provider: EmailProvider = {
      id: 'gmail',
      idempotent: false,
      async send(message) {
        sends++;
        body = JSON.stringify(message);
        throw new DeliveryError('SMTP_UNKNOWN', true, true);
      },
    };
    const response = await f.call(f.mate, 'PUT', '/v1/notification-delivery/preferences', {
      push: false,
      email: 'immediate',
      batchMinutes: 0,
    });
    expect(response.statusCode, response.body).toBe(200);
    const channel = (
      await f.call(f.owner, 'POST', '/v1/conversations/direct', { membershipId: f.mateBoot.me.id })
    ).json().id;
    await f.send(f.owner, channel, 'Secret from a private conversation');
    const delivery = new NotificationDeliveryWorker(
      f.db,
      new IdentitySecrets(Buffer.alloc(32, 5).toString('base64')),
      testEmail(provider),
      push,
    );
    await delivery.tick();
    await delivery.tick();
    expect(sends).toBe(1);
    expect(body).not.toContain('Secret from');
    const history = (await f.call(f.mate, 'GET', '/v1/notification-delivery/history')).json();
    expect(history[0]).toMatchObject({ channel: 'email', state: 'outcome_unknown' });
  });
});
