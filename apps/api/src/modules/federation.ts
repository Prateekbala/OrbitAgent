import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { identityScope, type Database } from '@ao/database';
import { z } from 'zod';
import { id, providerInput } from '@ao/contracts';
import { currentSession, sessionMetadata } from '../identity/security.js';
import { FederationService } from '../identity/federation.js';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import { sessionCookie } from '../lib/sessions.js';
import { AppError, notFound } from '../lib/errors.js';
import { token } from '../lib/security.js';
export function federationRoutes(
  app: FastifyInstance,
  db: Database,
  service: FederationService,
  production: boolean,
) {
  const org = (p: unknown) => z.object({ org: id }).parse(p).org;
  app.addHook('onClose', () => service.close());
  app.get('/v1/organizations/:org/providers', async (req) => {
    const session = await currentSession(db, req),
      organization = org(req.params);
    return identityScope(async () => {
      await organizationActor(db, organization, session.account_id);
      return db.query(
        'SELECT id,name,protocol,enabled,version,configuration FROM identity_providers WHERE organization_id=$1 ORDER BY name,id',
        [organization],
      );
    });
  });
  app.post('/v1/organizations/:org/providers', async (req, reply) => {
    const session = await currentSession(db, req),
      organization = org(req.params),
      input = providerInput.parse(req.body);
    const result = await identityScope(() =>
      db.transaction((tx) => service.configure(tx, organization, session.account_id, input)),
    );
    return reply.code(201).send(result);
  });
  app.delete('/v1/organizations/:org/providers/:provider', async (req) => {
    const session = await currentSession(db, req),
      organization = z.object({ org: id, provider: id }).parse(req.params);
    await identityScope(() =>
      db.transaction(async (tx) => {
        const actor = await organizationActor(tx, organization.org, session.account_id, true, true);
        if (actor.role !== 'owner')
          throw new AppError(
            403,
            'OWNER_REQUIRED',
            'Only an owner can disable identity providers.',
          );
        if (actor.require_sso) {
          const [other] = await tx.query(
            'SELECT p.id FROM identity_providers p JOIN federated_identities f ON f.provider_id=p.id WHERE p.organization_id=$1 AND p.enabled AND p.id<>$2 AND f.account_id=$3',
            [organization.org, organization.provider, session.account_id],
          );
          if (!other)
            throw new AppError(
              409,
              'SSO_POLICY_REQUIRED',
              'Disable the SSO requirement before removing the last provider.',
            );
        }
        const [row] = await tx.query(
          'UPDATE identity_providers SET enabled=false,secret=NULL,version=version+1 WHERE id=$1 AND organization_id=$2 RETURNING id',
          [organization.provider, organization.org],
        );
        if (!row) throw notFound();
        await tx.query('DELETE FROM sessions WHERE provider_id=$1', [organization.provider]);
        await tx.query('DELETE FROM federation_transactions WHERE provider_id=$1', [
          organization.provider,
        ]);
        await organizationAudit(
          tx,
          organization.org,
          session.account_id,
          'identity_provider.disabled',
          organization.provider,
        );
      }),
    );
    return { ok: true };
  });
  app.post(
    '/v1/auth/providers',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const input = z
        .union([
          z
            .object({
              email: z
                .email()
                .max(254)
                .transform((v) => v.toLowerCase()),
            })
            .strict(),
          z.object({ organizationId: id }).strict(),
        ])
        .parse(req.body);
      if ('organizationId' in input)
        return identityScope(() =>
          db.query(
            'SELECT id,name,protocol FROM identity_providers WHERE organization_id=$1 AND enabled ORDER BY name LIMIT 20',
            [input.organizationId],
          ),
        );
      return identityScope(() =>
        db.query(
          'SELECT p.id,p.name,p.protocol FROM identity_providers p JOIN organization_domains d ON d.organization_id=p.organization_id WHERE d.domain=$1 AND d.verified_at IS NOT NULL AND p.enabled ORDER BY p.name LIMIT 20',
          [input.email.split('@')[1]],
        ),
      );
    },
  );
  app.get(
    '/v1/auth/federation/:provider/start',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const provider = await service.provider(
          id.parse((req.params as { provider: string }).provider),
        ),
        query = z.object({ link: z.enum(['true']).optional() }).parse(req.query);
      const session = query.link ? await currentSession(db, req) : null;
      const browser = token(),
        location = await service.begin(
          provider,
          browser,
          session ? { accountId: session.account_id, sessionId: session.id } : undefined,
        );
      reply.setCookie('ao_federation', browser, {
        ...sessionCookie(production),
        maxAge: 300,
        sameSite: provider.protocol === 'saml' && production ? 'none' : 'lax',
      });
      return reply.redirect(location);
    },
  );
  app.get('/v1/auth/federation/:provider/callback/metadata', async (req, reply) => {
    const provider = await service.provider(
      id.parse((req.params as { provider: string }).provider),
    );
    if (provider.protocol !== 'saml') throw notFound();
    return reply
      .type('application/samlmetadata+xml')
      .send(service.saml(provider).generateServiceProviderMetadata(null, null));
  });
  const callback: RouteHandlerMethod = async (req, reply) => {
    const provider = await service.provider(
      id.parse((req.params as { provider: string }).provider),
    );
    const body =
      req.method === 'POST' ? z.record(z.string(), z.string()).parse(req.body) : undefined;
    if ((provider.protocol === 'saml') !== (req.method === 'POST')) throw notFound();
    const url = new URL(service.callback(provider.id));
    if (req.method === 'GET') url.search = new URL(req.url, 'http://internal').search;
    const state = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(body?.RelayState ?? url.searchParams.get('state'));
    const profile = await service.finish(
      provider,
      state,
      req.cookies.ao_federation ?? '',
      url,
      body,
    );
    const result = await service.login(provider, profile, sessionMetadata(req));
    reply.clearCookie('ao_federation', { path: '/' });
    if (result.challenge) {
      reply.clearCookie('ao_session', { path: '/' });
      reply.setCookie('ao_mfa', result.challenge, { ...sessionCookie(production), maxAge: 300 });
      return reply.redirect(service.origin + '/sign-in?mfa=1');
    }
    reply.setCookie('ao_session', result.session!, sessionCookie(production));
    return reply.redirect(service.origin + '/app');
  };
  app.get('/v1/auth/federation/:provider/callback', callback);
  void app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        const params = new URLSearchParams(String(body));
        if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
          return done(new AppError(400, 'INVALID_SAML_RESPONSE', 'Duplicate SAML form fields.'));
        done(null, Object.fromEntries(params));
      },
    );
    scoped.post('/v1/auth/federation/:provider/callback', callback);
  });
}
