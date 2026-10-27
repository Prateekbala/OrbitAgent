import { testEmail, verifyFixtureAccount } from './email.js';
import { testDatabase } from './database.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate, type Database } from '@ao/database';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
let db: Database, app: FastifyInstance;
async function signup(email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      name: email.split('@')[0],
      email,
      password: 'a-secure-test-password',
      workspace: 'Test Workspace',
    },
  });
  expect(response.statusCode).toBe(201);
  await verifyFixtureAccount(db, email);
  return response.cookies[0]!.value;
}
const headers = (session: string) => ({ cookie: `ao_session=${session}` });
async function boot(session: string) {
  return (await app.inject({ url: '/v1/bootstrap', headers: headers(session) })).json();
}
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
  app = await buildApp(db, { email: testEmail() });
}, 30000);
afterAll(async () => {
  await app.close();
  await db.close();
});
describe('platform invariants', () => {
  it('requires authentication and rejects cross-origin mutations', async () => {
    expect((await app.inject('/v1/bootstrap')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/signout',
          headers: { origin: 'https://evil.example' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it('persists messages and outbox atomically, deduplicates retries, and protects tenants', async () => {
    const a = await signup('alice@example.test'),
      b = await signup('bob@example.test');
    const ws = await boot(a),
      other = await boot(b),
      channel = ws.channels[0].id;
    const payload = { body: 'A durable release decision', clientId: randomUUID() };
    const write = () =>
      app.inject({
        method: 'POST',
        url: `/v1/conversations/${channel}/messages`,
        headers: headers(a),
        payload,
      });
    const first = await write();
    expect(first.statusCode).toBe(201);
    const second = await write();
    expect(second.statusCode).toBe(200);
    expect(first.json().id).toBe(second.json().id);
    expect(
      (await db.query('SELECT * FROM outbox_events WHERE resource_id=$1', [first.json().id]))
        .length,
    ).toBe(1);
    expect(
      (await app.inject({ url: `/v1/conversations/${channel}/messages`, headers: headers(b) }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/v1/conversations/${other.channels[0].id}/messages`,
          headers: headers(a),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/conversations/${channel}/messages`,
          headers: headers(a),
          payload: { ...payload, body: 'changed' },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('isolates private channels, search results, knowledge, and event replay', async () => {
    const session = await signup('private@example.test');
    const result = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: headers(session),
      payload: { name: 'leadership', visibility: 'private' },
    });
    const channel = result.json().id;
    await app.inject({
      method: 'POST',
      url: `/v1/conversations/${channel}/messages`,
      headers: headers(session),
      payload: { body: 'confidentialquartz', clientId: randomUUID() },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/knowledge',
      headers: headers(session),
      payload: { title: 'Private decision', body: 'confidentialquartz', conversationId: channel },
    });
    const agent = (
      await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: headers(session),
        payload: { name: 'Atlas', role: 'Research assistant' },
      })
    ).json();
    const agentHeaders = { authorization: `Bearer ${agent.key}` };
    expect(
      (await app.inject({ url: `/v1/conversations/${channel}/messages`, headers: agentHeaders }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/v1/search?q=confidentialquartz', headers: agentHeaders })).json(),
    ).toEqual([]);
    expect((await app.inject({ url: '/v1/knowledge', headers: agentHeaders })).json()).toEqual([]);
    const events = (await app.inject({ url: '/v1/events', headers: agentHeaders })).json();
    expect(
      events.events.some((e: { conversation_id: string }) => e.conversation_id === channel),
    ).toBe(false);
    expect(
      (
        await app.inject({ url: '/v1/search?q=confidentialquartz', headers: headers(session) })
      ).json(),
    ).toHaveLength(1);
  });
  it('validates task transitions and rejects stale versions and missing completion evidence', async () => {
    const session = await signup('tasks@example.test'),
      ws = await boot(session);
    const task = (
      await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: headers(session),
        payload: { title: 'Review release', assigneeId: ws.me.id },
      })
    ).json();
    const move = (state: string, version: number, evidence = '') =>
      app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/transitions`,
        headers: headers(session),
        payload: { state, version, evidence },
      });
    expect((await move('completed', 1, 'claim')).statusCode).toBe(409);
    expect((await move('queued', 1)).statusCode).toBe(200);
    expect((await move('active', 1)).statusCode).toBe(409);
    expect((await move('active', 2)).statusCode).toBe(200);
    expect((await move('awaiting_review', 3)).statusCode).toBe(200);
    expect((await move('completed', 4)).statusCode).toBe(400);
    expect((await move('completed', 4, 'Release checks verified')).statusCode).toBe(200);
  });
  it('routes explicit mentions to an external agent and revokes paused credentials', async () => {
    const session = await signup('agents@example.test'),
      ws = await boot(session);
    const agent = (
      await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: headers(session),
        payload: { name: 'Scout', role: 'Investigate requests' },
      })
    ).json();
    const credential = { authorization: `Bearer ${agent.key}` };
    await app.inject({
      method: 'POST',
      url: `/v1/conversations/${ws.channels[0].id}/messages`,
      headers: headers(session),
      payload: {
        body: `[@Scout](mention:${(await boot(session)).members.find((m: { name: string }) => m.name === 'Scout').id}) investigate the release`,
        format: 'markdown',
        clientId: randomUUID(),
      },
    });
    const inbox = (await app.inject({ url: '/v1/agent/inbox', headers: credential })).json();
    expect(inbox).toHaveLength(1);
    const lease = await app.inject({
      method: 'POST',
      url: `/v1/agent/inbox/${inbox[0].id}/lease`,
      headers: credential,
      payload: { leaseSeconds: 120 },
    });
    expect(lease.statusCode).toBe(200);
    const completed = await app.inject({
      method: 'POST',
      url: `/v1/agent/inbox/${inbox[0].id}/result`,
      headers: credential,
      payload: {
        leaseToken: lease.json().lease_token,
        fence: lease.json().fence,
        outcome: 'completed',
        summary: 'Receiver persisted the completed investigation.',
      },
    });
    expect(completed.statusCode).toBe(200);
    await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${agent.id}`,
      headers: headers(session),
      payload: { status: 'paused' },
    });
    expect((await app.inject({ url: '/v1/agent/inbox', headers: credential })).statusCode).toBe(
      401,
    );
  });
  it('rejects invalid payloads', async () => {
    const rows = await db.query('SELECT token_hash FROM sessions LIMIT 1');
    expect(rows.length).toBe(1);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      remoteAddress: '127.0.0.2',
      payload: { email: 'bad', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('transaction and reference integrity', () => {
  it('rejects a task assignee from another workspace', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/signin',
      payload: { email: 'alice@example.test', password: 'a-secure-test-password' },
    });
    const session = login.cookies[0]!.value;
    const [other] = await db.query(
      "SELECT m.id FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE a.email='bob@example.test'",
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: headers(session),
      payload: { title: 'Cross-tenant assignment', assigneeId: other!.id },
    });
    expect(response.statusCode).toBe(400);
    expect(await db.query("SELECT id FROM tasks WHERE title='Cross-tenant assignment'")).toEqual(
      [],
    );
  });
  it('rolls back domain and event writes together', async () => {
    const [workspace] = await db.query('SELECT id FROM workspaces LIMIT 1');
    const resourceId = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO outbox_events(workspace_id,event_type,resource_id) VALUES($1,'rollback.test',$2)",
          [workspace!.id, resourceId],
        );
        throw new Error('simulated transaction interruption');
      }),
    ).rejects.toThrow('simulated transaction interruption');
    expect(
      await db.query('SELECT id FROM outbox_events WHERE resource_id=$1', [resourceId]),
    ).toEqual([]);
  });
  it('applies versioned migrations idempotently', async () => {
    await migrate(db);
    expect(
      (await db.query('SELECT version FROM schema_migrations ORDER BY version')).map(
        (row) => row.version,
      ),
    ).toEqual(Array.from({ length: 77 }, (_, index) => index + 1));
  });
});
