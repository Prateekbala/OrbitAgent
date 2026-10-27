import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { identityScope, type Database, type Sql } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { publicGrant, publicScopes } from '@ao/contracts/developer';
import { authenticate } from '../modules/auth.js';
import { browserDeveloper, validatePublicGrant, issueCredential, credentialOwner } from './auth.js';
import { AppError } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { workAuthority } from '../workflows/service.js';
import { recordChange } from '../lib/events.js';
const authQuery = z
  .object({
    client_id: z.uuid(),
    redirect_uri: z.url().max(2048),
    response_type: z.literal('code'),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal('S256'),
    resource: z.url().max(2048),
    scope: z.string().max(1000),
    state: z.string().min(16).max(1000),
  })
  .strict();
const exchange = z.discriminatedUnion('grant_type', [
  z
    .object({
      grant_type: z.literal('authorization_code'),
      client_id: z.uuid(),
      code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      redirect_uri: z.url().max(2048),
      code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
      resource: z.url().max(2048),
    })
    .strict(),
  z
    .object({
      grant_type: z.literal('refresh_token'),
      client_id: z.uuid(),
      refresh_token: z.string().regex(/^orr_[A-Za-z0-9_-]{43}$/),
      resource: z.url().max(2048),
    })
    .strict(),
]);
function invalid() {
  return new AppError(
    400,
    'INVALID_GRANT',
    'This authorization grant is invalid, expired or already used.',
  );
}
async function refresh(
  tx: Sql,
  workspace: string,
  credential: string,
  family: string,
  expires?: Date,
) {
  const token = 'orr_' + randomBytes(32).toString('base64url');
  await tx.query(
    'INSERT INTO developer_refresh_tokens(hash,workspace_id,credential_id,family_id,expires_at) VALUES($1,$2,$3,$4,$5)',
    [digest(token), workspace, credential, family, expires ?? new Date(Date.now() + 30 * 86400000)],
  );
  return token;
}
export function developerOAuthRoutes(app: FastifyInstance, db: Database, origin: string) {
  void app.register(async (app) => {
    app.setErrorHandler((error, req, reply) => {
      if (req.url.split('?')[0] !== '/oauth/token' && req.url.split('?')[0] !== '/oauth/revoke')
        throw error;
      const code = error instanceof AppError ? error.code : 'INVALID_REQUEST';
      const oauthCode =
        code === 'INVALID_GRANT'
          ? 'invalid_grant'
          : code === 'INVALID_TARGET'
            ? 'invalid_target'
            : code === 'INVALID_CLIENT'
              ? 'invalid_client'
              : 'invalid_request';
      return reply
        .code(
          oauthCode === 'invalid_grant'
            ? 400
            : error instanceof AppError
              ? Math.min(error.status, 499)
              : 400,
        )
        .send({
          error: oauthCode,
          error_description:
            error instanceof AppError ? error.message : 'The OAuth request is invalid.',
        });
    });
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        const params = new URLSearchParams(String(body));
        if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) {
          done(new AppError(400, 'INVALID_FORM', 'Duplicate form fields are not allowed.'));
          return;
        }
        done(null, Object.fromEntries(params));
      },
    );
    const issuer = origin + '/api',
      rest = issuer + '/public/v1',
      mcp = issuer + '/mcp',
      resources = [rest, mcp];
    const validate = async (v: z.infer<typeof authQuery>) => {
      if (!resources.includes(v.resource))
        throw new AppError(400, 'INVALID_TARGET', 'Choose this deployment’s REST or MCP resource.');
      const scopes = v.scope.split(' ');
      if (
        !scopes.length ||
        scopes.some((s) => !publicScopes.includes(s as never)) ||
        new Set(scopes).size !== scopes.length
      )
        throw new AppError(400, 'INVALID_SCOPE', 'Choose supported, unique scopes.');
      const [client] = await identityScope(() =>
        db.query('SELECT id,name,redirect_uris,revoked_at FROM developer_clients WHERE id=$1', [
          v.client_id,
        ]),
      );
      if (
        !client ||
        client.revoked_at ||
        !(client.redirect_uris as string[]).includes(v.redirect_uri)
      )
        throw new AppError(
          400,
          'INVALID_CLIENT',
          'The client or exact redirect URI is not registered.',
        );
      return { client, scopes };
    };
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api',
    ])
      app.get(path, async () => ({
        issuer,
        authorization_endpoint: origin + '/developer/authorize',
        token_endpoint: issuer + '/oauth/token',
        revocation_endpoint: issuer + '/oauth/revoke',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: publicScopes,
        authorization_response_iss_parameter_supported: true,
      }));
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource/public/v1',
      '/.well-known/oauth-protected-resource/api/mcp',
      '/.well-known/oauth-protected-resource/api/public/v1',
    ])
      app.get(path, async () => ({
        resource: path.endsWith('/mcp') ? mcp : rest,
        authorization_servers: [issuer],
        scopes_supported: publicScopes,
        bearer_methods_supported: ['header'],
      }));
    app.get('/v1/developer/oauth/workspaces', async (req) => {
      const p = await authenticate(db, req);
      browserDeveloper(p);
      return identityScope(() =>
        db.query(
          `SELECT m.id "membershipId",w.id "workspaceId",w.name,o.name organization FROM memberships m JOIN workspaces w ON w.id=m.workspace_id JOIN organizations o ON o.id=w.organization_id JOIN organization_members om ON om.organization_id=o.id AND om.account_id=m.account_id WHERE m.account_id=$1 AND m.status='active' AND m.access_type='member' AND om.status='active' ORDER BY o.name,w.name,m.id`,
          [p.accountId],
        ),
      );
    });
    app.get('/v1/developer/oauth/authorization', async (req) => {
      const p = await authenticate(db, req);
      browserDeveloper(p);
      const v = authQuery.parse(req.query),
        { client, scopes } = await validate(v);
      return {
        client: { id: client.id, name: client.name },
        requestedScopes: scopes,
        resource: v.resource,
        workspaceId: p.workspaceId,
        memberId: p.membershipId,
      };
    });
    app.post('/v1/developer/oauth/consent', async (req) => {
      const p = await authenticate(db, req);
      browserDeveloper(p);
      const v = z
          .object({ authorization: authQuery, grants: publicGrant, workspaceId: z.uuid() })
          .strict()
          .parse(req.body),
        { scopes } = await validate(v.authorization);
      if (v.workspaceId !== p.workspaceId)
        throw new AppError(
          409,
          'WORKSPACE_CHANGED',
          'Switch to the chosen workspace before approving consent.',
        );
      if (v.grants.scopes.some((s) => !scopes.includes(s)))
        throw new AppError(
          400,
          'SCOPE_ESCALATION',
          'Consent cannot add scopes the client did not request.',
        );
      const code = randomBytes(32).toString('base64url'),
        expires = new Date(Date.now() + 300000);
      await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        await validatePublicGrant(tx, p, v.grants);
        const a = await workAuthority(tx, p);
        await tx.query('SET LOCAL ROLE ao_identity');
        await tx.query(
          'INSERT INTO developer_oauth_codes(hash,workspace_id,owner_id,client_id,redirect_uri,challenge,resource,grants,auth_version,policy_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [
            digest(code),
            p.workspaceId,
            p.membershipId,
            v.authorization.client_id,
            v.authorization.redirect_uri,
            v.authorization.code_challenge,
            v.authorization.resource,
            JSON.stringify(v.grants),
            a.auth,
            a.policy,
            expires,
          ],
        );
        await tx.query('SET LOCAL ROLE ao_runtime');
        await recordChange(
          tx,
          p,
          'developer.oauth_consented',
          v.authorization.client_id,
          null,
          p.membershipId,
        );
      });
      const redirect = new URL(v.authorization.redirect_uri);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', v.authorization.state);
      redirect.searchParams.set('iss', issuer);
      return { redirect_uri: redirect.toString() };
    });
    app.post(
      '/oauth/token',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const v = exchange.parse(req.body);
        if (!resources.includes(v.resource)) throw invalid();
        const result = await identityScope(() =>
          db.transaction(async (tx) => {
            const [client] = await tx.query(
              'SELECT id FROM developer_clients WHERE id=$1 AND revoked_at IS NULL FOR SHARE',
              [v.client_id],
            );
            if (!client) throw invalid();
            if (v.grant_type === 'authorization_code') {
              const [c] = await tx.query(
                'SELECT * FROM developer_oauth_codes WHERE hash=$1 FOR UPDATE',
                [digest(v.code)],
              );
              if (
                !c ||
                c.consumed_at ||
                new Date(String(c.expires_at)) <= new Date() ||
                c.client_id !== v.client_id ||
                c.redirect_uri !== v.redirect_uri ||
                c.resource !== v.resource
              )
                throw invalid();
              const calculated = createHash('sha256').update(v.code_verifier).digest('base64url');
              if (
                calculated.length !== String(c.challenge).length ||
                !timingSafeEqual(Buffer.from(calculated), Buffer.from(String(c.challenge)))
              )
                throw invalid();
              await tx.query(
                'UPDATE developer_oauth_codes SET consumed_at=clock_timestamp() WHERE hash=$1',
                [digest(v.code)],
              );
              const p = await credentialOwner(tx, String(c.workspace_id), String(c.owner_id), {
                  auth: Number(c.auth_version),
                  policy: Number(c.policy_version),
                }),
                grants = publicGrant.parse(c.grants);
              await validatePublicGrant(tx, p, grants);
              const family = randomUUID(),
                key = await issueCredential(tx, p, {
                  name: 'OAuth application',
                  grants,
                  expires: new Date(Date.now() + 3600000),
                  audiences: [v.resource === mcp ? 'mcp' : 'rest'],
                  kind: 'oauth',
                  clientId: v.client_id,
                  familyId: family,
                  resource: v.resource,
                });
              return {
                access_token: key.token,
                token_type: 'Bearer',
                expires_in: 3600,
                refresh_token: await refresh(tx, p.workspaceId, key.id, family),
                scope: grants.scopes.join(' '),
              };
            }
            const [r] = await tx.query(
              'SELECT r.*,c.owner_id,c.client_id,c.resource,c.scopes,c.conversation_ids,c.workspace_resources,c.auth_version,c.policy_version,c.revoked_at credential_revoked FROM developer_refresh_tokens r JOIN platform_credentials c ON c.workspace_id=r.workspace_id AND c.id=r.credential_id WHERE r.hash=$1 FOR UPDATE OF r',
              [digest(v.refresh_token)],
            );
            if (!r || r.client_id !== v.client_id || r.resource !== v.resource) throw invalid();
            if (r.consumed_at) {
              await tx.query(
                'UPDATE platform_credentials SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE family_id=$1',
                [r.family_id],
              );
              await tx.query(
                'UPDATE developer_refresh_tokens SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE family_id=$1',
                [r.family_id],
              );
              return { reuse: true } as const;
            }
            if (
              r.revoked_at ||
              r.credential_revoked ||
              new Date(String(r.expires_at)) <= new Date()
            )
              throw invalid();
            const p = await credentialOwner(tx, String(r.workspace_id), String(r.owner_id), {
                auth: Number(r.auth_version),
                policy: Number(r.policy_version),
              }),
              grants = publicGrant.parse({
                scopes: r.scopes,
                conversationIds: r.conversation_ids,
                workspaceResources: r.workspace_resources,
              });
            await validatePublicGrant(tx, p, grants);
            await tx.query(
              'UPDATE developer_refresh_tokens SET consumed_at=clock_timestamp() WHERE hash=$1',
              [digest(v.refresh_token)],
            );
            await tx.query(
              'UPDATE platform_credentials SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
              [p.workspaceId, r.credential_id],
            );
            const key = await issueCredential(tx, p, {
              name: 'OAuth application',
              grants,
              expires: new Date(
                Math.min(Date.now() + 3600000, new Date(String(r.expires_at)).getTime()),
              ),
              audiences: [v.resource === mcp ? 'mcp' : 'rest'],
              kind: 'oauth',
              clientId: v.client_id,
              familyId: String(r.family_id),
              resource: v.resource,
              rotatedFrom: String(r.credential_id),
            });
            return {
              access_token: key.token,
              token_type: 'Bearer',
              expires_in: Math.max(
                1,
                Math.floor((new Date(key.expires_at).getTime() - Date.now()) / 1000),
              ),
              refresh_token: await refresh(
                tx,
                p.workspaceId,
                key.id,
                String(r.family_id),
                new Date(String(r.expires_at)),
              ),
              scope: grants.scopes.join(' '),
            };
          }),
        );
        if ('reuse' in result) throw invalid();
        return reply.header('pragma', 'no-cache').send(result);
      },
    );
    app.post(
      '/oauth/revoke',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req) => {
        const v = z
          .object({
            token: z.string().min(43).max(100),
            client_id: z.uuid(),
            token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
          })
          .strict()
          .parse(req.body);
        await identityScope(() =>
          db.transaction(async (tx) => {
            const [c] = await tx.query(
              'SELECT family_id,id FROM platform_credentials WHERE token_hash=$1 AND client_id=$2 UNION ALL SELECT c.family_id,c.id FROM developer_refresh_tokens r JOIN platform_credentials c ON c.id=r.credential_id WHERE r.hash=$1 AND c.client_id=$2',
              [digest(v.token), v.client_id],
            );
            if (c) {
              await tx.query(
                'UPDATE platform_credentials SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE family_id=$1',
                [c.family_id],
              );
              await tx.query(
                'UPDATE developer_refresh_tokens SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE family_id=$1',
                [c.family_id],
              );
            }
          }),
        );
        return {};
      },
    );
  });
}
