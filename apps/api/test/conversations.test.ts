import { enqueueRun } from '../src/execution/runs.js';
import { ExecutionWorker } from '../src/execution/worker.js';
import { ToolGateway } from '../src/execution/gateway.js';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scopedDatabase, tenantScope } from '@ao/database';
import { EventFeed } from '../src/messaging/events.js';
import { messagingFixture } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
}, 30000);
afterAll(async () => {
  await f.close();
});
async function group(session = f.owner) {
  const response = await f.call(session, 'POST', '/v1/conversations/groups', {
    title: 'Private plans',
    membershipIds: [session === f.owner ? f.mateBoot.me.id : f.ownerBoot.me.id],
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}
async function change(
  id: string,
  version: number,
  membershipId: string,
  action: string,
  session = f.owner,
) {
  return f.call(session, 'PATCH', `/v1/conversations/${id}`, {
    version,
    member: { membershipId, action },
  });
}
describe('direct and group conversations', () => {
  it('reuses a direct conversation for concurrent requests in either direction', async () => {
    const results = await Promise.all([
      f.call(f.owner, 'POST', '/v1/conversations/direct', {
        membershipId: f.mateBoot.me.id.toUpperCase(),
      }),
      f.call(f.mate, 'POST', '/v1/conversations/direct', { membershipId: f.ownerBoot.me.id }),
      f.call(f.owner, 'POST', '/v1/conversations/direct', { membershipId: f.mateBoot.me.id }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    const id = results[0]!.json().id;
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect((await f.boot(f.owner)).channels.find((c) => c.id === id)).toMatchObject({
      kind: 'direct',
      name: 'Teammate',
      visibility: 'private',
    });
    expect((await f.boot(f.mate)).channels.find((c) => c.id === id)?.name).toBe('Owner');
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/conversations/${id}/members`, {
          membershipId: f.mateBoot.me.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/conversations/${id}`, {
          version: 1,
          title: 'Mutable pair',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/conversations/direct', {
          membershipId: f.ownerBoot.me.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/conversations/direct', {
          membershipId: f.otherBoot.me.id,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('grants group authority independently of workspace administrator privileges and guards versions', async () => {
    const id = await group(f.mate);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/conversations/${id}`, { version: 1, title: 'Override' }))
        .statusCode,
    ).toBe(403);
    const renamed = await f.call(f.mate, 'PATCH', `/v1/conversations/${id}`, {
      version: 1,
      title: 'Team decisions',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await change(id, 1, f.ownerBoot.me.id, 'promote', f.mate)).statusCode).toBe(409);
    expect((await change(id, 2, f.mateBoot.me.id, 'remove', f.mate)).json().error.code).toBe(
      'LAST_GROUP_OWNER',
    );
    expect((await change(id, 2, f.ownerBoot.me.id, 'promote', f.mate)).statusCode).toBe(200);
    expect((await change(id, 3, f.mateBoot.me.id, 'remove', f.mate)).statusCode).toBe(200);
    expect((await f.call(f.mate, 'GET', `/v1/conversations/${id}`)).statusCode).toBe(404);
  });
  it('revokes history, search, writes and receipts, sends a targeted invalidation, and allows deliberate rejoining', async () => {
    const id = await group();
    const message = (await f.send(f.mate, id, 'privatezircon secret')).json().id;
    const feed = new EventFeed(scopedDatabase(f.db));
    const ownerIdentity = {
      workspaceId: f.ownerBoot.workspace.id,
      membershipId: f.ownerBoot.me.id,
      name: 'Owner',
      role: 'owner' as const,
      kind: 'human' as const,
    };
    const mateIdentity = {
      ...ownerIdentity,
      membershipId: f.mateBoot.me.id,
      name: 'Teammate',
      role: 'member' as const,
    };
    const before = await tenantScope(ownerIdentity.workspaceId, () =>
      feed.page(ownerIdentity, '0'),
    );
    expect((await change(id, 1, f.mateBoot.me.id, 'remove')).statusCode).toBe(200);
    expect((await f.boot(f.mate)).channels.some((c) => c.id === id)).toBe(false);
    for (const [method, url, payload] of [
      ['GET', `/v1/conversations/${id}/messages`, undefined],
      ['GET', `/v1/conversations/${id}`, undefined],
      ['POST', `/v1/conversations/${id}/messages`, { body: 'Denied', clientId: randomUUID() }],
      ['PATCH', `/v1/messages/${message}`, { body: 'Denied', version: 1 }],
      ['PUT', `/v1/messages/${message}/reactions`, { emoji: '👍' }],
      ['PUT', `/v1/conversations/${id}/read`, { messageId: message }],
    ] as const)
      expect((await f.call(f.mate, method, url, payload)).statusCode).toBe(404);
    expect((await f.call(f.mate, 'GET', '/v1/search?q=privatezircon')).json()).toEqual([]);
    const removed = await tenantScope(ownerIdentity.workspaceId, () =>
      new EventFeed(scopedDatabase(f.db)).page(mateIdentity, before.cursor),
    );
    expect(removed.events.filter((e) => e.event_type === 'conversation.access_revoked')).toEqual([
      expect.objectContaining({ resource_id: id, conversation_id: null }),
    ]);
    const owner = await tenantScope(ownerIdentity.workspaceId, () =>
      new EventFeed(scopedDatabase(f.db)).page(ownerIdentity, before.cursor),
    );
    expect(owner.events.some((e) => e.event_type === 'conversation.access_revoked')).toBe(false);
    expect((await change(id, 2, f.mateBoot.me.id, 'add')).statusCode).toBe(200);
    expect(await f.messages(f.mate, id)).toEqual([]);
    expect((await f.call(f.mate, 'GET', `/v1/messages/${message}/context`)).statusCode).toBe(404);
  });
  it('hides groups from uninvited workspace owners and cross-tenant members', async () => {
    const response = await f.call(f.owner, 'POST', '/v1/agents', {
      name: 'Private Helper',
      role: 'Help with discussions',
      runtime: 'external',
    });
    expect(response.statusCode).toBe(201);
    const agent = (
      await f.db.query('SELECT membership_id FROM agents WHERE id=$1', [response.json().id])
    )[0]!.membership_id;
    const created = await f.call(f.mate, 'POST', '/v1/conversations/groups', {
      title: 'Only invited',
      membershipIds: [agent],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    for (const session of [f.owner, f.other]) {
      expect((await f.boot(session)).channels.some((c) => c.id === id)).toBe(false);
      expect((await f.call(session, 'GET', `/v1/conversations/${id}`)).statusCode).toBe(404);
      expect((await f.call(session, 'GET', `/v1/conversations/${id}/messages`)).statusCode).toBe(
        404,
      );
    }
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/conversations/${id}/members`, {
          membershipId: f.ownerBoot.me.id,
        })
      ).statusCode,
    ).toBe(404);
    const direct = await f.call(f.owner, 'POST', '/v1/conversations/direct', {
      membershipId: agent,
    });
    await f.send(f.owner, direct.json().id, 'Wake without a mention');
    expect(
      (await f.db.query('SELECT id FROM agent_inbox WHERE agent_id=$1', [response.json().id]))
        .length,
    ).toBe(1);
  });
  it('rejects invalid participants and preserves direct pair and private visibility constraints', async () => {
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/conversations/groups', {
          title: 'Bad',
          membershipIds: [f.otherBoot.me.id],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/conversations/groups', {
          title: 'Bad',
          membershipIds: [f.mateBoot.me.id, f.mateBoot.me.id],
        })
      ).statusCode,
    ).toBe(400);
    await expect(
      f.db.query(
        "INSERT INTO conversations(id,workspace_id,name,kind,visibility,title) VALUES($1,$2,$3,'group','public','Exposed')",
        [randomUUID(), f.ownerBoot.workspace.id, randomUUID()],
      ),
    ).rejects.toThrow(/check constraint/);
  });
  it('fences pending approvals when a group audience changes', async () => {
    const agent = (
      await f.call(f.owner, 'POST', '/v1/agents', {
        name: 'Group Planner',
        role: 'Propose a task',
        runtime: 'managed',
      })
    ).json();
    const [membership] = await f.db.query('SELECT membership_id FROM agents WHERE id=$1', [
      agent.id,
    ]);
    const created = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Execution audience',
      membershipIds: [f.mateBoot.me.id, membership!.membership_id],
    });
    const id = created.json().id,
      scoped = scopedDatabase(f.db);
    const p = {
      workspaceId: f.ownerBoot.workspace.id,
      membershipId: f.ownerBoot.me.id,
      name: 'Owner',
      role: 'owner' as const,
      kind: 'human' as const,
    };
    const run = await tenantScope(p.workspaceId, () =>
      scoped.transaction((tx) =>
        enqueueRun(tx, p, {
          agentId: agent.id,
          conversationId: id,
          prompt: 'Prepare a task',
          requestKey: randomUUID(),
        }),
      ),
    );
    const worker = new ExecutionWorker(f.db, {
      configured: true,
      createSession: async () => randomUUID(),
      cancel: async () => {},
      recover: async () => null,
      generate: async () => ({
        reply: 'A proposal for the group.',
        proposals: [
          {
            tool: 'create_task',
            parameters: {
              title: 'Review group plan',
              description: 'Review together',
              priority: 'normal',
            },
          },
        ],
      }),
    });
    await worker.tick();
    expect(
      (await f.db.query('SELECT status FROM agent_runs WHERE id=$1', [run.id]))[0]!.status,
    ).toBe('awaiting_approval');
    const [action] = await f.db.query('SELECT id FROM tool_invocations WHERE run_id=$1', [run.id]);
    expect((await change(id, 1, f.mateBoot.me.id, 'remove')).statusCode).toBe(200);
    expect(
      (await f.db.query('SELECT status FROM agent_runs WHERE id=$1', [run.id]))[0]!.status,
    ).toBe('cancelled');
    expect(
      (await f.db.query('SELECT status FROM tool_invocations WHERE id=$1', [action!.id]))[0]!
        .status,
    ).toBe('cancelled');
    await tenantScope(p.workspaceId, () => new ToolGateway(scoped).execute(String(action!.id)));
    expect(await f.db.query("SELECT id FROM tasks WHERE title='Review group plan'")).toEqual([]);
  });
  it('serializes concurrent group changes and rejects demoting the only remaining owner', async () => {
    const id = await group();
    const results = await Promise.all([
      f.call(f.owner, 'PATCH', `/v1/conversations/${id}`, { version: 1, title: 'One update' }),
      f.call(f.owner, 'PATCH', `/v1/conversations/${id}`, { version: 1, title: 'Another update' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await change(id, 2, f.mateBoot.me.id, 'remove')).statusCode).toBe(200);
    expect((await change(id, 3, f.ownerBoot.me.id, 'demote')).json().error.code).toBe(
      'LAST_GROUP_OWNER',
    );
    expect((await change(id, 3, f.ownerBoot.me.id, 'remove')).statusCode).toBe(200);
    expect((await f.call(f.owner, 'GET', `/v1/conversations/${id}`)).statusCode).toBe(404);
  });
});
