import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import { connectionInput, connectionGrant, connectionImport } from '@ao/contracts/connections';
import { authenticate } from './auth.js';
import { connectorCatalog, manifest } from '../connections/catalog.js';
import { ConnectionService, ownedConnection, credentialContext } from '../connections/service.js';
import { connectorProvider, type ConnectorProvider } from '../connections/provider.js';
import type { IdentitySecrets } from '../identity/secrets.js';
import { requireActiveMember } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
const key = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
export function connectionRoutes(
  app: FastifyInstance,
  db: Database,
  secrets: IdentitySecrets,
  provider: ConnectorProvider = connectorProvider(),
  service?: ConnectionService,
) {
  const connections = service ?? new ConnectionService(db, secrets, provider);
  app.get('/v1/connections/catalog', async (req) => {
    await authenticate(db, req);
    return { items: connectorCatalog };
  });
  app.get('/v1/connections', async (req) => {
    const p = await authenticate(db, req),
      q = z
        .object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .strict()
        .parse(req.query);
    const rows = await db.query(
      'SELECT id,owner_id,provider,name,audience,state,version,write_enabled,subscriptions,last_success_at,last_error_code,credential_expires_at,created_at FROM connections WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
      [p.workspaceId, q.after ?? null, q.limit + 1],
    );
    return {
      items: rows.slice(0, q.limit),
      next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
  app.post('/v1/connections', async (req, reply) =>
    reply
      .code(201)
      .send(await connections.create(await authenticate(db, req), connectionInput.parse(req.body))),
  );
  app.put('/v1/connections/:id/grants', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = connectionGrant.parse(req.body);
    if (
      new Date(input.expiresAt).getTime() <= Date.now() ||
      new Date(input.expiresAt).getTime() > Date.now() + 90 * 86400000
    )
      throw new AppError(400, 'INVALID_EXPIRY', 'Connection grants expire within 90 days.');
    return db.transaction(async (tx) => {
      const row = await ownedConnection(tx, p, id);
      if (row.audience !== 'workspace' || row.state !== 'connected')
        throw new AppError(
          409,
          'PRIVATE_CONNECTION',
          'Only active workspace connections can grant consumers.',
        );
      await requireActiveMember(tx, p, input.memberId);
      const operations = manifest(row.provider as Parameters<typeof manifest>[0]).operations.map(
        (o) => o.id,
      );
      if (
        !row.write_enabled &&
        input.operations.some((operation) =>
          manifest(row.provider as Parameters<typeof manifest>[0]).operations.some(
            (o) => o.id === operation && o.effect === 'write',
          ),
        )
      )
        throw new AppError(
          409,
          'CONNECTION_READ_ONLY',
          'Enable writes through owner rotation or OAuth reconsent before granting a write operation.',
        );
      if (input.operations.some((o) => !operations.includes(o)) || input.resources.includes('*'))
        throw new AppError(
          400,
          'INVALID_GRANT',
          'Grant implemented operations and explicit resource IDs.',
        );
      await tx.query(
        'INSERT INTO connection_grants(workspace_id,connection_id,member_id,resources,operations,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,connection_id,member_id) DO UPDATE SET resources=EXCLUDED.resources,operations=EXCLUDED.operations,expires_at=EXCLUDED.expires_at,revoked_at=NULL',
        [p.workspaceId, id, input.memberId, input.resources, input.operations, input.expiresAt],
      );
      await recordChange(tx, p, 'connection.grant_changed', id, undefined, p.membershipId);
      return { ok: true };
    });
  });
  app.get('/v1/connections/:id/grants', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    return db.query(
      'SELECT member_id,resources,operations,expires_at,revoked_at FROM connection_grants WHERE workspace_id=$1 AND connection_id=$2 ORDER BY member_id LIMIT 100',
      [p.workspaceId, id],
    );
  });
  app.delete('/v1/connections/:id/grants/:member', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id: z.uuid(), member: z.uuid() }).parse(req.params);
    return db.transaction(async (tx) => {
      await ownedConnection(tx, p, params.id);
      await tx.query(
        'UPDATE connection_grants SET revoked_at=now() WHERE workspace_id=$1 AND connection_id=$2 AND member_id=$3',
        [p.workspaceId, params.id, params.member],
      );
      await recordChange(tx, p, 'connection.grant_revoked', params.id, undefined, p.membershipId);
      return { ok: true };
    });
  });
  app.post('/v1/connections/:id/import', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = connectionImport.parse(req.body);
    await db.transaction(async (tx) => ownedConnection(tx, p, id));
    return connections.read(p, id, input);
  });
  app.post('/v1/connections/:id/rotate', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = z
        .object({
          version: z.number().int().positive(),
          credential: z.string().min(1).max(20000),
          allowWrites: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const row = await ownedConnection(tx, p, id);
      if (row.version !== input.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'Reload this connection before rotating.');
      const [authority] = await tx.query('SELECT * FROM member_account_authority($1,$2)', [
        p.workspaceId,
        p.membershipId,
      ]);
      await tx.query(
        'INSERT INTO connection_secrets(workspace_id,connection_id,encrypted_value) VALUES($1,$2,$3) ON CONFLICT(workspace_id,connection_id) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,generation=connection_secrets.generation+1,rotated_at=now(),refresh_lease=NULL,refresh_until=NULL',
        [
          p.workspaceId,
          id,
          secrets.seal(
            credentialContext(p.workspaceId, id),
            JSON.stringify({
              accessToken: input.credential,
              tokenType: row.provider === 'linear' ? 'raw' : 'Bearer',
            }),
          ),
        ],
      );
      const [updated] = await tx.query(
        "UPDATE connections SET state='connected',version=version+1,auth_version=$3,policy_version=workspace_policy_version($1),credential_expires_at=now()+interval '90 days',last_error_code=NULL,write_enabled=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING version",
        [p.workspaceId, id, authority!.auth_version, input.allowWrites],
      );
      await recordChange(tx, p, 'connection.credentials_rotated', id, undefined, p.membershipId);
      return updated;
    });
  });
  app.delete('/v1/connections/:id', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    return db.transaction(async (tx) => {
      const row = await ownedConnection(tx, p, id);
      if (row.version !== input.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'Reload this connection before revoking.');
      await tx.query(
        "UPDATE connections SET state='revoked',version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id],
      );
      await tx.query('DELETE FROM connection_secrets WHERE workspace_id=$1 AND connection_id=$2', [
        p.workspaceId,
        id,
      ]);
      await tx.query(
        "UPDATE connection_webhooks SET enabled=false,encrypted_incoming='',encrypted_outgoing='',version=version+1 WHERE workspace_id=$1 AND connection_id=$2",
        [p.workspaceId, id],
      );
      await tx.query(
        'UPDATE connection_grants SET revoked_at=now() WHERE workspace_id=$1 AND connection_id=$2',
        [p.workspaceId, id],
      );
      await tx.query(
        "UPDATE connection_resources SET deleted_at=now(),body='',title='Removed resource',version=version+1 WHERE workspace_id=$1 AND connection_id=$2",
        [p.workspaceId, id],
      );
      await recordChange(tx, p, 'connection.revoked', id, undefined, p.membershipId);
      return { ok: true };
    });
  });
  app.get('/v1/connections/:id/resources', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      q = z
        .object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .strict()
        .parse(req.query);
    const rows = await db.query(
      'SELECT id,external_id,operation,title,source_url,version,fetched_at,retained_until,conversation_id FROM connection_resources WHERE workspace_id=$1 AND connection_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',
      [p.workspaceId, id, q.after ?? null, q.limit + 1],
    );
    return {
      items: rows.slice(0, q.limit),
      next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
  app.delete('/v1/connections/:id/resources/:resource', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id: z.uuid(), resource: z.uuid() }).parse(req.params);
    return db.transaction(async (tx) => {
      await ownedConnection(tx, p, params.id);
      const [row] = await tx.query(
        "UPDATE connection_resources SET deleted_at=now(),body='',title='Removed resource',version=version+1 WHERE workspace_id=$1 AND connection_id=$2 AND id=$3 RETURNING id",
        [p.workspaceId, params.id, params.resource],
      );
      if (!row) throw notFound();
      await recordChange(
        tx,
        p,
        'connection.resource_deleted',
        params.resource,
        undefined,
        p.membershipId,
      );
      return { ok: true };
    });
  });
  app.get('/v1/connections/:id/validation', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    await db.transaction((tx) => ownedConnection(tx, p, id));
    return {
      items: await db.query(
        'SELECT operation,environment,validated_by,evidence,validated_at FROM connector_validations WHERE workspace_id=$1 AND connection_id=$2 ORDER BY operation,environment',
        [p.workspaceId, id],
      ),
      credentialHealthIsCoverage: false,
    };
  });
  app.post('/v1/connections/:id/validation', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = z
        .object({
          operation: z.string().max(100),
          environment: z.enum(['fixture', 'provider_test']),
          evidence: z.string().trim().min(10).max(2000),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const row = await ownedConnection(tx, p, id);
      if (
        !manifest(row.provider as Parameters<typeof manifest>[0]).operations.some(
          (o) => o.id === input.operation,
        )
      )
        throw new AppError(400, 'INVALID_OPERATION', 'Validate a supported operation.');
      await tx.query(
        'INSERT INTO connector_validations(workspace_id,connection_id,operation,environment,validated_by,evidence) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,connection_id,operation,environment) DO UPDATE SET validated_by=EXCLUDED.validated_by,evidence=EXCLUDED.evidence,validated_at=now()',
        [p.workspaceId, id, input.operation, input.environment, p.membershipId, input.evidence],
      );
      await recordChange(tx, p, 'connection.validation_recorded', id, undefined, p.membershipId);
      return { recorded: true, attestedByOwner: true };
    });
  });
}
