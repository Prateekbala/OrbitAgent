import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scopedDatabase, tenantScope } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { enqueueRun } from '../src/execution/runs.js';
import { ExecutionWorker } from '../src/execution/worker.js';
import type { NotificationPage } from '@ao/contracts';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
}, 30000);
beforeEach(async () => {
  await f.db.query('DELETE FROM notifications');
  await f.db.query('DELETE FROM notification_preferences');
  await f.db.query('DELETE FROM conversation_notification_preferences');
});
afterAll(async () => f.close());
async function inbox(session = f.mate, query = '') {
  const response = await f.call(session, 'GET', '/v1/notifications' + query);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<NotificationPage>();
}
async function direct() {
  return (
    await f.call(f.owner, 'POST', '/v1/conversations/direct', { membershipId: f.mateBoot.me.id })
  ).json().id as string;
}
describe('private persistent notifications', () => {
  it('creates a single direct-message notification atomically, binds it to its recipient, and reads current content', async () => {
    const channel = await direct(),
      key = randomUUID();
    const sent = await f.send(f.owner, channel, 'A durable notification', undefined, key);
    expect(sent.statusCode, sent.body).toBe(201);
    expect(
      (await f.send(f.owner, channel, 'A durable notification', undefined, key)).statusCode,
    ).toBe(200);
    const page = await inbox();
    expect(page.unread_count).toBe(1);
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item).toMatchObject({
      kind: 'message',
      message_id: sent.json().id,
      actor_name: 'Owner',
      excerpt: 'A durable notification',
    });
    expect((await inbox(f.owner)).items).toEqual([]);
    expect((await inbox(f.other)).items).toEqual([]);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/notifications/${item.id}`, { read: true })).statusCode,
    ).toBe(404);
    expect(
      (await f.call(f.other, 'PATCH', `/v1/notifications/${item.id}`, { read: true })).statusCode,
    ).toBe(404);
    await f.call(f.owner, 'PATCH', `/v1/messages/${sent.json().id}`, {
      version: 1,
      body: 'Updated current text',
    });
    expect((await inbox()).items[0]!.excerpt).toBe('Updated current text');
    await f.call(f.owner, 'DELETE', `/v1/messages/${sent.json().id}`, { version: 2 });
    expect((await inbox()).unread_count).toBe(0);
    expect((await inbox()).items).toEqual([]);
    const stored = (await f.db.query('SELECT * FROM notifications WHERE id=$1', [item.id]))[0]!;
    expect(Object.keys(stored)).not.toContain('body');
  });
  it('resolves explicit mentions, rejects unauthorized targets, and does not notify on edits', async () => {
    const channel = await f.channel();
    const normal = await f.send(f.owner, channel, 'A channel announcement');
    expect(normal.statusCode).toBe(201);
    expect((await inbox()).items).toEqual([]);
    const payload = {
      body: 'Please review, @Teammate.',
      clientId: randomUUID(),
      mentionIds: [f.mateBoot.me.id],
    };
    const sent = await f.call(f.owner, 'POST', `/v1/conversations/${channel}/messages`, payload);
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await inbox()).items[0]).toMatchObject({ kind: 'mention', message_id: sent.json().id });
    expect(
      (await f.call(f.owner, 'POST', `/v1/conversations/${channel}/messages`, payload)).statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/conversations/${channel}/messages`, {
          ...payload,
          mentionIds: [],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/conversations/${channel}/messages`, {
          body: '@Other',
          clientId: randomUUID(),
          mentionIds: [f.otherBoot.me.id],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/conversations/${channel}/messages`, {
          body: 'No mention in body',
          clientId: randomUUID(),
          mentionIds: [f.mateBoot.me.id],
        })
      ).statusCode,
    ).toBe(400);
    const privateChannel = await f.channel('private');
    await f.send(f.owner, privateChannel, '@Teammate is not invited');
    expect((await inbox()).items).toHaveLength(1);
    await f.call(f.owner, 'PATCH', `/v1/messages/${normal.json().id}`, {
      body: 'Now mentioning @Teammate',
      version: 1,
    });
    expect((await inbox()).items).toHaveLength(1);
  });
  it('notifies thread participants once and acknowledges messages independently from thread replies', async () => {
    const channel = await f.channel(),
      root = (await f.send(f.owner, channel, 'Thread root')).json().id;
    const reply = (await f.send(f.mate, channel, 'A considered reply', root)).json().id;
    expect((await inbox(f.owner)).items[0]).toMatchObject({
      kind: 'reply',
      thread_id: root,
      message_id: reply,
    });
    const answer = (await f.send(f.owner, channel, 'Follow-up answer', root)).json().id;
    expect((await inbox()).items[0]).toMatchObject({ kind: 'reply', message_id: answer });
    await f.call(f.mate, 'PUT', `/v1/conversations/${channel}/read`, { messageId: root });
    expect((await inbox()).unread_count).toBe(1);
    await f.call(f.mate, 'PUT', `/v1/conversations/${channel}/read`, { messageId: answer });
    expect((await inbox()).unread_count).toBe(0);
  });
  it('deduplicates reactions and hides a notification once that actor removes every reaction', async () => {
    const channel = await f.channel(),
      message = (await f.send(f.owner, channel, 'React here')).json().id;
    for (const emoji of ['👍', '❤️', '👍'])
      expect(
        (await f.call(f.mate, 'PUT', `/v1/messages/${message}/reactions`, { emoji })).statusCode,
      ).toBe(200);
    expect((await inbox(f.owner)).items).toHaveLength(1);
    expect((await inbox(f.owner)).items[0]!.kind).toBe('reaction');
    await f.call(f.mate, 'DELETE', `/v1/messages/${message}/reactions`, { emoji: '👍' });
    expect((await inbox(f.owner)).unread_count).toBe(1);
    await f.call(f.mate, 'DELETE', `/v1/messages/${message}/reactions`, { emoji: '❤️' });
    expect((await inbox(f.owner)).items).toEqual([]);
  });
  it('applies global and per-conversation preferences to new notifications only', async () => {
    const channel = await f.channel();
    expect(
      (
        await f.call(f.mate, 'PUT', `/v1/conversations/${channel}/notification-preferences`, {
          mode: 'all',
        })
      ).statusCode,
    ).toBe(200);
    await f.send(f.owner, channel, 'Every message enabled');
    expect((await inbox()).unread_count).toBe(1);
    await f.call(f.mate, 'PUT', `/v1/conversations/${channel}/notification-preferences`, {
      mode: 'muted',
    });
    await f.send(f.owner, channel, '@Teammate a muted mention');
    expect((await inbox()).unread_count).toBe(1);
    await f.call(f.mate, 'PATCH', '/v1/notifications/preferences', { enabled: false });
    await f.send(f.owner, await direct(), 'No notification while disabled');
    expect((await inbox()).unread_count).toBe(1);
    expect(
      (
        await f.call(f.mate, 'PATCH', '/v1/notifications/preferences', {
          'enabled=false; DROP TABLE notifications': true,
        })
      ).statusCode,
    ).toBe(400);
    const pref = (await f.call(f.mate, 'GET', '/v1/notifications/preferences')).json();
    expect(pref.enabled).toBe(false);
    expect(pref.mentions).toBe(true);
    expect(
      (
        await f.call(f.other, 'PUT', `/v1/conversations/${channel}/notification-preferences`, {
          mode: 'all',
        })
      ).statusCode,
    ).toBe(404);
  });
  it('supports private cursor pagination, read/unread state and a bounded mark-all cutoff', async () => {
    const channel = await direct();
    for (let index = 0; index < 4; index++) await f.send(f.owner, channel, `Notice ${index}`);
    const first = await inbox(f.mate, '?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBe(first.items[1]!.id);
    const second = await inbox(f.mate, `?limit=2&before=${first.next_cursor}`);
    expect(second.items).toHaveLength(2);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    expect(
      (await f.call(f.other, 'GET', `/v1/notifications?before=${first.next_cursor}`)).statusCode,
    ).toBe(400);
    const newest = first.items[0]!;
    await f.call(f.mate, 'PATCH', `/v1/notifications/${newest.id}`, { read: true });
    expect((await inbox()).unread_count).toBe(3);
    await f.call(f.mate, 'PATCH', `/v1/notifications/${newest.id}`, { read: false });
    expect((await inbox()).unread_count).toBe(4);
    await f.send(f.owner, channel, 'Arrived after the displayed cutoff');
    expect(
      (await f.call(f.mate, 'POST', '/v1/notifications/read-all', { throughId: newest.id }))
        .statusCode,
    ).toBe(200);
    expect((await inbox()).unread_count).toBe(1);
    expect((await inbox(f.mate, '?unread=true')).items).toHaveLength(1);
    expect(
      (await f.call(f.other, 'POST', '/v1/notifications/read-all', { throughId: newest.id }))
        .statusCode,
    ).toBe(404);
  });
  it('rechecks group access for inbox rows, counts and preferences after removal', async () => {
    const group = (
      await f.call(f.owner, 'POST', '/v1/conversations/groups', {
        title: 'Notification audience',
        membershipIds: [f.mateBoot.me.id],
      })
    ).json().id;
    await f.send(f.owner, group, 'Private group discussion');
    expect((await inbox()).items).toHaveLength(2);
    const notification = (await inbox()).items[0]!;
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
          version: 1,
          member: { membershipId: f.mateBoot.me.id, action: 'remove' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await inbox()).items).toEqual([]);
    expect((await inbox()).unread_count).toBe(0);
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/notifications/${notification.id}`, { read: true }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
          version: 2,
          member: { membershipId: f.mateBoot.me.id, action: 'add' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await inbox()).items.some((item) => item.kind === 'group_added')).toBe(true);
  });
  it('notifies assignees and only authorized approvers, retaining tenant RLS', async () => {
    const task = await f.call(f.owner, 'POST', '/v1/tasks', {
      title: 'Review the brief',
      assigneeId: f.mateBoot.me.id,
    });
    expect(task.statusCode, task.body).toBe(201);
    expect((await inbox()).items[0]).toMatchObject({
      kind: 'task_assigned',
      resource_id: task.json().id,
      excerpt: 'Review the brief',
    });
    const agent = (
      await f.call(f.owner, 'POST', '/v1/agents', {
        name: 'Notification Planner',
        role: 'Suggest a task',
        runtime: 'managed',
      })
    ).json();
    const [agentMember] = await f.db.query('SELECT membership_id FROM agents WHERE id=$1', [
      agent.id,
    ]);
    const group = (
      await f.call(f.mate, 'POST', '/v1/conversations/groups', {
        title: 'Private approval',
        membershipIds: [agentMember!.membership_id],
      })
    ).json().id;
    const p = {
      workspaceId: f.mateBoot.workspace.id,
      membershipId: f.mateBoot.me.id,
      name: 'Teammate',
      kind: 'human' as const,
      role: 'member' as const,
    };
    const scoped = scopedDatabase(f.db);
    await tenantScope(p.workspaceId, () =>
      scoped.transaction((tx) =>
        enqueueRun(tx, p, {
          agentId: agent.id,
          conversationId: group,
          prompt: 'Propose work',
          requestKey: randomUUID(),
        }),
      ),
    );
    await new ExecutionWorker(f.db, {
      configured: true,
      createSession: async () => randomUUID(),
      generate: async () => ({
        reply: 'A private proposal',
        proposals: [
          {
            tool: 'create_task',
            parameters: {
              title: 'Only authorized people',
              description: 'Review',
              priority: 'normal',
            },
          },
        ],
      }),
      cancel: async () => {},
      recover: async () => null,
    }).tick();
    expect((await inbox(f.owner)).items.some((item) => item.kind === 'approval_request')).toBe(
      false,
    );
    expect((await inbox()).items.some((item) => item.kind === 'approval_request')).toBe(false);
    expect(
      await tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query('SELECT id FROM notifications WHERE workspace_id=$1', [p.workspaceId]),
      ),
    ).toEqual([]);
    const outbox = await f.db.query(
      "SELECT audience_membership_id,conversation_id FROM outbox_events WHERE event_type='notification.created'",
    );
    expect(outbox.every((row) => row.audience_membership_id && row.conversation_id === null)).toBe(
      true,
    );
  });
  it('delivers actionable approval requests and removes them when settled', async () => {
    const agent = (
      await f.call(f.owner, 'POST', '/v1/agents', {
        name: 'Authorized Notifier',
        role: 'Propose work',
        runtime: 'managed',
      })
    ).json();
    const channel = await f.channel();
    const p = {
      workspaceId: f.ownerBoot.workspace.id,
      membershipId: f.ownerBoot.me.id,
      name: 'Owner',
      kind: 'human' as const,
      role: 'owner' as const,
    };
    const scoped = scopedDatabase(f.db);
    await tenantScope(p.workspaceId, () =>
      scoped.transaction((tx) =>
        enqueueRun(tx, p, {
          agentId: agent.id,
          conversationId: channel,
          prompt: 'Propose a task',
          requestKey: randomUUID(),
        }),
      ),
    );
    await new ExecutionWorker(f.db, {
      configured: true,
      createSession: async () => randomUUID(),
      generate: async () => ({
        reply: 'Review this proposal',
        proposals: [
          {
            tool: 'create_task',
            parameters: {
              title: 'An actionable notification',
              description: 'Review',
              priority: 'normal',
            },
          },
        ],
      }),
      cancel: async () => {},
      recover: async () => null,
    }).tick();
    const notice = (await inbox(f.owner)).items.find((item) => item.kind === 'approval_request');
    expect(notice).toBeDefined();
    const [action] = await f.db.query('SELECT action_digest FROM tool_invocations WHERE id=$1', [
      notice!.resource_id,
    ]);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/approvals/${notice!.resource_id}/decisions`, {
          decision: 'rejected',
          digest: action!.action_digest,
        })
      ).statusCode,
    ).toBe(200);
    expect((await inbox(f.owner)).items.some((item) => item.id === notice!.id)).toBe(false);
  });

  it('keeps group addition deliveries distinct across conversations and later re-invitations', async () => {
    const groups: string[] = [];
    for (let index = 0; index < 2; index++) {
      const group = (
        await f.call(f.owner, 'POST', '/v1/conversations/groups', {
          title: 'Repeated additions ' + index,
          membershipIds: [f.mateBoot.me.id],
        })
      ).json().id;
      groups.push(group);
      await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
        version: 1,
        member: { membershipId: f.mateBoot.me.id, action: 'remove' },
      });
    }
    await f.db.query('DELETE FROM notifications');
    for (const group of groups)
      expect(
        (
          await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
            version: 2,
            member: { membershipId: f.mateBoot.me.id, action: 'add' },
          })
        ).statusCode,
      ).toBe(200);
    expect((await inbox()).items.filter((item) => item.kind === 'group_added')).toHaveLength(2);
    const cutoff = (await inbox()).items[0]!.id;
    await f.call(f.mate, 'POST', '/v1/notifications/read-all', { throughId: cutoff });
    const group = groups[0]!;
    await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
      version: 3,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
      version: 4,
      member: { membershipId: f.mateBoot.me.id, action: 'add' },
    });
    expect((await inbox()).unread_count).toBe(1);
    expect((await inbox()).items[0]!.id).not.toBe(cutoff);
  });
});
