import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { messagingFixture } from './messaging-fixture.js';
import {
  scopedDatabase,
  tenantScope,
  identifyPrincipal,
  identifyPlatformCredential,
} from '@ao/database';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
const bearer = (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  url = '/public/v1/tasks',
  body?: unknown,
) =>
  f.app.inject({
    method,
    url,
    headers: {
      authorization: 'Bearer ' + token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
async function key(conversation: string, scopes = ['tasks.read', 'tasks.write']) {
  const r = await f.call(f.owner, 'POST', '/v1/developer/keys', {
    name: 'Integration test',
    grants: { scopes, conversationIds: [conversation] },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; token: string };
}
describe('developer platform', () => {
  it('enforces scopes, tenant and conversation grants for REST and direct database access, then rotates and revokes keys', async () => {
    f = await messagingFixture();
    const one = await f.channel(),
      two = await f.channel(),
      k = await key(one);
    for (const c of [one, two])
      expect(
        (
          await f.call(f.owner, 'POST', '/v1/tasks', {
            clientId: randomUUID(),
            title: 'Task ' + c,
            conversationId: c,
          })
        ).statusCode,
      ).toBe(201);
    const list = await bearer(k.token);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(1);
    const create = await bearer(k.token, 'POST', '/public/v1/tasks', {
      clientId: randomUUID(),
      title: 'Public task',
      conversationId: one,
    });
    expect(create.statusCode, create.body).toBe(201);
    expect(
      (
        await bearer(k.token, 'POST', '/public/v1/tasks', {
          clientId: randomUUID(),
          title: 'Denied task',
          conversationId: two,
        })
      ).statusCode,
    ).toBe(404);
    expect((await bearer(k.token, 'GET', '/v1/developer/keys')).statusCode).toBe(403);
    const db = scopedDatabase(f.db);
    const rows = await tenantScope(f.ownerBoot.workspace.id, () => {
      identifyPrincipal(f.ownerBoot.me.id, 'member');
      identifyPlatformCredential(k.id);
      return db.query('SELECT conversation_id FROM tasks');
    });
    expect(rows.every((r) => r.conversation_id === one)).toBe(true);
    const rotated = await f.call(f.owner, 'POST', `/v1/developer/keys/${k.id}/rotate`, {});
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect((await bearer(k.token)).statusCode).toBe(401);
    expect((await bearer(rotated.json().token)).statusCode).toBe(200);
    const revoked = await f.call(f.owner, 'DELETE', '/v1/developer/keys/' + rotated.json().id);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await bearer(rotated.json().token)).statusCode).toBe(401);
    const read = await key(one, ['tasks.read']);
    const readonlyTask = await bearer(read.token, 'GET', '/public/v1/tasks/' + create.json().id);
    expect(readonlyTask.json().can_manage).toBe(false);
    expect(
      (
        await bearer(read.token, 'POST', '/public/v1/tasks', {
          title: 'Scope denied',
          conversationId: one,
          clientId: randomUUID(),
        })
      ).statusCode,
    ).toBe(403);
  });
  it('binds event cursors to credentials and requires current membership after private access changes', async () => {
    f = await messagingFixture();
    const c = await f.channel('private'),
      a = await key(c, ['messages.read', 'events.read']),
      b = await key(c, ['messages.read', 'events.read']);
    await f.send(f.owner, c, 'Private event');
    const events = await bearer(a.token, 'GET', '/public/v1/events');
    expect(events.statusCode, events.body).toBe(200);
    expect(
      (await bearer(b.token, 'GET', '/public/v1/events?after=' + events.json().cursor)).statusCode,
    ).toBe(400);
    await f.db.query(
      'DELETE FROM conversation_members WHERE conversation_id=$1 AND membership_id=$2',
      [c, f.ownerBoot.me.id],
    );
    expect(
      (await bearer(a.token, 'GET', `/public/v1/conversations/${c}/messages`)).statusCode,
    ).toBe(404);
  });
  it('uses PKCE and exact redirects, rotates refresh tokens and commits family revocation on reuse', async () => {
    f = await messagingFixture();
    const c = await f.channel();
    const client = await f.call(f.owner, 'POST', '/v1/developer/clients', {
      name: 'Test app',
      redirectUris: ['https://client.example/callback'],
    });
    expect(client.statusCode, client.body).toBe(201);
    const verifier = randomBytes(48).toString('base64url'),
      resource = 'http://localhost:3000/api/public/v1';
    const authorization = {
      client_id: client.json().id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource,
      scope: 'tasks.read',
      state: randomBytes(24).toString('base64url'),
    };
    const consent = await f.call(f.owner, 'POST', '/v1/developer/oauth/consent', {
      authorization,
      workspaceId: f.ownerBoot.workspace.id,
      grants: { scopes: ['tasks.read'], conversationIds: [c] },
    });
    expect(consent.statusCode, consent.body).toBe(200);
    const code = new URL(consent.json().redirect_uri).searchParams.get('code')!,
      body = {
        grant_type: 'authorization_code',
        client_id: client.json().id,
        redirect_uri: authorization.redirect_uri,
        code_verifier: verifier,
        code,
        resource,
      };
    const request = (payload: unknown) =>
      f.app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    const wrong = await request({ ...body, code_verifier: randomBytes(48).toString('base64url') });
    expect(wrong.statusCode).toBe(400);
    const tokens = await request(body);
    expect(tokens.statusCode, tokens.body).toBe(200);
    expect((await bearer(tokens.json().access_token)).statusCode).toBe(200);
    expect((await request(body)).statusCode).toBe(400);
    const refresh = {
      grant_type: 'refresh_token',
      client_id: client.json().id,
      refresh_token: tokens.json().refresh_token,
      resource,
    };
    const next = await request(refresh);
    expect(next.statusCode, next.body).toBe(200);
    expect((await bearer(tokens.json().access_token)).statusCode).toBe(401);
    expect((await bearer(next.json().access_token)).statusCode).toBe(200);
    expect((await request(refresh)).statusCode).toBe(400);
    expect((await bearer(next.json().access_token)).statusCode).toBe(401);
  });
  it('serves a versioned OpenAPI contract and official MCP discovery/tools using the same authorization', async () => {
    f = await messagingFixture();
    const c = await f.channel(),
      k = await key(c, ['tasks.read']);
    const spec = await f.app.inject({ url: '/public/v1/openapi.json' });
    expect(spec.statusCode, spec.body).toBe(200);
    expect(spec.json().openapi).toBe('3.1.1');
    expect(spec.json().paths['/tasks'].get.operationId).toBe('listTasks');
    const request = (method: string, params: unknown = {}) =>
      f.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: 'Bearer ' + k.token,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        payload: { jsonrpc: '2.0', id: 1, method, params },
      });
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'Orbit compatibility test', version: '1' },
    });
    expect(initialized.statusCode, initialized.body).toBe(200);
    const tools = await request('tools/list');
    expect(tools.statusCode, tools.body).toBe(200);
    const decode = (r: { body: string }) =>
      JSON.parse(
        r.body.startsWith('event:')
          ? r.body
              .split('\n')
              .find((line) => line.startsWith('data: '))!
              .slice(6)
          : r.body,
      );
    const data = decode(tools);
    expect(data.result.tools.map((t: { name: string }) => t.name)).toContain('listTasks');
    expect(data.result.tools.map((t: { name: string }) => t.name)).not.toContain('createTask');
    const result = await request('tools/call', { name: 'listTasks', arguments: {} });
    expect(result.statusCode, result.body).toBe(200);
    expect(decode(result).result.isError).not.toBe(true);
  });
});
