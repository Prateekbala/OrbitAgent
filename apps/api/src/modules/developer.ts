import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { type Database } from '@ao/database';
import { apiKeyCreate, oauthClientCreate } from '@ao/contracts/developer';
import { authenticate } from './auth.js';
import { browserDeveloper, issueCredential, validatePublicGrant } from '../developer/auth.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { taskActor } from '../tasks/service.js';
export function developerRoutes(app: FastifyInstance, db: Database) {
  const param = (v: unknown) => z.object({ id: z.uuid() }).parse(v).id;
  app.get('/v1/developer/keys', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    return db.query(
      'SELECT id,name,kind,scopes,conversation_ids,workspace_resources,audiences,expires_at,revoked_at,last_used_at,rotated_from,created_at FROM platform_credentials WHERE workspace_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',
      [p.workspaceId, p.membershipId],
    );
  });
  app.post('/v1/developer/keys', async (req, reply) => {
    let p = await authenticate(db, req);
    browserDeveloper(p);
    const v = apiKeyCreate.parse(req.body);
    const key = await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      p = await taskActor(tx, p, false);
      await validatePublicGrant(tx, p, v.grants);
      const [count] = await tx.query(
        'SELECT count(*)::int count FROM platform_credentials WHERE workspace_id=$1 AND owner_id=$2 AND revoked_at IS NULL AND expires_at>now()',
        [p.workspaceId, p.membershipId],
      );
      if (Number(count?.count) >= 100)
        throw new AppError(429, 'KEY_LIMIT', 'Revoke unused credentials before creating more.');
      const key = await issueCredential(tx, p, {
        name: v.name,
        grants: v.grants,
        expires: new Date(Date.now() + v.expiresInDays * 86400000),
        audiences: v.audiences,
      });
      await recordChange(tx, p, 'developer.key_created', key.id, null, p.membershipId);
      return key;
    });
    return reply.code(201).send(key);
  });
  app.post('/v1/developer/keys/:id/rotate', async (req) => {
    let p = await authenticate(db, req);
    browserDeveloper(p);
    const id = param(req.params);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      p = await taskActor(tx, p, false);
      const [row] = await tx.query(
        "SELECT * FROM platform_credentials WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND kind='api_key' AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
        [p.workspaceId, id, p.membershipId],
      );
      if (!row) throw notFound();
      const grants = {
        scopes: row.scopes as Parameters<typeof validatePublicGrant>[2]['scopes'],
        conversationIds: row.conversation_ids as string[],
        workspaceResources: Boolean(row.workspace_resources),
      };
      await validatePublicGrant(tx, p, grants);
      const key = await issueCredential(tx, p, {
        name: String(row.name),
        grants,
        expires: new Date(String(row.expires_at)),
        audiences: row.audiences as string[],
        rotatedFrom: id,
      });
      await tx.query(
        'UPDATE platform_credentials SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id],
      );
      await recordChange(tx, p, 'developer.key_rotated', id, null, p.membershipId);
      return key;
    });
  });
  app.delete('/v1/developer/keys/:id', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const id = param(req.params);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const [row] = await tx.query(
        'UPDATE platform_credentials SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 RETURNING family_id',
        [p.workspaceId, id, p.membershipId],
      );
      if (!row) throw notFound();
      if (row.family_id) {
        await tx.query('SET LOCAL ROLE ao_worker');
        await tx.query(
          'UPDATE developer_refresh_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1',
          [row.family_id],
        );
        await tx.query('SET LOCAL ROLE ao_runtime');
      }
      await recordChange(tx, p, 'developer.key_revoked', id, null, p.membershipId);
      return { ok: true };
    });
  });
  app.get('/v1/developer/clients', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    return db.query(
      'SELECT id,name,redirect_uris,revoked_at,created_at FROM developer_clients WHERE workspace_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 100',
      [p.workspaceId, p.membershipId],
    );
  });
  app.post('/v1/developer/clients', async (req, reply) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const v = oauthClientCreate.parse(req.body),
      id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const [count] = await tx.query(
        'SELECT count(*)::int count FROM developer_clients WHERE workspace_id=$1 AND owner_id=$2 AND revoked_at IS NULL',
        [p.workspaceId, p.membershipId],
      );
      if (Number(count?.count) >= 25)
        throw new AppError(429, 'CLIENT_LIMIT', 'Revoke unused applications first.');
      await tx.query(
        'INSERT INTO developer_clients(id,workspace_id,owner_id,name,redirect_uris) VALUES($1,$2,$3,$4,$5)',
        [id, p.workspaceId, p.membershipId, v.name, v.redirectUris],
      );
      await recordChange(tx, p, 'developer.client_created', id, null, p.membershipId);
    });
    return reply.code(201).send({ id, client_id: id, token_endpoint_auth_method: 'none', ...v });
  });
  app.delete('/v1/developer/clients/:id', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const id = param(req.params);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const [r] = await tx.query(
        'UPDATE developer_clients SET revoked_at=coalesce(revoked_at,now()) WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 RETURNING id',
        [p.workspaceId, id, p.membershipId],
      );
      if (!r) throw notFound();
      await tx.query(
        'UPDATE platform_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE client_id=$1',
        [id],
      );
      await recordChange(tx, p, 'developer.client_revoked', id, null, p.membershipId);
    });
    return { ok: true };
  });
}
