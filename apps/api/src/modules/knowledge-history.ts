import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { personalListQuery } from '@ao/contracts/personal';
import { authenticate } from './auth.js';
import { knowledgePage } from '../knowledge/access.js';
import { pageBoundary, pageResult } from '../messaging/pagination.js';
export function knowledgeHistoryRoutes(app: FastifyInstance, db: Database) {
  for (const kind of ['comments', 'reviews'] as const)
    app.get(`/v1/knowledge/:id/${kind}`, async (req) => {
      const p = await authenticate(db, req),
        pageId = z.uuid().parse((req.params as { id: string }).id),
        q = personalListQuery.parse(req.query),
        scope = 'knowledge-' + kind + ':' + pageId,
        b = pageBoundary(p, scope, q.after);
      return db.transaction(async (tx) => {
        await knowledgePage(tx, p, pageId);
        const table = kind === 'comments' ? 'knowledge_comments' : 'knowledge_reviews',
          member = kind === 'comments' ? 'author_id' : 'reviewer_id';
        const rows = await tx.query(
          `SELECT c.*,m.name author_name,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') position_time FROM ${table} c JOIN memberships m ON m.workspace_id=c.workspace_id AND m.id=c.${member} WHERE c.workspace_id=$1 AND c.page_id=$2 AND ($3::timestamptz IS NULL OR (c.created_at,c.id)<($3::timestamptz,$4::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT $5`,
          [p.workspaceId, pageId, b?.at ?? null, b?.id ?? null, q.limit + 1],
        );
        return pageResult(p, scope, rows, q.limit, 'created_at');
      });
    });
}
