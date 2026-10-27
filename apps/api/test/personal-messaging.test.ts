import { afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tenantScope, identifyPrincipal, scopedDatabase } from '@ao/database';
import { mentionToken } from '@ao/contracts/personal';
import { messagingFixture } from './messaging-fixture.js';
import { MessageDeliveryWorker } from '../src/messaging/worker.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
async function group(historyPolicy: 'retained' | 'join_time' = 'join_time') {
  const r = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
    title: 'Private planning',
    membershipIds: [f.mateBoot.me.id],
    historyPolicy,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function third() {
  const email = (await f.call(f.other, 'GET', '/v1/account')).json().email,
    invite = await f.call(f.owner, 'POST', '/v1/invitations', { email }),
    accepted = await f.call(f.other, 'POST', '/v1/invitations/accept', {
      token: invite.json().token,
    });
  expect(accepted.statusCode, accepted.body).toBe(201);
  const session = accepted.cookies[0]!.value;
  return { session, member: (await f.boot(session)).me.id };
}
async function schedule(body: string, conversation = f.ownerBoot.channels[0]!.id) {
  const result = await f.call(
    f.owner,
    'POST',
    `/v1/conversations/${conversation}/scheduled-messages`,
    {
      body,
      format: 'markdown',
      clientId: randomUUID(),
      sendAt: new Date(Date.now() + 60000).toISOString(),
    },
  );
  expect(result.statusCode, result.body).toBe(201);
  return result.json().id as string;
}
describe('messaging and personal organization', () => {
  it('serializes competing drafts and idempotent scheduled admission without lock upgrades', async () => {
    f = await messagingFixture();
    const channel = f.ownerBoot.channels[0]!.id;
    const drafts = await Promise.all(
      ['one', 'two', 'three'].map((body) =>
        f.call(f.owner, 'PUT', `/v1/conversations/${channel}/draft`, { body, version: 0 }),
      ),
    );
    expect(drafts.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    const input = {
      body: 'Admit once',
      clientId: randomUUID(),
      sendAt: new Date(Date.now() + 60000).toISOString(),
    };
    const schedules = await Promise.all(
      Array.from({ length: 3 }, () =>
        f.call(f.owner, 'POST', `/v1/conversations/${channel}/scheduled-messages`, input),
      ),
    );
    expect(schedules.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    expect(new Set(schedules.map((r) => r.json().id)).size).toBe(1);
  });
  it('uses structured identity links for agent activation and ignores names, escaped links, and code samples', async () => {
    f = await messagingFixture();
    const channel = f.ownerBoot.channels[0]!.id,
      agent = (
        await f.call(f.owner, 'POST', '/v1/agents', {
          name: 'Atlas',
          role: 'Investigate carefully',
        })
      ).json(),
      agents = (await f.call(f.owner, 'GET', '/v1/agents')).json(),
      member = agents.find((a: { id: string }) => a.id === agent.id).membership_id;
    const send = (body: string) =>
      f.call(f.owner, 'POST', `/v1/conversations/${channel}/messages`, {
        body,
        format: 'markdown',
        clientId: randomUUID(),
      });
    for (const body of [
      '@Atlas please help',
      '`' + mentionToken({ id: member, name: 'Atlas' }) + '`',
      '```\n' + mentionToken({ id: member, name: 'Atlas' }) + '\n```',
    ])
      expect((await send(body)).statusCode).toBe(201);
    expect(
      (
        await f.app.inject({
          url: '/v1/agent/inbox',
          headers: { authorization: 'Bearer ' + agent.key },
        })
      ).json(),
    ).toHaveLength(0);
    const message = await send(
      '**Investigate** ' + mentionToken({ id: member, name: 'Old display name' }),
    );
    expect(message.statusCode, message.body).toBe(201);
    const inbox = (
      await f.app.inject({
        url: '/v1/agent/inbox',
        headers: { authorization: 'Bearer ' + agent.key },
      })
    ).json();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].message_id).toBe(message.json().id);
    const read = (await f.messages(f.owner, channel)).find((m) => m.id === message.json().id);
    expect(read).toMatchObject({
      format: 'markdown',
      mentions: [{ id: member, name: 'Atlas', kind: 'agent' }],
    });
    expect((await send(mentionToken({ id: f.otherBoot.me.id, name: 'Forged' }))).statusCode).toBe(
      400,
    );
  });
  it('keeps saves personal, pins shared, and explicit thread following independent from participation', async () => {
    f = await messagingFixture();
    const channel = f.ownerBoot.channels[0]!.id,
      root = (await f.send(f.owner, channel, 'Follow this decision')).json().id;
    expect((await f.call(f.mate, 'PUT', `/v1/messages/${root}/saved`)).statusCode).toBe(200);
    expect((await f.call(f.owner, 'GET', '/v1/saved-messages')).json().items).toHaveLength(0);
    expect((await f.call(f.mate, 'GET', '/v1/saved-messages')).json().items).toHaveLength(1);
    expect((await f.call(f.mate, 'PUT', `/v1/messages/${root}/pin`)).statusCode).toBe(200);
    expect(
      (await f.call(f.owner, 'GET', `/v1/conversations/${channel}/pins`)).json().items,
    ).toHaveLength(1);
    await f.call(f.mate, 'PUT', `/v1/messages/${root}/follow`);
    await f.send(f.owner, channel, 'Reply for watcher', root);
    const notifications = (await f.call(f.mate, 'GET', '/v1/notifications')).json();
    expect(notifications.items.some((n: { kind: string }) => n.kind === 'reply')).toBe(true);
    await f.call(f.mate, 'DELETE', `/v1/messages/${root}/follow`);
    const second = (await f.send(f.owner, channel, 'Unfollowed reply', root)).json().id;
    expect(
      (await f.call(f.mate, 'GET', '/v1/notifications'))
        .json()
        .items.some((n: { resource_id: string }) => n.resource_id === second),
    ).toBe(false);
    await f.call(f.owner, 'DELETE', `/v1/messages/${root}`, { version: 1 });
    expect((await f.call(f.mate, 'GET', '/v1/saved-messages')).json().items).toHaveLength(0);
  });
  it('stores versioned per-conversation and thread drafts without overwriting another device', async () => {
    f = await messagingFixture();
    const channel = f.ownerBoot.channels[0]!.id,
      path = `/v1/conversations/${channel}/draft`;
    expect((await f.call(f.owner, 'GET', path)).json().version).toBe(0);
    const first = await f.call(f.owner, 'PUT', path, {
      body: '**Persistent** draft',
      format: 'markdown',
      version: 0,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().version).toBe(1);
    expect((await f.call(f.mate, 'GET', path)).json().body).toBe('');
    expect(
      (await f.call(f.owner, 'PUT', path, { body: 'Stale update', version: 0 })).statusCode,
    ).toBe(409);
    const root = (await f.send(f.owner, channel, 'Thread root')).json().id;
    expect(
      (await f.call(f.owner, 'PUT', path, { body: 'Thread draft', version: 0, threadId: root }))
        .statusCode,
    ).toBe(200);
    expect((await f.call(f.owner, 'GET', path + '?threadId=' + root)).json().body).toBe(
      'Thread draft',
    );
    expect((await f.call(f.owner, 'GET', '/v1/drafts')).json().items).toHaveLength(2);
    expect((await f.call(f.other, 'GET', path)).statusCode).toBe(404);
  });
  it('delivers scheduled messages once, honors cancellation, and blocks revoked authority or archived channels', async () => {
    f = await messagingFixture();
    const channel = f.ownerBoot.channels[0]!.id,
      id = await schedule('Scheduled delivery'),
      cancelled = await schedule('Cancelled delivery');
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/scheduled-messages/${id}`, { version: 1, cancel: true }))
        .statusCode,
    ).toBe(404);
    await f.call(f.owner, 'PATCH', `/v1/scheduled-messages/${cancelled}`, {
      version: 1,
      cancel: true,
    });
    await f.db.query("UPDATE scheduled_messages SET send_at=now()-interval '1 second'");
    await Promise.all([
      new MessageDeliveryWorker(f.db).tick(),
      new MessageDeliveryWorker(f.db).tick(),
    ]);
    await new MessageDeliveryWorker(f.db).tick();
    expect(
      (await f.messages(f.owner, channel)).filter((m) => m.body === 'Scheduled delivery'),
    ).toHaveLength(1);
    expect((await f.messages(f.owner, channel)).some((m) => m.body === 'Cancelled delivery')).toBe(
      false,
    );
    const list = (await f.call(f.owner, 'GET', '/v1/scheduled-messages')).json().items;
    expect(list.find((i: { id: string }) => i.id === id).status).toBe('sent');
    const blocked = await schedule('Archived delivery');
    const c = (await f.boot(f.owner)).channels.find((c) => c.id === channel)!;
    await f.call(f.owner, 'PATCH', `/v1/conversations/${channel}/channel`, {
      version: c.version,
      archived: true,
    });
    await f.db.query('UPDATE scheduled_messages SET send_at=now() WHERE id=$1', [blocked]);
    await new MessageDeliveryWorker(f.db).tick();
    expect(
      (await f.call(f.owner, 'GET', '/v1/scheduled-messages'))
        .json()
        .items.find((i: { id: string }) => i.id === blocked),
    ).toMatchObject({ status: 'blocked', error_code: 'CHANNEL_ARCHIVED' });
    expect((await f.send(f.owner, channel, 'Archived write')).statusCode).toBe(409);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/conversations/${channel}/messages`, {
          body: 'Wrong account replay',
          clientId: randomUUID(),
          expectedAuthorId: f.mateBoot.me.id,
        })
      ).json().error.code,
    ).toBe('SENDING_IDENTITY_CHANGED');
  });
  it('enforces join-time history in SQL, search, context, roots, and saved references after rejoining', async () => {
    f = await messagingFixture();
    const id = await group(),
      old = (await f.send(f.owner, id, 'Confidential before join')).json().id;
    const interval = (await f.boot(f.mate)).channels.find((c) => c.id === id)!.access_interval_id;
    const task = (
      await f.call(f.owner, 'POST', '/v1/tasks', {
        title: 'Earlier confidential task',
        conversationId: id,
      })
    ).json();
    const knowledge = (
      await f.call(f.owner, 'POST', '/v1/knowledge', {
        title: 'Earlier confidential knowledge',
        body: 'Context from earlier messages',
        conversationId: id,
      })
    ).json();
    expect((await f.call(f.mate, 'GET', `/v1/tasks/${task.id}`)).statusCode).toBe(200);
    await f.call(f.mate, 'PUT', `/v1/messages/${old}/saved`);
    await f.call(f.owner, 'PATCH', `/v1/conversations/${id}`, {
      version: 1,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    await f.call(f.owner, 'PATCH', `/v1/conversations/${id}`, {
      version: 2,
      member: { membershipId: f.mateBoot.me.id, action: 'add' },
    });
    expect((await f.call(f.mate, 'GET', `/v1/tasks/${task.id}`)).statusCode).toBe(404);
    expect((await f.call(f.mate, 'GET', `/v1/knowledge/${knowledge.id}`)).statusCode).toBe(404);
    expect(
      (
        await f.call(f.mate, 'POST', `/v1/conversations/${id}/messages`, {
          body: 'Old queued intent',
          clientId: randomUUID(),
          expectedAuthorId: f.mateBoot.me.id,
          expectedAccessInterval: interval,
        })
      ).json().error.code,
    ).toBe('SENDING_AUTHORITY_CHANGED');
    expect(await f.messages(f.mate, id)).toHaveLength(0);
    expect((await f.call(f.mate, 'GET', `/v1/messages/${old}/context`)).statusCode).toBe(404);
    expect((await f.call(f.mate, 'GET', '/v1/search?q=Confidential')).json()).toHaveLength(0);
    expect((await f.call(f.mate, 'GET', '/v1/saved-messages')).json().items).toHaveLength(0);
    expect((await f.send(f.mate, id, 'Reply to old root', old)).statusCode).toBe(400);
    await f.send(f.owner, id, 'Visible after join');
    expect((await f.messages(f.mate, id)).map((m) => m.body)).toEqual(['Visible after join']);
    const scoped = scopedDatabase(f.db);
    const rows = await tenantScope(f.ownerBoot.workspace.id, async () => {
      identifyPrincipal(f.mateBoot.me.id, 'member');
      return scoped.query('SELECT body FROM messages WHERE conversation_id=$1', [id]);
    });
    expect(rows.map((r) => r.body)).toEqual(['Visible after join']);
    await expect(
      tenantScope(f.ownerBoot.workspace.id, async () => {
        identifyPrincipal(f.mateBoot.me.id, 'member');
        return scoped.query(
          'UPDATE conversation_members SET history_from_sequence=0 WHERE conversation_id=$1 AND membership_id=$2',
          [id, f.mateBoot.me.id],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      await f.db.query(
        'SELECT * FROM conversation_membership_intervals WHERE conversation_id=$1 AND membership_id=$2',
        [id, f.mateBoot.me.id],
      ),
    ).toHaveLength(2);
  });
  it('requires unanimous, version-bound consent before expanding retained private group history', async () => {
    f = await messagingFixture();
    const target = await third(),
      id = await group('retained'),
      old = (await f.send(f.owner, id, 'Earlier shared context')).json().id;
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/conversations/${id}`, {
          version: 1,
          member: { membershipId: target.member, action: 'add' },
        })
      ).json().error.code,
    ).toBe('HISTORY_CONSENT_REQUIRED');
    const proposed = await f.call(f.owner, 'POST', `/v1/conversations/${id}/history-proposals`, {
      membershipId: target.member,
      version: 1,
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    expect(proposed.json().accepted).toBe(false);
    expect(
      (await f.call(target.session, 'GET', `/v1/conversations/${id}/history-proposals`)).statusCode,
    ).toBe(404);
    const vote = await f.call(
      f.mate,
      'PUT',
      `/v1/conversations/${id}/history-proposals/${proposed.json().id}/vote`,
      { decision: 'approve' },
    );
    expect(vote.statusCode, vote.body).toBe(200);
    expect(vote.json().accepted).toBe(true);
    expect((await f.messages(target.session, id))[0]?.id).toBe(old);
  });
  it('discovers and restores channels, versions sidebar preferences, and binds keyset cursors to the viewer', async () => {
    f = await messagingFixture();
    const id = await f.channel(),
      c = (await f.boot(f.owner)).channels.find((c) => c.id === id)!;
    const discovery = await f.call(f.mate, 'GET', '/v1/channels/discover');
    expect(discovery.statusCode, discovery.body).toBe(200);
    expect(discovery.json().items.some((i: { id: string }) => i.id === id)).toBe(true);
    expect((await f.call(f.mate, 'PUT', `/v1/conversations/${id}/join`)).statusCode).toBe(200);
    const prefs = {
      version: 0,
      sections: [{ id: randomUUID(), name: 'Priority', conversationIds: [id] }],
      hiddenIds: [],
    };
    expect((await f.call(f.owner, 'PUT', '/v1/sidebar', prefs)).statusCode).toBe(200);
    expect((await f.call(f.owner, 'PUT', '/v1/sidebar', prefs)).statusCode).toBe(409);
    expect((await f.call(f.mate, 'GET', '/v1/sidebar')).json().sections).toEqual([]);
    await f.call(f.owner, 'PATCH', `/v1/conversations/${id}/channel`, {
      version: c.version,
      archived: true,
    });
    expect(
      (await f.call(f.owner, 'GET', '/v1/channels/discover?archived=true'))
        .json()
        .items.some((i: { id: string }) => i.id === id),
    ).toBe(true);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/conversations/${id}/channel`, {
          version: c.version + 1,
          archived: false,
        })
      ).statusCode,
    ).toBe(200);
    const first = (await f.call(f.owner, 'GET', '/v1/collections/members?limit=1')).json();
    expect(first.next).toBeTruthy();
    expect(
      (await f.call(f.mate, 'GET', '/v1/collections/members?after=' + first.next)).statusCode,
    ).toBe(400);
    const next = (
      await f.call(f.owner, 'GET', '/v1/collections/members?limit=1&after=' + first.next)
    ).json();
    expect(next.items[0].id).not.toBe(first.items[0].id);
  });
});
