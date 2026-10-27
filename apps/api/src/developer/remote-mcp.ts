import { canonicalJson } from '../lib/canonical-json.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Agent, request } from 'undici';
import { z } from 'zod';
import { validatePublicEndpoint } from '../lib/safe-endpoint.js';
import { AppError } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import type { ProviderReceipt } from '../tools/provider.js';
export const remoteTool = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(1000).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strip();
type RemoteTool = z.infer<typeof remoteTool>;
export interface RemoteMcp {
  discover(url: string, token: string): Promise<RemoteTool[]>;
  call(
    url: string,
    token: string,
    name: string,
    input: Record<string, unknown>,
    key: string,
    guard: () => Promise<void>,
    expectedTool?: RemoteTool,
  ): Promise<ProviderReceipt>;
}
export function remoteMcp(hosts: string[]): RemoteMcp {
  async function session<T>(endpoint: string, token: string, work: (client: Client) => Promise<T>) {
    const validated = await validatePublicEndpoint(endpoint, hosts, 'REMOTE_MCP');
    const deadline = AbortSignal.timeout(12000);
    const client = new Client({ name: 'orbit', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(validated.url, {
      requestInit: {
        headers: token ? { authorization: 'Bearer ' + token } : {},
        redirect: 'error',
      },
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        const target = new URL(input);
        if (target.href !== validated.url.href)
          throw new AppError(
            400,
            'MCP_DESTINATION_DENIED',
            'The remote server cannot change the credential destination.',
          );
        const { url, address } = await validatePublicEndpoint(target.href, hosts, 'REMOTE_MCP');
        const dispatcher = new Agent({
          connect: {
            lookup: (_host, options, callback) =>
              options.all
                ? callback(null, [address])
                : callback(null, address.address, address.family),
          },
        });
        try {
          const headers = Object.fromEntries(new Headers(init?.headers)),
            response = await request(url, {
              dispatcher,
              method: (init?.method ?? 'POST') as 'POST' | 'GET' | 'DELETE',
              headers,
              ...(init?.body ? { body: String(init.body) } : {}),
              signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
            });
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response.body) {
            const b = Buffer.from(chunk);
            bytes += b.length;
            if (bytes > 128000) {
              response.body.destroy();
              throw new AppError(
                502,
                'MCP_RESPONSE_LIMIT',
                'The MCP response exceeded the configured bound.',
              );
            }
            chunks.push(b);
          }
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(response.headers))
            if (
              typeof v === 'string' &&
              !['content-length', 'content-encoding', 'transfer-encoding'].includes(k)
            )
              responseHeaders.set(k, v);
          return new Response(
            [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks),
            { status: response.statusCode, headers: responseHeaders },
          );
        } finally {
          await dispatcher.close();
        }
      },
    });
    try {
      await client.connect(transport);
      return await work(client);
    } finally {
      await client.close();
    }
  }
  async function discoverTools(client: Client) {
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of result.tools) tools.push(remoteTool.parse(tool));
      if (tools.length > 100)
        throw new AppError(502, 'MCP_TOOL_LIMIT', 'This server exposes more than 100 tools.');
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (cursor || new Set(tools.map((t) => t.name)).size !== tools.length)
      throw new AppError(
        502,
        'MCP_MANIFEST_INVALID',
        'The server must expose a bounded, unique tool manifest.',
      );
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }
  return {
    discover: (url, token) =>
      session(url, token, async (client) => {
        return discoverTools(client);
      }),
    call: async (url, token, name, input, key, guard, expectedTool) => {
      return session(url, token, async (client) => {
        if (expectedTool) {
          const tools = await discoverTools(client);
          const current = tools.find((t) => t.name === name);
          if (
            !current ||
            digest(canonicalJson(remoteTool.parse(current))) !== digest(canonicalJson(expectedTool))
          )
            return { status: 'not_applied', receipt: 'mcp:manifest_changed' };
        }
        await guard();
        const result = await client.callTool({
          name,
          arguments: input,
          _meta: { 'orbit/action-id': key },
        });
        return result.isError
          ? { status: 'unknown' }
          : { status: 'succeeded', receipt: 'mcp:' + digest(JSON.stringify(result)) };
      });
    },
  };
}
