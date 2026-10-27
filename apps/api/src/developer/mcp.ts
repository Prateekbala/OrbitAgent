import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { authenticatePlatform, effectiveScopes, platformInvocation } from './auth.js';
import { publicOperations, operationInput } from './operations.js';
import { invokePublic } from './public-api.js';
import { AppError } from '../lib/errors.js';
export function mcpRoutes(
  app: FastifyInstance,
  db: Database,
  origin: string,
  allowedOrigins: string[] = [],
) {
  const resource = origin + '/api/mcp';
  app.post('/mcp', async (req, reply) => {
    if (
      req.headers.origin &&
      req.headers.origin !== origin &&
      !allowedOrigins.includes(req.headers.origin)
    )
      throw new AppError(403, 'INVALID_ORIGIN', 'This request origin is not allowed.');
    let p;
    try {
      p = await authenticatePlatform(db, req, 'mcp', resource, false);
    } catch (error) {
      reply.header(
        'www-authenticate',
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`,
      );
      throw error;
    }
    const scopes = effectiveScopes(p),
      authorization = req.headers.authorization!;
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: 'orbit', version: '1.0.0' });
        for (const o of publicOperations.filter((o) => scopes.includes(o.scope)))
          server.registerTool(
            o.id,
            {
              description: o.summary,
              inputSchema: operationInput(o),
              annotations: {
                readOnlyHint: o.method === 'GET',
                destructiveHint: ['DELETE', 'PATCH'].includes(o.method),
                idempotentHint: o.method === 'GET',
                openWorldHint: false,
              },
            },
            async (input) => {
              const response = await platformInvocation.run({ audience: 'mcp', resource }, () =>
                  invokePublic(app, o, input, authorization, req.ip),
                ),
                data = response.json();
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(data) }],
                structuredContent: { data },
                ...(response.statusCode >= 400 ? { isError: true } : {}),
              };
            },
          );
        return server;
      },
      { legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: 400000 },
    );
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === 'string' && k !== 'content-length') headers.set(k, v);
      const response = await handler.fetch(
        new Request(resource, { method: 'POST', headers, body: JSON.stringify(req.body) }),
      );
      for (const [k, v] of response.headers) reply.header(k, v);
      return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
    } finally {
      await handler.close();
    }
  });
  for (const method of ['GET', 'DELETE'] as const)
    app.route({
      method,
      url: '/mcp',
      handler: async (_req, reply) =>
        reply.code(405).header('allow', 'POST').send({ error: 'Stateless MCP requests use POST.' }),
    });
}
