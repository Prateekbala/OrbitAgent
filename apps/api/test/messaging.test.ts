import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { scopedDatabase, tenantScope } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
}, 30000);
afterAll(async () => f?.close());
describe('message lifecycle', () => {
  it('edits only an author’s message with optimistic concurrency and updates search', async () => {
    const channel = await f.channel(),
      message = (await f.send(f.owner, channel, 'originalquartz')).json().id;
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/messages/${message}`, { body: 'forged', version: 1 }))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.call(f.other, 'PATCH', `/v1/messages/${message}`, { body: 'forged', version: 1 }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/messages/${message}`, {
          body: 'revisedquartz',
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/messages/${message}`, { body: 'stale', version: 1 }))
        .statusCode,
    ).toBe(409);
    const [current] = await f.messages(f.mate, channel);
    expect(current).toMatchObject({ body: 'revisedquartz', version: 2 });
    expect(current?.edited_at).toBeTruthy();
    expect((await f.call(f.owner, 'GET', '/v1/search?q=originalquartz')).json()).toEqual([]);
    expect((await f.call(f.owner, 'GET', '/v1/search?q=revisedquartz')).json()).toHaveLength(1);
    const results = await Promise.all(
      ['one', 'two'].map((body) =>
        f.call(f.owner, 'PATCH', `/v1/messages/${message}`, { body, version: 2 }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const mateMessage = (await f.send(f.mate, channel, 'A teammate’s words')).json().id;
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/messages/${mateMessage}`, {
          body: 'admin cannot edit authorship',
          version: 1,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('preserves creation idempotency after editing and deletion without restoring content', async () => {
    const channel = await f.channel(),
      clientId = randomUUID();
    const message = (await f.send(f.owner, channel, 'Original request', undefined, clientId)).json()
      .id;
    await f.call(f.owner, 'PATCH', `/v1/messages/${message}`, {
      body: 'Edited request',
      version: 1,
    });
    expect(
      (await f.send(f.owner, channel, 'Original request', undefined, clientId)).statusCode,
    ).toBe(200);
    expect((await f.send(f.owner, channel, 'Edited request', undefined, clientId)).statusCode).toBe(
      409,
    );
    await f.call(f.owner, 'DELETE', `/v1/messages/${message}`, { version: 2 });
    expect(
      (await f.send(f.owner, channel, 'Original request', undefined, clientId)).json().id,
    ).toBe(message);
    const [deleted] = await f.messages(f.owner, channel);
    expect(deleted?.body).toBe('');
    expect(deleted?.deleted_at).toBeTruthy();
    expect(
      (
        await f.db.query(
          "SELECT id FROM outbox_events WHERE resource_id=$1 AND event_type='message.created'",
          [message],
        )
      ).length,
    ).toBe(1);
  });
  it('tombstones text, clears reactions and preserves replies, with guarded administrative deletion', async () => {
    const channel = await f.channel(),
      root = (await f.send(f.mate, channel, 'deletionquartz')).json().id;
    const reply = (await f.send(f.owner, channel, 'A reply remains', root)).json().id;
    await f.call(f.owner, 'PUT', `/v1/messages/${root}/reactions`, { emoji: '👍' });
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/messages/${root}`, { version: 2 })).statusCode,
    ).toBe(409);
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/messages/${root}`, { version: 1 })).statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/messages/${root}`, { version: 1 })).statusCode,
    ).toBe(200);
    expect((await f.messages(f.mate, channel))[0]).toMatchObject({
      body: '',
      version: 2,
      reactions: [],
      reply_count: 1,
    });
    expect((await f.messages(f.mate, channel, root))[0]?.id).toBe(reply);
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/messages/${root}`, { body: 'Restore', version: 2 }))
        .statusCode,
    ).toBe(410);
    expect(
      (await f.call(f.mate, 'PUT', `/v1/messages/${root}/reactions`, { emoji: '👍' })).statusCode,
    ).toBe(410);
    expect((await f.call(f.mate, 'GET', '/v1/search?q=deletionquartz')).json()).toEqual([]);
    const own = (await f.send(f.owner, channel, 'Author content')).json().id;
    expect((await f.call(f.mate, 'DELETE', `/v1/messages/${own}`, { version: 1 })).statusCode).toBe(
      403,
    );
    expect(
      (await f.call(f.other, 'DELETE', `/v1/messages/${own}`, { version: 1 })).statusCode,
    ).toBe(404);
  });
  it('checks private channel access for every mutation and receipt', async () => {
    const channel = await f.channel('private'),
      message = (await f.send(f.owner, channel, 'Private')).json().id;
    for (const [method, url, payload] of [
      ['PATCH', `/v1/messages/${message}`, { body: 'forged', version: 1 }],
      ['DELETE', `/v1/messages/${message}`, { version: 1 }],
      ['PUT', `/v1/messages/${message}/reactions`, { emoji: '👍' }],
      ['PUT', `/v1/conversations/${channel}/read`, { messageId: message }],
    ] as const)
      expect((await f.call(f.mate, method, url, payload)).statusCode).toBe(404);
    await f.db.query(
      'DELETE FROM conversation_members WHERE conversation_id=$1 AND membership_id=$2',
      [channel, f.ownerBoot.me.id],
    );
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/messages/${message}`, { version: 1 })).statusCode,
    ).toBe(404);
  });
});
describe('reactions and read positions', () => {
  it('aggregates reactions, binds removal to the caller and deduplicates concurrent retries', async () => {
    const channel = await f.channel(),
      message = (await f.send(f.owner, channel, 'React')).json().id;
    const path = `/v1/messages/${message}/reactions`;
    await Promise.all([
      f.call(f.owner, 'PUT', path, { emoji: '👍' }),
      f.call(f.owner, 'PUT', path, { emoji: '👍' }),
    ]);
    await f.call(f.mate, 'PUT', path, { emoji: '👍' });
    expect((await f.messages(f.mate, channel))[0]?.reactions).toEqual([
      { emoji: '👍', count: 2, reacted: true },
    ]);
    await f.call(f.mate, 'DELETE', path, { emoji: '👍' });
    await f.call(f.mate, 'DELETE', path, { emoji: '👍' });
    expect((await f.messages(f.mate, channel))[0]?.reactions).toEqual([
      { emoji: '👍', count: 1, reacted: false },
    ]);
    expect((await f.call(f.owner, 'PUT', path, { emoji: '<script>' })).statusCode).toBe(400);
    expect(
      await f.db.query(
        "SELECT id FROM outbox_events WHERE resource_id=$1 AND event_type='message.reaction_changed'",
        [message],
      ),
    ).toHaveLength(3);
  });
  it('advances monotonically, tracks threads separately, and persists unread counts', async () => {
    const channel = await f.channel(),
      root = (await f.send(f.owner, channel, 'First root')).json().id;
    const second = (await f.send(f.owner, channel, 'Second root')).json().id;
    const reply = (await f.send(f.owner, channel, 'Thread reply', root)).json().id;
    const unread = async () =>
      (await f.boot(f.mate)).channels.find((c) => c.id === channel)!.unread_count;
    expect(await unread()).toBe(3);
    await f.call(f.mate, 'PUT', `/v1/conversations/${channel}/read`, { messageId: second });
    expect(await unread()).toBe(1);
    let timeline = await f.messages(f.owner, channel);
    expect(timeline.every((m) => m.read_count === 1)).toBe(true);
    expect(timeline[0]?.read_by).toEqual([{ membership_id: f.mateBoot.me.id, name: 'Teammate' }]);
    expect((await f.messages(f.owner, channel, root))[0]?.read_count).toBe(0);
    await f.call(f.mate, 'PUT', `/v1/conversations/${channel}/read`, { messageId: reply });
    expect(await unread()).toBe(0);
    expect((await f.messages(f.owner, channel, root))[0]?.read_count).toBe(1);
    await f.call(f.mate, 'PUT', `/v1/conversations/${channel}/read`, { messageId: root });
    timeline = await f.messages(f.owner, channel);
    expect(timeline[0]?.read_count).toBe(1);
    const markers = await f.db.query(
      'SELECT last_sequence FROM conversation_reads WHERE conversation_id=$1 ORDER BY last_sequence',
      [channel],
    );
    expect(markers.map((m) => m.last_sequence)).toEqual([2, 3]);
    expect(
      await f.db.query(
        "SELECT id FROM outbox_events WHERE conversation_id=$1 AND event_type='conversation.read'",
        [channel],
      ),
    ).toHaveLength(2);
    const otherChannel = await f.channel();
    expect(
      (await f.call(f.mate, 'PUT', `/v1/conversations/${otherChannel}/read`, { messageId: root }))
        .statusCode,
    ).toBe(404);
  });
  it('enforces tenant boundaries and composite references on the new tables', async () => {
    const scoped = scopedDatabase(f.db);
    for (const table of ['message_reactions', 'conversation_reads', 'realtime_heads'])
      expect(await scoped.query(`SELECT * FROM ${table}`)).toEqual([]);
    const channel = await f.channel(),
      message = (await f.send(f.owner, channel, 'Tenant boundary')).json().id;
    await expect(
      tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query(
          'INSERT INTO message_reactions(workspace_id,conversation_id,message_id,membership_id,emoji) VALUES($1,$2,$3,$4,$5)',
          [f.otherBoot.workspace.id, channel, message, f.otherBoot.me.id, '👍'],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query('INSERT INTO realtime_heads(workspace_id) VALUES($1)', [
          f.ownerBoot.workspace.id,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
