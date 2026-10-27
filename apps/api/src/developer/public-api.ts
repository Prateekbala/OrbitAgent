import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicOperations, openApi, operationInput, type PublicOperation } from './operations.js';
import { AppError } from '../lib/errors.js';
export async function invokePublic(
  app: FastifyInstance,
  o: PublicOperation,
  input: unknown,
  authorization: string,
  remoteAddress = '127.0.0.1',
) {
  const v = operationInput(o).parse(input) as {
    id?: string;
    query?: Record<string, unknown>;
    body?: unknown;
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(v.query ?? {}))
    if (value !== undefined) params.set(key, String(value));
  const path = o.internal.replace(':id', v.id ?? ''),
    suffix = params.size ? '?' + params.toString() : '';
  return app.inject({
    method: o.method,
    remoteAddress,
    url: path + suffix,
    headers: {
      authorization,
      ...(v.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(v.body === undefined ? {} : { payload: JSON.stringify(v.body) }),
  });
}
export function publicApiRoutes(app: FastifyInstance) {
  app.get('/public/v1/openapi.json', async () => openApi());
  for (const o of publicOperations)
    app.route({
      method: o.method,
      url: '/public/v1' + o.path.replace('{id}', ':id'),
      handler: async (req, reply) => {
        const authorization = req.headers.authorization;
        if (!authorization?.match(/^Bearer orb_[A-Za-z0-9_-]{43}$/))
          throw new AppError(401, 'INVALID_TOKEN', 'Use a scoped platform bearer credential.');
        const params = z.object({ id: z.uuid().optional() }).parse(req.params),
          body = o.body?.parse(req.body),
          query = o.query.parse(req.query);
        const response = await invokePublic(
          app,
          o,
          { ...params, query, ...(o.body ? { body } : {}) },
          authorization,
          req.ip,
        );
        if (response.headers['retry-after'])
          reply.header('retry-after', response.headers['retry-after']);
        return reply
          .code(response.statusCode)
          .header('x-orbit-api-version', '1')
          .type('application/json')
          .send(response.body);
      },
    });
}
