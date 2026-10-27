import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { advancedSearchQuery } from '@ao/contracts';
import { PageCursors } from '../lib/page-cursors.js';
import { authenticate } from './auth.js';

const positionSchema = z.object({ id: z.uuid(), time: z.iso.datetime(), rank: z.string().max(40) });
export function searchRoutes(
  app: FastifyInstance,
  db: Database,
  secret = randomBytes(32).toString('base64'),
) {
  const cursors = new PageCursors(secret);
  app.get('/v1/search/advanced', async (req) => {
    const p = await authenticate(db, req),
      input = advancedSearchQuery.parse(req.query);
    const { cursor, ...filters } = input,
      binding = JSON.stringify(filters);
    const position = cursor ? positionSchema.parse(cursors.decode(cursor, p, binding)) : null;
    const messages = input.scope === 'messages';
    const table = messages ? 'messages' : 'knowledge_pages';
    const time = messages ? 'm.created_at' : 'm.updated_at';
    const document = messages ? 'm.body' : "m.title || ' ' || m.body";
    const rank =
      input.sort === 'relevance'
        ? `CASE WHEN $3='' THEN 0::real ELSE ts_rank_cd(to_tsvector('english',${document}),websearch_to_tsquery('english',$3)) END`
        : '0::real';
    const direction = input.sort === 'oldest' ? 'ASC' : 'DESC';
    const relation = input.sort === 'oldest' ? '>' : '<';
    const order = `${input.sort === 'relevance' ? 'rank DESC,' : ''} occurred ${direction},id ${direction}`;
    const rows = await db.query(
      `WITH found AS (
        SELECT m.id,${messages ? 'NULL::text' : 'm.title'} title,left(m.body,600) body,
          m.conversation_id,${messages ? 'm.thread_id' : 'NULL::uuid'} thread_id,m.version,
          a.name author_name,CASE WHEN c.kind='direct' THEN (SELECT peer.name FROM memberships peer WHERE peer.workspace_id=c.workspace_id AND peer.id=CASE WHEN c.direct_low=$2 THEN c.direct_high ELSE c.direct_low END) WHEN c.kind='group' THEN c.title ELSE c.name END channel_name,
          ${time} occurred,${rank} rank
        FROM ${table} m JOIN memberships a ON a.workspace_id=m.workspace_id AND a.id=m.author_id
        LEFT JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id
        WHERE m.workspace_id=$1 ${messages ? 'AND m.deleted_at IS NULL' : "AND EXISTS(SELECT 1 FROM knowledge_metadata km WHERE km.workspace_id=m.workspace_id AND km.page_id=m.id AND km.state='active' AND NOT km.blocked AND km.superseded_by IS NULL AND km.review_state<>'contradicted')"}
          AND (m.conversation_id IS NULL OR c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2))
          AND ($3='' OR to_tsvector('english',${document}) @@ websearch_to_tsquery('english',$3))
          AND ($4::uuid IS NULL OR m.conversation_id=$4) AND ($5::uuid IS NULL OR m.author_id=$5)
          AND ($6::timestamptz IS NULL OR ${time}>=$6) AND ($7::timestamptz IS NULL OR ${time}<$7)
          ${
            messages
              ? `AND (NOT $8::boolean OR EXISTS(SELECT 1 FROM message_attachments ma JOIN files f ON f.workspace_id=ma.workspace_id AND f.id=ma.file_id AND f.status='attached' WHERE ma.workspace_id=m.workspace_id AND ma.message_id=m.id))
          AND ($9::text IS NULL OR ($9='replies' AND m.thread_id IS NOT NULL) OR ($9='main' AND m.thread_id IS NULL))`
              : 'AND $8::boolean=false AND $9::text IS NULL'
          }
      ) SELECT *,to_char(occurred AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') position_time,rank::text position_rank FROM found
        WHERE $10::uuid IS NULL OR (rank,occurred,id)${relation}($12::real,$11::timestamptz,$10::uuid)
        ORDER BY ${order} LIMIT $13`,
      [
        p.workspaceId,
        p.membershipId,
        input.q,
        input.conversationId ?? null,
        input.authorId ?? null,
        input.from ?? null,
        input.to ?? null,
        input.attachments === 'true',
        input.threads ?? null,
        position?.id ?? null,
        position?.time ?? null,
        position?.rank ?? null,
        input.limit + 1,
      ],
    );
    const items = rows.slice(0, input.limit),
      last = items.at(-1);
    return {
      items: items.map(
        ({ occurred, position_time: _time, position_rank: _rank, rank: _score, ...row }) => ({
          ...row,
          created_at: occurred,
        }),
      ),
      next_cursor:
        rows.length > input.limit && last
          ? cursors.encode(
              { id: last.id, time: last.position_time, rank: last.position_rank },
              p,
              binding,
            )
          : null,
    };
  });
}
