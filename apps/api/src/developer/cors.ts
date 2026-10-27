import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';
export function publicDeveloperPath(url: string) {
  const path = url.split('?')[0]!;
  return (
    path.startsWith('/public/v1/') ||
    path.startsWith('/.well-known/') ||
    ['/mcp', '/oauth/token', '/oauth/revoke'].includes(path)
  );
}
export function developerCors(app: FastifyInstance, origin: string, allowed: string[]) {
  app.addHook('onRequest', async (req, reply) => {
    if (!publicDeveloperPath(req.url) || !req.headers.origin) return;
    if (req.headers.origin !== origin && !allowed.includes(req.headers.origin))
      throw new AppError(403, 'INVALID_ORIGIN', 'This browser application origin is not allowed.');
    reply
      .header('access-control-allow-origin', req.headers.origin)
      .header('vary', 'Origin')
      .header(
        'access-control-expose-headers',
        'WWW-Authenticate, Retry-After, X-Orbit-API-Version, MCP-Protocol-Version',
      );
    if (req.method === 'OPTIONS')
      return reply
        .header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
        .header(
          'access-control-allow-headers',
          'Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id',
        )
        .header('access-control-max-age', '600')
        .code(204)
        .send();
  });
}
