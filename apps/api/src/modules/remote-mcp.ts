import { connectionActor } from './tools.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { remoteMcpInput } from '@ao/contracts/developer';
import { toolEffects } from '@ao/contracts/tools';
import { authenticate } from './auth.js';
import { browserDeveloper } from '../developer/auth.js';
import type { RemoteMcp } from '../developer/remote-mcp.js';
import type { IdentitySecrets } from '../identity/secrets.js';
import { requireConversation } from '../lib/policy.js';
import { hasPermission } from '../identity/authorization.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
export function remoteMcpRoutes(
  app: FastifyInstance,
  db: Database,
  secrets: IdentitySecrets,
  provider: RemoteMcp,
) {
  app.post('/v1/execution/mcp', async (req, reply) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    if (!hasPermission(p, 'execution.manage'))
      throw new AppError(403, 'PERMISSION_DENIED', 'Execution permission is required.');
    const v = remoteMcpInput.parse(req.body),
      id = randomUUID();
    for (const c of v.conversationIds) await requireConversation(db, p, c);
    let manifest;
    try {
      manifest = await provider.discover(v.url, v.token ?? '');
    } catch {
      throw new AppError(
        502,
        'MCP_UNAVAILABLE',
        'The remote server could not be verified. Check its endpoint, credentials and operator host policy.',
      );
    }
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      await connectionActor(tx, p);
      for (const c of v.conversationIds) await requireConversation(tx, p, c, true);
      const [count] = await tx.query(
        'SELECT count(*)::int count FROM tool_connections WHERE workspace_id=$1 AND owner_id=$2 AND revoked_at IS NULL',
        [p.workspaceId, p.membershipId],
      );
      if (Number(count?.count) >= 100)
        throw new AppError(429, 'CONNECTION_LIMIT', 'Revoke unused connections first.');
      await tx.query(
        "INSERT INTO tool_connections(id,workspace_id,owner_id,name,endpoint,operations,protocol,conversation_ids,mcp_manifest,health,checked_at) VALUES($1,$2,$3,$4,$5,'[]','mcp',$6,$7,'healthy',now())",
        [
          id,
          p.workspaceId,
          p.membershipId,
          v.name,
          v.url,
          v.conversationIds,
          JSON.stringify(manifest),
        ],
      );
      await tx.query(
        'INSERT INTO tool_connection_secrets(workspace_id,connection_id,encrypted_secret) VALUES($1,$2,$3)',
        [
          p.workspaceId,
          id,
          secrets.seal(
            'tool-connection:' + p.workspaceId + ':' + id,
            JSON.stringify({ token: v.token ?? '' }),
          ),
        ],
      );
      await recordChange(tx, p, 'mcp.connected', id, null, p.membershipId);
    });
    return reply.code(201).send({ id, version: 1, manifest });
  });
  app.get('/v1/execution/mcp/:id', async (req) => {
    const p = await authenticate(db, req),
      id = z.uuid().parse((req.params as { id: string }).id);
    const [row] = await db.query(
      "SELECT id,name,owner_id,endpoint,operations,version,revoked_at,conversation_ids,mcp_manifest,health,checked_at FROM tool_connections WHERE workspace_id=$1 AND id=$2 AND protocol='mcp'",
      [p.workspaceId, id],
    );
    if (!row) throw notFound();
    return row;
  });
  app.post('/v1/execution/mcp/:id/publication', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const id = z.uuid().parse((req.params as { id: string }).id),
      v = z
        .object({
          version: z.number().int().positive(),
          tools: z
            .array(
              z
                .object({
                  name: z.string().min(1).max(128),
                  effect: z.enum(toolEffects).exclude(['execute']),
                })
                .strict(),
            )
            .max(30),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      await connectionActor(tx, p);
      const [row] = await tx.query(
        "SELECT * FROM tool_connections WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND protocol='mcp' AND revoked_at IS NULL FOR UPDATE",
        [p.workspaceId, id, p.membershipId],
      );
      if (!row) throw notFound();
      if (row.version !== v.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'This connection changed.');
      const manifest = row.mcp_manifest as { name: string; description?: string }[];
      if (
        new Set(v.tools.map((t) => t.name)).size !== v.tools.length ||
        v.tools.some((t) => !manifest.some((m) => m.name === t.name))
      )
        throw new AppError(400, 'INVALID_TOOL', 'Choose unique tools from the reviewed manifest.');
      const operations = v.tools.map((t, i) => ({
        name: 'mcp_' + i,
        effect: t.effect,
        description: (manifest.find((m) => m.name === t.name)!.description ?? t.name).slice(0, 500),
        remoteName: t.name,
      }));
      await tx.query(
        'UPDATE tool_connections SET operations=$3,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, JSON.stringify(operations)],
      );
      await tx.query(
        'UPDATE tool_connection_grants SET revoked_at=now() WHERE workspace_id=$1 AND connection_id=$2',
        [p.workspaceId, id],
      );
      await recordChange(tx, p, 'mcp.manifest_published', id, null, p.membershipId);
      return { version: v.version + 1, operations };
    });
  });
  app.post('/v1/execution/mcp/:id/refresh', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const id = z.uuid().parse((req.params as { id: string }).id);
    const [row] = await db.query(
      "SELECT c.*,s.encrypted_secret FROM tool_connections c JOIN tool_connection_secrets s ON s.workspace_id=c.workspace_id AND s.connection_id=c.id WHERE c.workspace_id=$1 AND c.id=$2 AND c.owner_id=$3 AND c.protocol='mcp' AND c.revoked_at IS NULL",
      [p.workspaceId, id, p.membershipId],
    );
    if (!row) throw notFound();
    let manifest;
    try {
      manifest = await provider.discover(
        String(row.endpoint),
        JSON.parse(
          secrets.open('tool-connection:' + p.workspaceId + ':' + id, String(row.encrypted_secret)),
        ).token,
      );
    } catch {
      await db.query(
        "UPDATE tool_connections SET health='failed',checked_at=now() WHERE workspace_id=$1 AND id=$2 AND version=$3",
        [p.workspaceId, id, row.version],
      );
      throw new AppError(502, 'MCP_UNAVAILABLE', 'The remote server could not be verified.');
    }
    const [updated] = await db.query(
      "UPDATE tool_connections SET mcp_manifest=$4,operations='[]',version=version+1,health='healthy',checked_at=now() WHERE workspace_id=$1 AND id=$2 AND version=$3 RETURNING version",
      [p.workspaceId, id, row.version, JSON.stringify(manifest)],
    );
    if (!updated)
      throw new AppError(409, 'VERSION_CONFLICT', 'The connection changed during discovery.');
    return { ...updated, manifest };
  });
  app.post('/v1/execution/mcp/:id/credentials', async (req) => {
    const p = await authenticate(db, req);
    browserDeveloper(p);
    const id = z.uuid().parse((req.params as { id: string }).id),
      v = z
        .object({ version: z.number().int().positive(), token: z.string().max(8000).default('') })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      await connectionActor(tx, p);
      const [c] = await tx.query(
        "UPDATE tool_connections SET version=version+1,health='unchecked' WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND protocol='mcp' AND version=$4 AND revoked_at IS NULL RETURNING version",
        [p.workspaceId, id, p.membershipId, v.version],
      );
      if (!c) throw new AppError(409, 'VERSION_CONFLICT', 'The connection changed.');
      await tx.query(
        'UPDATE tool_connection_secrets SET encrypted_secret=$3 WHERE workspace_id=$1 AND connection_id=$2',
        [
          p.workspaceId,
          id,
          secrets.seal(
            'tool-connection:' + p.workspaceId + ':' + id,
            JSON.stringify({ token: v.token }),
          ),
        ],
      );
      await recordChange(tx, p, 'mcp.credentials_rotated', id, null, p.membershipId);
      return c;
    });
  });
}
