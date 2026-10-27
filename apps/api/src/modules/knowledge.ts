import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database, Sql } from '@ao/database';
import { id, knowledgeEdit, knowledgeRestore, versionHistoryQuery } from '@ao/contracts';
import { authenticate } from './auth.js';
import { AppError, notFound } from '../lib/errors.js';
import { requireActiveMember, requireConversation, type Identity } from '../lib/policy.js';
import { digest } from '../lib/security.js';
import { knowledgePage } from '../knowledge/access.js';
import { recordChange } from '../lib/events.js';

const visibility = `(k.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=k.workspace_id AND c.id=k.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$3))))`;
async function page(tx: Sql, p: Identity, pageId: string, lock: 'read' | 'write' | null = null) {
  if (lock) {
    const [reference] = await tx.query(
      'SELECT conversation_id FROM knowledge_pages WHERE workspace_id=$1 AND id=$2',
      [p.workspaceId, pageId],
    );
    if (!reference) throw notFound();
    if (reference.conversation_id)
      await requireConversation(tx, p, String(reference.conversation_id), true);
  }
  const [row] = await tx.query(
    `SELECT k.id,k.title,k.body,k.version,k.conversation_id,k.updated_at,a.name author_name,e.name editor_name
    FROM knowledge_pages k JOIN memberships a ON a.workspace_id=k.workspace_id AND a.id=k.author_id
    LEFT JOIN knowledge_versions v ON v.workspace_id=k.workspace_id AND v.page_id=k.id AND v.version=k.version
    LEFT JOIN memberships e ON e.workspace_id=v.workspace_id AND e.id=v.author_id
    WHERE k.workspace_id=$1 AND k.id=$2 AND ${visibility}${lock === 'write' ? ' FOR UPDATE OF k' : ''}`,
    [p.workspaceId, pageId, p.membershipId],
  );
  if (!row) throw notFound();
  return row;
}
export function knowledgeRoutes(app: FastifyInstance, db: Database) {
  app.get('/v1/knowledge/:id', async (req) =>
    page(db, await authenticate(db, req), id.parse((req.params as { id: string }).id)),
  );
  app.get('/v1/knowledge/:id/versions', async (req) => {
    const p = await authenticate(db, req),
      pageId = id.parse((req.params as { id: string }).id),
      q = versionHistoryQuery.parse(req.query);
    return db.transaction(async (tx) => {
      await page(tx, p, pageId, 'read');
      const rows = await tx.query(
        `SELECT v.version,v.created_at,v.summary,v.restored_from,m.name author_name FROM knowledge_versions v JOIN memberships m ON m.workspace_id=v.workspace_id AND m.id=v.author_id WHERE v.workspace_id=$1 AND v.page_id=$2 AND ($3::integer IS NULL OR v.version<$3) ORDER BY v.version DESC LIMIT $4`,
        [p.workspaceId, pageId, q.before ?? null, q.limit + 1],
      );
      const items = rows.slice(0, q.limit);
      return { items, next_before: rows.length > q.limit ? items.at(-1)!.version : null };
    });
  });
  app.get('/v1/knowledge/:id/versions/:version', async (req) => {
    const p = await authenticate(db, req),
      params = z
        .object({ id, version: z.coerce.number().int().positive().max(2147483647) })
        .parse(req.params);
    return db.transaction(async (tx) => {
      await page(tx, p, params.id, 'read');
      const [version] = await tx.query(
        `SELECT v.version,v.title,v.body,v.created_at,v.summary,v.restored_from,m.name author_name FROM knowledge_versions v JOIN memberships m ON m.workspace_id=v.workspace_id AND m.id=v.author_id WHERE v.workspace_id=$1 AND v.page_id=$2 AND v.version=$3`,
        [p.workspaceId, params.id, params.version],
      );
      if (!version) throw notFound();
      return version;
    });
  });
  for (const restore of [false, true])
    app.route({
      method: restore ? 'POST' : 'PATCH',
      url: `/v1/knowledge/:id${restore ? '/restore' : ''}`,
      handler: async (req) => {
        const p = await authenticate(db, req),
          pageId = id.parse((req.params as { id: string }).id);
        if (p.kind !== 'human')
          throw new AppError(
            403,
            'HUMAN_REQUIRED',
            'A person must edit or restore knowledge pages.',
          );
        const input = restore ? knowledgeRestore.parse(req.body) : knowledgeEdit.parse(req.body);
        const hash = digest(JSON.stringify({ operation: restore ? 'restore' : 'edit', ...input }));
        return db.transaction(async (tx) => {
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
          await requireActiveMember(tx, p, p.membershipId);
          const authorized = await knowledgePage(tx, p, pageId, true);
          if (authorized.state !== 'active')
            throw new AppError(409, 'PAGE_ARCHIVED', 'Restore this page before editing.');
          const current = await page(tx, p, pageId, 'write');
          const [applied] = await tx.query(
            'SELECT version,request_hash,author_id FROM knowledge_versions WHERE workspace_id=$1 AND page_id=$2 AND request_id=$3',
            [p.workspaceId, pageId, input.clientId],
          );
          if (applied) {
            if (applied.request_hash !== hash || applied.author_id !== p.membershipId)
              throw new AppError(
                409,
                'IDEMPOTENCY_CONFLICT',
                'This save identifier was already used for a different change.',
              );
            return { page: current, applied_version: applied.version, replayed: true };
          }
          if (current.version !== input.version)
            throw new AppError(
              409,
              'VERSION_CONFLICT',
              'This page changed while you were editing. Review the latest version before saving again.',
            );
          let title: string,
            body: string,
            target: number | null = null;
          if ('targetVersion' in input) {
            const [source] = await tx.query(
              'SELECT title,body FROM knowledge_versions WHERE workspace_id=$1 AND page_id=$2 AND version=$3',
              [p.workspaceId, pageId, input.targetVersion],
            );
            if (!source) throw notFound();
            title = String(source.title);
            body = String(source.body);
            target = input.targetVersion;
          } else {
            title = input.title;
            body = input.body;
          }
          const version = Number(current.version) + 1;
          await tx.query(
            'UPDATE knowledge_pages SET title=$3,body=$4,version=$5,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
            [p.workspaceId, pageId, title, body, version],
          );
          await tx.query(
            'INSERT INTO knowledge_versions(id,workspace_id,page_id,title,body,version,author_id,summary,restored_from,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
            [
              randomUUID(),
              p.workspaceId,
              pageId,
              title,
              body,
              version,
              p.membershipId,
              input.summary,
              target,
              input.clientId,
              hash,
            ],
          );
          await tx.query('DELETE FROM knowledge_documents WHERE workspace_id=$1 AND page_id=$2', [
            p.workspaceId,
            pageId,
          ]);
          await recordChange(
            tx,
            p,
            restore ? 'knowledge.restored' : 'knowledge.updated',
            pageId,
            current.conversation_id ? String(current.conversation_id) : null,
          );
          return { page: await page(tx, p, pageId), applied_version: version, replayed: false };
        });
      },
    });
}
