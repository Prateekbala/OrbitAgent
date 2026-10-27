import { digest } from '../src/lib/security.js';
import { testEmail, verifyFixtureAccount } from './email.js';
import { testDatabase } from './database.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  migrate,
  scopedDatabase,
  tenantScope,
  identityScope,
  assertRuntimeConnection,
  database,
  type Database,
} from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { randomUUID } from 'node:crypto';
let db: Database,
  app: FastifyInstance,
  owner: string,
  outsider: string,
  workspaceId: string,
  otherWorkspaceId: string,
  ownerId: string;
const headers = (session: string) => ({ cookie: `ao_session=${session}` });
async function signup(email: string) {
  const result = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      name: email.split('@')[0],
      email,
      password: 'team-test-password-2026',
      workspace: 'Team ' + email,
    },
  });
  expect(result.statusCode).toBe(201);
  await verifyFixtureAccount(db, email);
  return result.cookies[0]!.value;
}
async function invite(email: string, role = 'member', session = owner) {
  const result = await app.inject({
    method: 'POST',
    url: '/v1/invitations',
    headers: headers(session),
    payload: { email, role },
  });
  expect(result.statusCode).toBe(201);
  return result.json() as { id: string; token: string };
}
let acceptanceAddress = 2;
async function accept(token: string, name = 'New Person') {
  const result = await app.inject({
    method: 'POST',
    url: '/v1/invitations/accept',
    remoteAddress: `127.0.1.${acceptanceAddress++}`,
    payload: { token, name, password: 'invited-test-password-2026' },
  });
  if (result.statusCode === 201) {
    const [account] = await db.query(
      'SELECT a.email FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE s.token_hash=$1',
      [digest(result.cookies[0]!.value)],
    );
    await verifyFixtureAccount(db, String(account!.email));
  }
  return result;
}
async function members() {
  return (await app.inject({ url: '/v1/members', headers: headers(owner) })).json<
    Array<{ id: string; name: string; role: string; version: number; status: string }>
  >();
}
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
  app = await buildApp(db, { email: testEmail() });
  owner = await signup('owner@team.test');
  outsider = await signup('outside@team.test');
  const first = (await app.inject({ url: '/v1/bootstrap', headers: headers(owner) })).json(),
    second = (await app.inject({ url: '/v1/bootstrap', headers: headers(outsider) })).json();
  workspaceId = first.workspace.id;
  ownerId = first.me.id;
  otherWorkspaceId = second.workspace.id;
}, 30000);
afterAll(async () => {
  await app.close();
  await db.close();
});
describe('team invitations and membership', () => {
  it('accepts a single-use hashed invitation and grants only its recorded role', async () => {
    const link = await invite('new@team.test');
    const [stored] = await db.query('SELECT token_hash FROM invitations WHERE id=$1', [link.id]);
    expect(stored?.token_hash).not.toBe(link.token);
    const preview = await app.inject({
      method: 'POST',
      url: '/v1/invitations/preview',
      payload: { token: link.token },
    });
    expect(preview.statusCode).toBe(200);
    const joined = await accept(link.token);
    expect(joined.statusCode).toBe(201);
    const boot = (
      await app.inject({ url: '/v1/bootstrap', headers: headers(joined.cookies[0]!.value) })
    ).json();
    expect(boot.workspace.id).toBe(workspaceId);
    expect(boot.me.role).toBe('member');
    expect((await accept(link.token)).statusCode).toBe(409);
  });
  it('requires administrators to invite and prevents ordinary members from escalating', async () => {
    const link = await invite('ordinary@team.test');
    const joined = await accept(link.token);
    const result = await app.inject({
      method: 'POST',
      url: '/v1/invitations',
      headers: headers(joined.cookies[0]!.value),
      payload: { email: 'unexpected@team.test', role: 'admin' },
    });
    expect(result.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/members/${ownerId}`,
          headers: headers(joined.cookies[0]!.value),
          payload: { role: 'member', version: 1 },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('rejects expired and revoked invitations', async () => {
    const expired = await invite('expired@team.test');
    await db.query("UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [
      expired.id,
    ]);
    expect((await accept(expired.token)).statusCode).toBe(410);
    const revoked = await invite('revoked@team.test');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/invitations/${revoked.id}/revoke`,
          headers: headers(owner),
        })
      ).statusCode,
    ).toBe(200);
    expect((await accept(revoked.token)).statusCode).toBe(410);
  });
  it('protects the last active owner and rejects stale member versions', async () => {
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/members/${ownerId}`,
          headers: headers(owner),
          payload: { role: 'member', version: 1 },
        })
      ).statusCode,
    ).toBe(409);
    const target = (await members()).find((m) => m.name === 'New Person')!;
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${target.id}`,
      headers: headers(owner),
      payload: { role: 'admin', version: target.version },
    });
    expect(first.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/members/${target.id}`,
          headers: headers(owner),
          payload: { role: 'member', version: target.version },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('revokes a suspended member session immediately and preserves attribution', async () => {
    const link = await invite('suspend@team.test'),
      joined = await accept(link.token, 'Suspended Person');
    const boot = (
      await app.inject({ url: '/v1/bootstrap', headers: headers(joined.cookies[0]!.value) })
    ).json();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/members/${boot.me.id}`,
          headers: headers(owner),
          payload: { status: 'suspended', version: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/v1/bootstrap', headers: headers(joined.cookies[0]!.value) }))
        .statusCode,
    ).toBe(401);
    expect((await members()).find((m) => m.id === boot.me.id)?.status).toBe('suspended');
  });
  it('does not expose or mutate another workspace members', async () => {
    const own = (await app.inject({ url: '/v1/members', headers: headers(outsider) })).json();
    expect(own.some((m: { id: string }) => m.id === ownerId)).toBe(false);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/members/${ownerId}`,
          headers: headers(outsider),
          payload: { status: 'suspended', version: 1 },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('binds invitations to the intended account and requires existing users to sign in', async () => {
    const link = await invite('outside@team.test');
    expect((await accept(link.token)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/invitations/accept',
          headers: headers(owner),
          payload: { token: link.token },
        })
      ).statusCode,
    ).toBe(403);
    await app.inject({
      method: 'POST',
      url: `/v1/invitations/${link.id}/revoke`,
      headers: headers(owner),
    });
  });
  it('serializes concurrent claims without creating duplicate people or sessions', async () => {
    const link = await invite('concurrent@team.test');
    const results = await Promise.all([
      accept(link.token, 'Concurrent Person'),
      accept(link.token, 'Concurrent Person'),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(
      await db.query(
        "SELECT id FROM memberships WHERE workspace_id=$1 AND name='Concurrent Person'",
        [workspaceId],
      ),
    ).toHaveLength(1);
  });
  it('limits administrators to ordinary members and rechecks inviter authority at acceptance', async () => {
    const link = await invite('admin@team.test', 'admin');
    const joined = await accept(link.token, 'Administrator');
    const session = joined.cookies[0]!.value;
    const admin = (await members()).find((m) => m.name === 'Administrator')!;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/invitations',
          headers: headers(session),
          payload: { email: 'forbidden-admin@team.test', role: 'admin' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/members/${ownerId}`,
          headers: headers(session),
          payload: { status: 'suspended', version: 1 },
        })
      ).statusCode,
    ).toBe(403);
    const pending = await invite('inviter-revoked@team.test', 'member', session);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/members/${admin.id}`,
          headers: headers(owner),
          payload: { role: 'member', version: admin.version },
        })
      ).statusCode,
    ).toBe(200);
    expect((await accept(pending.token)).json().error.code).toBe('INVITER_AUTHORITY_CHANGED');
  });
  it('restores a suspended person without restoring revoked sessions or accepting a replacement invite', async () => {
    const target = (await members()).find((m) => m.name === 'Suspended Person')!;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/invitations',
          headers: headers(owner),
          payload: { email: 'suspend@team.test' },
        })
      ).statusCode,
    ).toBe(409);
    const accountOnly = await app.inject({
      method: 'POST',
      url: '/v1/auth/signin',
      payload: { email: 'suspend@team.test', password: 'invited-test-password-2026' },
    });
    expect(accountOnly.statusCode).toBe(200);
    expect(
      (
        await app.inject({ url: '/v1/bootstrap', headers: headers(accountOnly.cookies[0]!.value) })
      ).json().error.code,
    ).toBe('WORKSPACE_REQUIRED');
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/members/${target.id}`,
          headers: headers(owner),
          payload: { status: 'active', version: target.version },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/signin',
          payload: { email: 'suspend@team.test', password: 'invited-test-password-2026' },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('joins and switches an existing account without lending access to unrelated workspaces', async () => {
    const link = await invite('outside@team.test');
    const joined = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: headers(outsider),
      payload: { token: link.token },
    });
    expect(joined.statusCode).toBe(201);
    const session = joined.cookies[0]!.value;
    const list = (await app.inject({ url: '/v1/workspaces', headers: headers(session) })).json();
    expect(list).toHaveLength(2);
    const destination = list.find(
      (m: { workspace_id: string }) => m.workspace_id === otherWorkspaceId,
    );
    const switched = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/switch',
      headers: headers(session),
      payload: { membershipId: destination.id },
    });
    expect(switched.statusCode).toBe(200);
    expect(
      (
        await app.inject({ url: '/v1/bootstrap', headers: headers(switched.cookies[0]!.value) })
      ).json().workspace.id,
    ).toBe(otherWorkspaceId);
    expect((await app.inject({ url: '/v1/bootstrap', headers: headers(session) })).statusCode).toBe(
      401,
    );
  });
});
describe('database row security', () => {
  it('enables and forces RLS on every workspace-bearing table', async () => {
    const rows = await db.query(
      "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped)",
    );
    expect(rows.length).toBeGreaterThan(15);
    for (const row of rows) {
      expect(row.relrowsecurity, String(row.relname)).toBe(true);
      expect(row.relforcerowsecurity, String(row.relname)).toBe(true);
    }
  });
  it('denies unscoped reads, writes, and private identity-store access', async () => {
    const scoped = scopedDatabase(db);
    expect(await scoped.query('SELECT * FROM messages')).toEqual([]);
    expect(await scoped.query('SELECT * FROM workspaces')).toEqual([]);
    await expect(
      scoped.query(
        "INSERT INTO conversations(id,workspace_id,name,visibility) VALUES($1,$2,'unscoped','public')",
        [randomUUID(), workspaceId],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(scoped.query('SELECT * FROM accounts')).rejects.toThrow(/permission denied/);
  });
  it('filters unqualified SQL by transaction-local tenant and rejects cross-tenant writes', async () => {
    const scoped = scopedDatabase(db);
    const [first, second] = await Promise.all([
      tenantScope(workspaceId, () =>
        scoped.query('SELECT DISTINCT workspace_id FROM conversations'),
      ),
      tenantScope(otherWorkspaceId, () =>
        scoped.query('SELECT DISTINCT workspace_id FROM conversations'),
      ),
    ]);
    expect(first.map((r) => r.workspace_id)).toEqual([workspaceId]);
    expect(second.map((r) => r.workspace_id)).toEqual([otherWorkspaceId]);
    await expect(
      tenantScope(workspaceId, () =>
        scoped.query(
          "INSERT INTO conversations(id,workspace_id,name,visibility) VALUES($1,$2,'foreign','public')",
          [randomUUID(), otherWorkspaceId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await scoped.query('SELECT * FROM conversations')).toEqual([]);
  });
  it('resets role and tenant settings after transaction rollback', async () => {
    const scoped = scopedDatabase(db);
    await expect(
      tenantScope(workspaceId, () =>
        scoped.transaction(async (tx) => {
          expect(await tx.query('SELECT * FROM conversations')).toHaveLength(3);
          throw new Error('rollback fixture');
        }),
      ),
    ).rejects.toThrow('rollback fixture');
    expect(await scoped.query('SELECT * FROM conversations')).toEqual([]);
    expect(await identityScope(() => scoped.query('SELECT id FROM accounts'))).not.toHaveLength(0);
    expect(await scoped.query('SELECT * FROM memberships')).toEqual([]);
  });
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'uses a real non-owner login and resets pooled context',
    async () => {
      const name = `ao_login_${randomUUID().replaceAll('-', '')}`;
      const password = randomUUID().replaceAll('-', '');
      const [current] = await db.query('SELECT current_database() name');
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.pathname = '/' + current!.name;
      url.username = name;
      url.password = password;
      await db.query(
        `CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
      );
      await db.query(`GRANT ao_runtime,ao_identity,ao_dispatcher,ao_worker TO ${name}`);
      const runtime = await database({ url: url.toString() });
      try {
        await assertRuntimeConnection(runtime);
        await db.query(`ALTER ROLE ${name} INHERIT`);
        await expect(assertRuntimeConnection(runtime)).rejects.toThrow('NOINHERIT');
        await db.query(`ALTER ROLE ${name} NOINHERIT`);
        await expect(assertRuntimeConnection(db)).rejects.toThrow('non-owner login');
        const scoped = scopedDatabase(runtime);
        await Promise.all(
          Array.from({ length: 40 }, async (_, index) => {
            const workspace = index % 2 ? workspaceId : otherWorkspaceId;
            await tenantScope(workspace, async () => {
              const rows = await scoped.query('SELECT id FROM workspaces');
              expect(rows.map((row) => row.id)).toEqual([workspace]);
            });
            expect(await scoped.query('SELECT id FROM workspaces')).toEqual([]);
          }),
        );
        const [connection] = await runtime.query(
          "SELECT current_user AS role,current_setting('ao.workspace_id',true) AS workspace",
        );
        expect(connection?.role).toBe(name);
        expect(connection?.workspace || '').toBe('');
        await expect(
          tenantScope(workspaceId, () =>
            scoped.transaction(async (tx) => {
              await tx.query('SELECT id FROM workspaces');
              throw new Error('pooled rollback');
            }),
          ),
        ).rejects.toThrow('pooled rollback');
        expect(await scoped.query('SELECT id FROM workspaces')).toEqual([]);
        await expect(runtime.query('SELECT * FROM accounts')).rejects.toThrow('permission denied');
        const productionApp = await buildApp(runtime, {
          production: true,
          email: testEmail(),
          realtimeKey: Buffer.alloc(32, 9).toString('base64'),
        });
        try {
          expect(
            (await productionApp.inject({ url: '/v1/bootstrap', headers: headers(owner) }))
              .statusCode,
          ).toBe(200);
          const registration = await productionApp.inject({
            method: 'POST',
            url: '/v1/auth/signup',
            payload: {
              email: 'nonowner@team.test',
              name: 'Non-owner',
              password: 'nonowner-test-password-2026',
              workspace: 'Non-owner login',
            },
          });
          expect(registration.statusCode).toBe(201);
          expect(registration.cookies[0]?.secure).toBe(true);
        } finally {
          await productionApp.close();
        }
      } finally {
        await runtime.close();
        await db.query(`DROP ROLE ${name}`);
      }
    },
  );
});
