import { randomUUID } from 'node:crypto';
import { workerScope, type Database, type Sql } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sourceReference, type SourceReference } from '@ao/contracts/retrieval';
import { authenticate } from './auth.js';
import { requireConversation, type Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { requireSources } from '../retrieval/service.js';
import { recordChange } from '../lib/events.js';

const key = (value: unknown) => z.object({ id: z.uuid() }).parse(value).id;
const node = sourceReference.extend({ ownerId: z.uuid() });
const nodesSchema = z.array(node).min(1).max(129);
async function author(tx: Sql, p: Identity) {
  if (p.kind !== 'human' || p.accessType === 'guest' || p.accessType === 'service')
    throw new AppError(403, 'SOURCE_OWNER_REQUIRED', 'A current human source owner must consent.');
  const [row] = await tx.query(
    "SELECT a.auth_version FROM memberships m CROSS JOIN LATERAL member_account_authority(m.workspace_id,m.id) a WHERE m.workspace_id=$1 AND m.id=$2 AND m.status='active' AND m.kind='human' AND m.access_type='member' AND coalesce((m.permissions->>'knowledge.write')::boolean,true) AND retrieval_principal_current(m.workspace_id,m.id) AND a.verified",
    [p.workspaceId, p.membershipId],
  );
  await requireSources(tx, p, []);
  if (!row)
    throw new AppError(
      403,
      'SOURCE_OWNER_REQUIRED',
      'Current verified source ownership is required.',
    );
  return Number(row.auth_version);
}
async function currentRequest(tx: Sql, p: Identity, id: string) {
  const [request] = await tx.query(
    'SELECT r.*,a.epoch current_epoch FROM memory_release_requests r JOIN retrieval_authority a USING(workspace_id) WHERE r.workspace_id=$1 AND r.id=$2 FOR UPDATE OF r',
    [p.workspaceId, id],
  );
  if (
    !request ||
    (request.requester_id !== p.membershipId &&
      !(
        await tx.query(
          'SELECT 1 FROM memory_source_consents WHERE workspace_id=$1 AND request_id=$2 AND owner_id=$3',
          [p.workspaceId, id, p.membershipId],
        )
      ).length)
  )
    throw notFound();
  return request;
}
function pending(request: Record<string, unknown>) {
  if (request.state !== 'pending' || new Date(String(request.expires_at)).getTime() <= Date.now())
    throw new AppError(409, 'CONSENT_REQUEST_CLOSED', 'This consent request is closed or expired.');
  if (String(request.epoch) !== String(request.current_epoch))
    throw new AppError(
      409,
      'CONSENT_AUDIENCE_CHANGED',
      'Access changed. Create a new request and review the current audience.',
    );
}
export function memoryConsentRoutes(app: FastifyInstance, db: Database) {
  app.post('/v1/memory/:id/release-requests', async (req, reply) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    const input = z
      .object({
        version: z.number().int().positive(),
        conversationId: z.uuid().optional(),
        reason: z.string().trim().min(10).max(1000),
        acknowledgeAudienceExpansion: z.literal(true),
      })
      .strict()
      .parse(req.body);
    return reply.code(201).send(
      await workerScope(p.workspaceId, () =>
        db.transaction(async (tx) => {
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
          const auth = await author(tx, p);
          if (input.conversationId) await requireConversation(tx, p, input.conversationId, true);
          const [memory] = await tx.query(
            'SELECT * FROM agent_memories WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND version=$4 AND release_id IS NULL',
            [p.workspaceId, id, p.membershipId, input.version],
          );
          if (!memory) throw notFound();
          await requireSources(tx, p, [{ kind: 'memory', id, version: input.version }]);
          const [result] = await tx.query('SELECT memory_consent_nodes($1,$2,$3) nodes', [
            p.workspaceId,
            id,
            input.version,
          ]);
          const parsed = nodesSchema.safeParse(result?.nodes);
          if (!parsed.success || parsed.data.length > 128)
            throw new AppError(
              409,
              'CONSENT_PROVENANCE_UNAVAILABLE',
              'Every source must have a current human owner and bounded provenance.',
            );
          const owners = new Map<string, z.infer<typeof node>[]>();
          for (const ref of parsed.data)
            owners.set(ref.ownerId, [...(owners.get(ref.ownerId) ?? []), ref]);
          const [quota] = await tx.query(
            "SELECT count(*)::integer count FROM memory_release_requests WHERE workspace_id=$1 AND requester_id=$2 AND state='pending' AND expires_at>now()",
            [p.workspaceId, p.membershipId],
          );
          if (Number(quota!.count) >= 20)
            throw new AppError(
              429,
              'CONSENT_REQUEST_LIMIT',
              'Finish pending release requests first.',
            );
          const request = randomUUID();
          await tx.query(
            "INSERT INTO memory_release_requests(id,workspace_id,source_memory_id,source_version,requester_id,target_conversation_id,reason,body_hash,title_hash,epoch,policy_version,requester_auth_version,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,a.epoch,workspace_policy_version($2),$10,least(now()+interval '24 hours',$11::timestamptz) FROM retrieval_authority a WHERE workspace_id=$2",
            [
              request,
              p.workspaceId,
              id,
              input.version,
              p.membershipId,
              input.conversationId ?? null,
              input.reason,
              digest(String(memory.body)),
              digest(String(memory.title)),
              auth,
              memory.expires_at,
            ],
          );
          for (const [owner, sources] of owners) {
            const [eligible] = await tx.query(
              "SELECT 1 FROM memberships m CROSS JOIN LATERAL member_account_authority(m.workspace_id,m.id) a WHERE m.workspace_id=$1 AND m.id=$2 AND m.kind='human' AND m.status='active' AND m.access_type='member' AND coalesce((m.permissions->>'knowledge.write')::boolean,true) AND retrieval_principal_current(m.workspace_id,m.id) AND a.verified",
              [p.workspaceId, owner],
            );
            if (!eligible)
              throw new AppError(
                409,
                'SOURCE_OWNER_UNAVAILABLE',
                'Every source needs an active verified human owner.',
              );
            await tx.query(
              'INSERT INTO memory_source_consents(workspace_id,request_id,owner_id,sources) VALUES($1,$2,$3,$4)',
              [p.workspaceId, request, owner, JSON.stringify(sources)],
            );
            await recordChange(tx, p, 'memory.consent_requested', request, null, owner);
          }
          return { id: request, owners: owners.size };
        }),
      ),
    );
  });
  app.get('/v1/memory-release-requests', async (req) => {
    const p = await authenticate(db, req),
      q = z
        .object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .strict()
        .parse(req.query);
    const rows = await db.query(
      'SELECT id,requester_id,target_conversation_id,reason,body_hash,state,expires_at,created_at FROM memory_release_requests WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
      [p.workspaceId, q.after ?? null, q.limit + 1],
    );
    return {
      items: rows.slice(0, q.limit),
      next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
  app.get('/v1/memory-release-requests/:id', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    return workerScope(p.workspaceId, () =>
      db.transaction(async (tx) => {
        await author(tx, p);
        const request = await currentRequest(tx, p, id);
        const consents = await tx.query(
          'SELECT owner_id,decision,decided_at FROM memory_source_consents WHERE workspace_id=$1 AND request_id=$2 ORDER BY owner_id',
          [p.workspaceId, id],
        );
        const [own] = await tx.query(
          'SELECT sources,decision FROM memory_source_consents WHERE workspace_id=$1 AND request_id=$2 AND owner_id=$3',
          [p.workspaceId, id, p.membershipId],
        );
        if (own) await requireSources(tx, p, own.sources as SourceReference[]);
        return {
          id,
          state: request.state,
          requesterId: request.requester_id,
          conversationId: request.target_conversation_id,
          reason: request.reason,
          bodyHash: request.body_hash,
          expiresAt: request.expires_at,
          ownSources: own?.sources ?? [],
          ownDecision: own?.decision ?? null,
          consents,
        };
      }),
    );
  });
  app.post('/v1/memory-release-requests/:id/decision', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = z
        .object({
          decision: z.enum(['approved', 'rejected', 'withdrawn']),
          bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
          acknowledgeAudienceExpansion: z.literal(true),
        })
        .strict()
        .parse(req.body);
    return workerScope(p.workspaceId, () =>
      db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        const auth = await author(tx, p),
          request = await currentRequest(tx, p, id);
        const [consent] = await tx.query(
          'SELECT * FROM memory_source_consents WHERE workspace_id=$1 AND request_id=$2 AND owner_id=$3 FOR UPDATE',
          [p.workspaceId, id, p.membershipId],
        );
        if (!consent || input.bodyHash !== request.body_hash) throw notFound();
        if (input.decision === 'withdrawn') {
          if (consent.decision !== 'approved')
            throw new AppError(
              409,
              'CONSENT_NOT_APPROVED',
              'Only an approved consent can be withdrawn.',
            );
        } else {
          pending(request);
          if (consent.decision !== 'pending')
            throw new AppError(
              409,
              'CONSENT_ALREADY_DECIDED',
              'Create a new request to change a decision.',
            );
          if (request.target_conversation_id)
            await requireConversation(tx, p, String(request.target_conversation_id), true);
          await requireSources(tx, p, consent.sources as SourceReference[]);
          for (const ref of nodesSchema.parse(consent.sources)) {
            const [owner] = await tx.query('SELECT retrieval_direct_owner($1,$2,$3) owner', [
              p.workspaceId,
              ref.kind,
              ref.id,
            ]);
            if (owner?.owner !== p.membershipId)
              throw new AppError(
                409,
                'SOURCE_OWNER_CHANGED',
                'Source ownership changed. Start a new request.',
              );
          }
        }
        await tx.query(
          'UPDATE memory_source_consents SET decision=$4,auth_version=$5,decided_at=now() WHERE workspace_id=$1 AND request_id=$2 AND owner_id=$3',
          [p.workspaceId, id, p.membershipId, input.decision, auth],
        );
        if (input.decision === 'rejected')
          await tx.query(
            "UPDATE memory_release_requests SET state='rejected' WHERE workspace_id=$1 AND id=$2 AND state='pending'",
            [p.workspaceId, id],
          );
        await recordChange(
          tx,
          p,
          'memory.consent_' + input.decision,
          id,
          null,
          String(request.requester_id),
        );
        return { ok: true };
      }),
    );
  });
  app.post('/v1/memory-release-requests/:id/publish', async (req, reply) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    z.object({ acknowledgeAudienceExpansion: z.literal(true) })
      .strict()
      .parse(req.body);
    return reply.code(201).send(
      await workerScope(p.workspaceId, () =>
        db.transaction(async (tx) => {
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
          await author(tx, p);
          const request = await currentRequest(tx, p, id);
          if (request.requester_id !== p.membershipId) throw notFound();
          if (request.state === 'published') {
            const [existing] = await tx.query(
              'SELECT published_memory_id id,id "releaseId" FROM memory_releases WHERE workspace_id=$1 AND consent_request_id=$2',
              [p.workspaceId, id],
            );
            return existing;
          }
          pending(request);
          const root = {
            kind: 'memory' as const,
            id: String(request.source_memory_id),
            version: Number(request.source_version),
          };
          await requireSources(tx, p, [root]);
          if (request.target_conversation_id)
            await requireConversation(tx, p, String(request.target_conversation_id), true);
          const [valid] = await tx.query('SELECT memory_consent_valid($1,$2) allowed', [
            p.workspaceId,
            id,
          ]);
          if (!valid?.allowed)
            throw new AppError(
              409,
              'SOURCE_CONSENT_REQUIRED',
              'Every current source owner must approve these exact revisions before publication.',
            );
          const [memory] = await tx.query(
            'SELECT * FROM agent_memories WHERE workspace_id=$1 AND id=$2',
            [p.workspaceId, root.id],
          );
          const published = randomUUID(),
            release = randomUUID(),
            sources = JSON.stringify([root]);
          await tx.query(
            'INSERT INTO memory_releases(id,workspace_id,source_memory_id,source_version,published_memory_id,approved_by,reason,body_hash,target_conversation_id,sources,consent_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
            [
              release,
              p.workspaceId,
              root.id,
              root.version,
              published,
              p.membershipId,
              request.reason,
              request.body_hash,
              request.target_conversation_id,
              sources,
              id,
            ],
          );
          await tx.query(
            'INSERT INTO agent_memories(id,workspace_id,agent_id,owner_id,boundary,conversation_id,title,body,sources,expires_at,release_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
            [
              published,
              p.workspaceId,
              memory!.agent_id,
              p.membershipId,
              request.target_conversation_id ? 'conversation' : 'workspace',
              request.target_conversation_id,
              memory!.title,
              memory!.body,
              sources,
              memory!.expires_at,
              release,
            ],
          );
          await tx.query(
            'INSERT INTO memory_revisions(workspace_id,memory_id,version,actor_id,title,body,sources,reason) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
            [
              p.workspaceId,
              published,
              p.membershipId,
              memory!.title,
              memory!.body,
              sources,
              request.reason,
            ],
          );
          await tx.query(
            "UPDATE memory_release_requests SET state='published' WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, id],
          );
          await recordChange(
            tx,
            p,
            'memory.declassified',
            published,
            request.target_conversation_id as string | null,
          );
          return { id: published, releaseId: release, version: 1 };
        }),
      ),
    );
  });
  app.delete('/v1/memory-release-requests/:id', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    return workerScope(p.workspaceId, () =>
      db.transaction(async (tx) => {
        await author(tx, p);
        const request = await currentRequest(tx, p, id);
        if (request.requester_id !== p.membershipId || request.state !== 'pending')
          throw notFound();
        await tx.query(
          "UPDATE memory_release_requests SET state='cancelled' WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id],
        );
        await recordChange(tx, p, 'memory.consent_cancelled', id, null, p.membershipId);
        return { ok: true };
      }),
    );
  });
}
