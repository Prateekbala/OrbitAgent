import { canonicalJson } from '../src/lib/canonical-json.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
vi.mock('../src/lib/safe-endpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/safe-endpoint.js')>();
  return {
    ...actual,
    validatePublicEndpoint: vi.fn(async (value: string) => ({
      url: new URL(value),
      address: { address: '127.0.0.1', family: 4 },
    })),
  };
});
import { remoteMcp } from '../src/developer/remote-mcp.js';
import { messagingFixture } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
describe('MCP protocol compatibility over HTTP', () => {
  it('negotiates the current protocol using an MCP-only OAuth resource and rejects that token at REST', async () => {
    f = await messagingFixture();
    const channel = f.ownerBoot.channels[0]!.id;
    const client = await f.call(f.owner, 'POST', '/v1/developer/clients', {
      name: 'MCP compatibility',
      redirectUris: ['https://client.example/callback'],
    });
    const verifier = randomBytes(48).toString('base64url'),
      resource = 'http://localhost:3000/api/mcp';
    const consent = await f.call(f.owner, 'POST', '/v1/developer/oauth/consent', {
      authorization: {
        client_id: client.json().id,
        redirect_uri: 'https://client.example/callback',
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource,
        scope: 'tasks.read',
        state: randomBytes(24).toString('base64url'),
      },
      workspaceId: f.ownerBoot.workspace.id,
      grants: { scopes: ['tasks.read'], conversationIds: [channel] },
    });
    expect(consent.statusCode, consent.body).toBe(200);
    const code = new URL(consent.json().redirect_uri).searchParams.get('code')!,
      tokens = await f.app.inject({
        method: 'POST',
        url: '/oauth/token',
        payload: {
          grant_type: 'authorization_code',
          client_id: client.json().id,
          redirect_uri: 'https://client.example/callback',
          code_verifier: verifier,
          code,
          resource,
        },
      });
    expect(tokens.statusCode, tokens.body).toBe(200);
    const token = tokens.json().access_token,
      origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const sdk = new Client({ name: 'Orbit modern compatibility', version: '1' }),
      transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: { headers: { authorization: 'Bearer ' + token }, redirect: 'error' },
      });
    try {
      await sdk.connect(transport);
      const tools = await sdk.listTools();
      expect(tools.tools.some((t) => t.name === 'listTasks')).toBe(true);
      expect(tools.tools.some((t) => t.name === 'createTask')).toBe(false);
      const result = await sdk.callTool({ name: 'listTasks', arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await sdk.close();
    }
    const rest = await f.app.inject({
      url: '/public/v1/tasks',
      headers: { authorization: 'Bearer ' + token },
    });
    expect(rest.statusCode).toBe(401);
    const metadata = await f.app.inject({ url: '/.well-known/oauth-protected-resource/api/mcp' });
    expect(metadata.json().resource).toBe(resource);
  });
  it('discovers and calls the first-party server through the pinned remote MCP transport', async () => {
    f = await messagingFixture();
    const key = await f.call(f.owner, 'POST', '/v1/developer/keys', {
      name: 'Remote wire client',
      grants: {
        scopes: ['tasks.read', 'tasks.write'],
        conversationIds: [f.ownerBoot.channels[0]!.id],
      },
    });
    expect(key.statusCode, key.body).toBe(201);
    const origin = await f.app.listen({ host: '127.0.0.1', port: 0 }),
      provider = remoteMcp(['127.0.0.1']);
    const tools = await provider.discover(origin + '/mcp', key.json().token),
      tool = tools.find((t) => t.name === 'listTasks');
    expect(tool).toBeDefined();
    let guarded = false;
    const result = await provider.call(
      origin + '/mcp',
      key.json().token,
      'listTasks',
      {},
      'fixture-action',
      async () => {
        guarded = true;
      },
      JSON.parse(canonicalJson(tool)),
    );
    expect(guarded).toBe(true);
    expect(result.status).toBe('succeeded');
    const create = tools.find((t) => t.name === 'createTask');
    expect(create).toBeDefined();
    const write = await provider.call(
      origin + '/mcp',
      key.json().token,
      'createTask',
      {
        body: {
          title: 'MCP contract task',
          conversationId: f.ownerBoot.channels[0]!.id,
          clientId: randomUUID(),
        },
      },
      'fixture-write',
      async () => {},
      JSON.parse(canonicalJson(create)),
    );
    expect(write.status).toBe('succeeded');
    expect(
      await f.db.query('SELECT id FROM tasks WHERE title=$1', ['MCP contract task']),
    ).toHaveLength(1);
  });
});
