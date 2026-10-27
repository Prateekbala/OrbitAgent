import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import { connectorId } from '@ao/contracts/connections';
import { authenticate } from './auth.js';
import {
  connectionActor,
  ownedConnection,
  type ConnectionService,
} from '../connections/service.js';
import type { ConnectorOAuthProviders } from '../connections/oauth.js';
import type { IdentitySecrets } from '../identity/secrets.js';
import { digest } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
export function connectorOAuthRoutes(
  app: FastifyInstance,
  db: Database,
  secrets: IdentitySecrets,
  providers: ConnectorOAuthProviders,
  connections: ConnectionService,
  origin: string,
) {
  app.get('/v1/connections/oauth/providers', async (req) => {
    await authenticate(db, req);
    return { items: Object.keys(providers) };
  });
  app.post('/v1/connections/oauth/start', async (req) => {
    const p = await authenticate(db, req),
      input = z
        .object({
          provider: connectorId,
          name: z.string().trim().min(1).max(120),
          audience: z.enum(['personal', 'workspace']),
          access: z.enum(['read', 'write']).default('read'),
          connectionId: z.uuid().optional(),
        })
        .strict()
        .parse(req.body);
    const provider = providers[input.provider];
    if (!provider)
      throw new AppError(
        503,
        'CONNECTOR_OAUTH_UNAVAILABLE',
        'The operator must configure this provider OAuth application.',
      );
    if (!req.cookies.ao_session || p.kind !== 'human')
      throw new AppError(
        403,
        'BROWSER_SESSION_REQUIRED',
        'Connect providers from your signed-in browser.',
      );
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(48).toString('base64url');
    await db.transaction(async (tx) => {
      const authority = await connectionActor(tx, p);
      const existing = input.connectionId
        ? await ownedConnection(tx, p, input.connectionId)
        : undefined;
      if (existing && existing.provider !== input.provider)
        throw new AppError(400, 'PROVIDER_MISMATCH', 'Reconnect with the same provider.');
      await tx.query(
        'DELETE FROM connection_oauth_states WHERE workspace_id=$1 AND owner_id=$2 AND expires_at<now()',
        [p.workspaceId, p.membershipId],
      );
      const [pending] = await tx.query(
        'SELECT count(*)::integer count FROM connection_oauth_states WHERE workspace_id=$1 AND owner_id=$2',
        [p.workspaceId, p.membershipId],
      );
      if (Number(pending!.count) >= 10)
        throw new AppError(
          429,
          'OAUTH_LIMIT',
          'Finish or wait for pending connection requests to expire.',
        );
      await tx.query(
        'INSERT INTO connection_oauth_states(state_hash,workspace_id,owner_id,session_hash,provider,encrypted_verifier,config,name,audience,auth_version,policy_version,connection_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          digest(state),
          p.workspaceId,
          p.membershipId,
          digest(req.cookies.ao_session!),
          input.provider,
          secrets.seal('connector-oauth:' + digest(state), verifier),
          JSON.stringify({
            access: input.access,
            ...(existing ? { version: existing.version } : {}),
          }),
          existing?.name ?? input.name,
          existing?.audience ?? input.audience,
          authority.auth,
          authority.policy,
          input.connectionId ?? null,
        ],
      );
    });
    return {
      url: provider.authorization(
        state,
        createHash('sha256').update(verifier).digest('base64url'),
        input.access,
      ),
    };
  });
  app.get('/v1/connections/oauth/:provider/callback', async (req, reply) => {
    const p = await authenticate(db, req),
      id = connectorId.parse((req.params as { provider: string }).provider),
      provider = providers[id];
    if (!provider)
      throw new AppError(
        503,
        'CONNECTOR_OAUTH_UNAVAILABLE',
        'This OAuth provider is not configured.',
      );
    const q = z
      .object({
        state: z.string().min(32).max(200),
        code: z.string().min(1).max(4096).optional(),
        error: z.string().min(1).max(200).optional(),
        error_description: z.string().max(1000).optional(),
        error_uri: z.string().max(1000).optional(),
        session_state: z.string().max(500).optional(),
        scope: z.string().max(4000).optional(),
        authuser: z.string().max(100).optional(),
        prompt: z.string().max(100).optional(),
      })
      .strict()
      .parse(req.query);
    if (
      !req.cookies.ao_session ||
      p.kind !== 'human' ||
      (!q.code && !q.error) ||
      (q.code && q.error)
    )
      throw new AppError(
        400,
        'INVALID_OAUTH_CALLBACK',
        'Use the signed-in browser that started consent.',
      );
    const state = await db.transaction(async (tx) => {
      const [row] = await tx.query(
        'DELETE FROM connection_oauth_states WHERE workspace_id=$1 AND owner_id=$2 AND state_hash=$3 AND session_hash=$4 AND provider=$5 AND expires_at>now() RETURNING *',
        [p.workspaceId, p.membershipId, digest(q.state), digest(req.cookies.ao_session ?? ''), id],
      );
      if (!row)
        throw new AppError(
          400,
          'INVALID_OAUTH_STATE',
          'The OAuth request expired, was consumed, or belongs to another session.',
        );
      const authority = await connectionActor(tx, p);
      if (authority.auth !== row.auth_version || authority.policy !== row.policy_version)
        throw new AppError(409, 'AUTHORITY_CHANGED', 'Start a new connection request.');
      return row;
    });
    if (q.error) return reply.redirect(origin + '/app?connection=denied');
    const access = z
      .enum(['read', 'write'])
      .parse((state.config as Record<string, unknown>).access ?? 'read');
    const credential = await provider.exchange(
      q.code!,
      secrets.open('connector-oauth:' + digest(q.state), String(state.encrypted_verifier)),
      access,
    );
    const expected = { auth: Number(state.auth_version), policy: Number(state.policy_version) };
    const scopedCredential = { ...credential, writeAllowed: access === 'write' };
    if (state.connection_id)
      await connections.reconnect(
        p,
        String(state.connection_id),
        z
          .number()
          .int()
          .positive()
          .parse((state.config as Record<string, unknown>).version),
        scopedCredential,
        expected,
      );
    else
      await connections.create(
        p,
        {
          provider: id,
          name: String(state.name),
          audience: state.audience as 'personal' | 'workspace',
          credential: 'oauth',
          allowWrites: false,
          config: {},
          subscriptions: [],
        },
        scopedCredential,
        expected,
      );
    return reply.redirect(origin + '/app?connection=connected');
  });
}
