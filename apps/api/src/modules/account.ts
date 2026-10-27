import { setTimeout } from 'node:timers/promises';
import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { accountEmail, accountToken, passwordReset } from '@ao/contracts';
import type { EmailService } from '../email/service.js';
import { AccountService } from '../identity/service.js';
import { consumeAccountToken } from '../identity/tokens.js';
export function accountRoutes(app: FastifyInstance, db: Database, email: EmailService) {
  const service = new AccountService(db, email);
  app.get('/v1/auth/status', async (req) => service.status(req.cookies.ao_session));
  for (const [path, purpose] of [
    ['verification/request', 'verify_email'],
    ['password/forgot', 'reset_password'],
  ] as const) {
    app.post(
      '/v1/auth/' + path,
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const started = performance.now();
        const input = accountEmail.parse(req.body);
        await service.request(input.email, purpose);
        await setTimeout(Math.max(0, 250 + randomInt(0, 50) - (performance.now() - started)));
        return reply.code(202).send({
          ok: true,
          message: 'If this address is eligible, an email will arrive shortly.',
        });
      },
    );
  }
  app.post(
    '/v1/auth/verification/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      await consumeAccountToken(db, accountToken.parse(req.body).token, 'verify_email');
      return { ok: true };
    },
  );
  app.post(
    '/v1/auth/email/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      await consumeAccountToken(db, accountToken.parse(req.body).token, 'change_email');
      reply.clearCookie('ao_session', { path: '/' });
      return { ok: true };
    },
  );
  app.post(
    '/v1/auth/password/reset',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = passwordReset.parse(req.body);
      await consumeAccountToken(db, input.token, 'reset_password', input.password);
      reply.clearCookie('ao_session', { path: '/' });
      return { ok: true };
    },
  );
}
