import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scopedDatabase, tenantScope } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { buildApp } from '../src/app.js';
import { digest } from '../src/lib/security.js';
import { ActivityCleanupWorker } from '../src/activity/worker.js';
import type { ActivitySnapshot } from '@ao/contracts';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
}, 30000);
beforeEach(async () => {
  await f.db.query('DELETE FROM activity_sessions');
  await f.db.query('DELETE FROM activity_preferences');
});
afterAll(async () => f.close());
const heartbeat = (session: string, client: string, revision = 1, state = 'active') =>
  f.call(session, 'PUT', '/v1/presence', { clientId: client, revision, state });
async function snapshot(session = f.owner) {
  const response = await f.call(session, 'GET', '/v1/activity');
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ActivitySnapshot>();
}
async function type(
  session: string,
  client: string,
  channel: string,
  revision: number,
  active = true,
  threadId?: string,
) {
  return f.call(session, 'PUT', `/v1/conversations/${channel}/typing`, {
    clientId: client,
    revision,
    active,
    ...(threadId ? { threadId } : {}),
  });
}
describe('session-bound presence and typing', () => {
  it('aggregates browser tabs, rejects stale heartbeats, and expires disconnected clients', async () => {
    const a = randomUUID(),
      b = randomUUID();
    expect((await heartbeat(f.mate, a)).statusCode).toBe(200);
    expect((await heartbeat(f.mate, b, 1, 'away')).statusCode).toBe(200);
    expect((await snapshot()).presence).toEqual([
      { membership_id: f.mateBoot.me.id, state: 'online' },
    ]);
    await heartbeat(f.mate, a, 3, 'away');
    await heartbeat(f.mate, a, 2, 'active');
    expect((await snapshot()).presence).toEqual([
      { membership_id: f.mateBoot.me.id, state: 'away' },
    ]);
    expect((await f.call(f.mate, 'DELETE', '/v1/presence', { clientId: a })).statusCode).toBe(200);
    expect((await snapshot()).presence[0]!.state).toBe('away');
    await f.db.query("UPDATE activity_sessions SET expires_at=now()-interval '1 second'");
    expect((await snapshot()).presence).toEqual([]);
    await new ActivityCleanupWorker(f.db).tick();
    expect(await f.db.query('SELECT * FROM activity_sessions')).toEqual([]);
  });
  it('supports manual away and invisible modes without exposing activity timestamps or drafts', async () => {
    const client = randomUUID(),
      channel = await f.channel();
    await heartbeat(f.mate, client);
    expect((await type(f.mate, client, channel, 1)).statusCode).toBe(200);
    expect((await snapshot()).typing).toHaveLength(1);
    await f.call(f.mate, 'PUT', '/v1/presence/preferences', { mode: 'away' });
    expect((await snapshot()).presence[0]!.state).toBe('away');
    expect((await snapshot()).typing).toEqual([]);
    await f.call(f.mate, 'PUT', '/v1/presence/preferences', { mode: 'invisible' });
    await type(f.mate, client, channel, 2);
    expect((await snapshot()).presence).toEqual([]);
    expect((await snapshot()).typing).toEqual([]);
    expect((await snapshot(f.mate)).own_mode).toBe('invisible');
    await f.call(f.mate, 'PUT', '/v1/presence/preferences', { mode: 'automatic' });
    expect((await snapshot()).presence[0]!.state).toBe('online');
    const data = JSON.stringify(await snapshot());
    expect(data).not.toContain('session_hash');
    expect(data).not.toContain('last_seen');
    expect(data).not.toContain('expires_at');
    expect(
      (
        await f.call(f.mate, 'PUT', `/v1/conversations/${channel}/typing`, {
          clientId: client,
          revision: 3,
          active: true,
          draft: 'Never transmit draft text',
        })
      ).statusCode,
    ).toBe(400);
  });
  it('separates timelines and threads, deduplicates clients, and handles out-of-order stops', async () => {
    const client = randomUUID(),
      other = randomUUID(),
      channel = await f.channel();
    const root = (await f.send(f.owner, channel, 'Thread root')).json().id;
    await heartbeat(f.mate, client);
    await heartbeat(f.mate, other);
    expect((await type(f.mate, client, channel, 1, true, root)).statusCode).toBe(200);
    await type(f.mate, other, channel, 1, true, root);
    expect((await snapshot()).typing).toHaveLength(1);
    expect((await snapshot()).typing[0]).toMatchObject({
      conversation_id: channel,
      thread_id: root,
      membership_id: f.mateBoot.me.id,
    });
    await type(f.mate, client, channel, 3, false, root);
    await type(f.mate, client, channel, 2, true, root);
    await type(f.mate, other, channel, 2, false, root);
    expect((await snapshot()).typing).toEqual([]);
    await type(f.mate, client, channel, 4, true, root);
    await type(f.mate, client, channel, 5, false);
    expect((await snapshot()).typing[0]!.thread_id).toBe(root);
    await f.db.query(
      "UPDATE activity_sessions SET typing_expires_at=now()-interval '1 second' WHERE typing_conversation_id IS NOT NULL",
    );
    expect((await snapshot()).typing).toEqual([]);
    await type(f.mate, client, channel, 6, true);
    expect((await snapshot()).typing[0]!.thread_id).toBeNull();
    await heartbeat(f.mate, client, 2, 'away');
    expect((await snapshot()).typing).toEqual([]);
    const reply = (await f.send(f.owner, channel, 'Nested reference', root)).json().id;
    expect((await type(f.mate, client, channel, 7, true, reply)).statusCode).toBe(404);
    expect((await type(f.mate, client, channel, 8, true, randomUUID())).statusCode).toBe(404);
  });
  it('checks current private audiences for both typist and viewer after revocation', async () => {
    const privateChannel = await f.channel('private'),
      client = randomUUID();
    await heartbeat(f.mate, client);
    expect((await type(f.mate, client, privateChannel, 1)).statusCode).toBe(404);
    const group = (
      await f.call(f.owner, 'POST', '/v1/conversations/groups', {
        title: 'Typing audience',
        membershipIds: [f.mateBoot.me.id],
      })
    ).json().id;
    expect((await type(f.mate, client, group, 2)).statusCode).toBe(200);
    expect((await snapshot()).typing.some((item) => item.conversation_id === group)).toBe(true);
    expect((await snapshot(f.other)).typing).toEqual([]);
    expect((await snapshot(f.other)).presence).toEqual([]);
    await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
      version: 1,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    expect((await snapshot()).typing.some((item) => item.conversation_id === group)).toBe(false);
    expect((await type(f.mate, client, group, 3)).statusCode).toBe(404);
  });
  it('binds clients to the actual browser session and removes leases when that session is revoked', async () => {
    const client = randomUUID();
    await heartbeat(f.mate, client);
    const [account] = await f.db.query(
      'SELECT a.email FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.id=$1',
      [f.mateBoot.me.id],
    );
    const signin = await f.call('', 'POST', '/v1/auth/signin', {
      email: account!.email,
      password: 'messaging-test-password',
    });
    expect(signin.statusCode).toBe(200);
    const second = signin.cookies[0]!.value;
    await f.call(second, 'DELETE', '/v1/presence', { clientId: client });
    expect((await snapshot()).presence).toHaveLength(1);
    await heartbeat(second, client);
    expect((await snapshot()).presence).toHaveLength(1);
    await f.call(second, 'POST', '/v1/auth/signout', {});
    expect((await snapshot()).presence).toHaveLength(1);
    await f.db.query('DELETE FROM sessions WHERE token_hash=$1', [digest(f.mate)]);
    expect((await snapshot()).presence).toEqual([]);
    expect(await f.db.query('SELECT * FROM activity_sessions')).toEqual([]);
    await f.db.query(
      "INSERT INTO sessions(token_hash,account_id,membership_id,workspace_id,auth_version,expires_at) SELECT $1,m.account_id,m.id,m.workspace_id,a.auth_version,now()+interval '1 day' FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.id=$2",
      [digest(f.mate), f.mateBoot.me.id],
    );
  });
  it('shares leases across API instances and enforces tenant/session and admission boundaries', async () => {
    const second = await buildApp(f.db);
    try {
      const client = randomUUID();
      await heartbeat(f.mate, client);
      const result = await second.inject({
        url: '/v1/activity',
        headers: { cookie: `ao_session=${f.owner}` },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json<ActivitySnapshot>().presence[0]!.membership_id).toBe(f.mateBoot.me.id);
      const scoped = scopedDatabase(f.db);
      expect(
        await tenantScope(f.otherBoot.workspace.id, () =>
          scoped.query('SELECT * FROM activity_sessions WHERE workspace_id=$1', [
            f.ownerBoot.workspace.id,
          ]),
        ),
      ).toEqual([]);
      await expect(
        tenantScope(f.otherBoot.workspace.id, () =>
          scoped.query(
            "INSERT INTO activity_sessions(workspace_id,membership_id,session_hash,client_id,state,revision,expires_at) VALUES($1,$2,$3,$4,'active',1,now()+interval '1 minute')",
            [f.otherBoot.workspace.id, f.otherBoot.me.id, digest(f.owner), randomUUID()],
          ),
        ),
      ).rejects.toThrow(/foreign key/);
      for (let index = 1; index < 32; index++)
        expect((await heartbeat(f.mate, randomUUID())).statusCode).toBe(200);
      expect((await heartbeat(f.mate, randomUUID())).json().error.code).toBe(
        'PRESENCE_CLIENT_LIMIT',
      );
      expect((await heartbeat(f.mate, client, 2)).statusCode).toBe(200);
      expect((await heartbeat(f.mate, client, 0)).statusCode).toBe(400);
    } finally {
      await second.close();
    }
  });
  it('keeps ephemeral activity outside the durable event and audit logs', async () => {
    const client = randomUUID(),
      channel = await f.channel();
    const before = (await f.db.query('SELECT count(*)::int count FROM outbox_events'))[0]!.count;
    await heartbeat(f.mate, client);
    await type(f.mate, client, channel, 1);
    await type(f.mate, client, channel, 2, false);
    expect((await f.db.query('SELECT count(*)::int count FROM outbox_events'))[0]!.count).toBe(
      before,
    );
    expect(
      await f.db.query(
        "SELECT id FROM audit_events WHERE action LIKE 'typing.%' OR action LIKE 'presence.%'",
      ),
    ).toEqual([]);
    expect((await f.call('', 'GET', '/v1/activity')).statusCode).toBe(401);
    const agent = (
      await f.call(f.owner, 'POST', '/v1/agents', {
        name: 'Presence Agent',
        role: 'Test actor restrictions',
        runtime: 'external',
      })
    ).json();
    expect(
      (
        await f.app.inject({
          url: '/v1/activity',
          headers: { authorization: `Bearer ${agent.key}` },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('serializes stale heartbeat revisions alongside message and typing writes without lock inversions', async () => {
    const client = randomUUID(),
      channel = await f.channel();
    await heartbeat(f.mate, client);
    for (let revision = 2; revision < 10; revision += 2) {
      const responses = await Promise.all([
        heartbeat(f.mate, client, revision, 'away'),
        heartbeat(f.mate, client, revision + 1, 'active'),
        f.send(f.mate, channel, 'Concurrent interaction ' + revision),
        type(f.mate, client, channel, revision),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 201, 200]);
    }
    expect((await snapshot()).presence).toEqual([
      { membership_id: f.mateBoot.me.id, state: 'online' },
    ]);
  });
});
