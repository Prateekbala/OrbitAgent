import { requireGovernedExport } from '../governance/policy.js';
import * as Y from 'yjs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import {
  knowledgeSync,
  knowledgeGovernance,
  knowledgeComment,
  sourceInput,
  knowledgeSchedule,
} from '@ao/contracts/knowledge';
import { authenticate } from './auth.js';
import {
  knowledgePage,
  requireKnowledgeOwner,
  publishKnowledge,
  sourcePage,
} from '../knowledge/access.js';
import { loadDocument, decodeDocument, documentContent } from '../knowledge/collaboration.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { lockAdministrator } from '../lib/policy.js';
const pageParam = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
export function knowledgeAuthoringRoutes(app: FastifyInstance, db: Database) {
  app.get('/v1/knowledge/:id/document', async (req) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      if (p.kind !== 'human')
        throw new AppError(
          403,
          'HUMAN_REQUIRED',
          'Collaborative document state is available to human editors.',
        );
      await tx.query('SELECT id FROM knowledge_pages WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
        p.workspaceId,
        pageId,
      ]);
      const page = await knowledgePage(tx, p, pageId);
      const state = await loadDocument(tx, page);
      return {
        generation: state.generation,
        update: state.state,
        version: page.version,
        title: page.title,
        body: page.body,
      };
    });
  });
  app.post('/v1/knowledge/:id/document', async (req) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params),
      input = knowledgeSync.parse(req.body);
    return db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, pageId, true);
      if (page.state !== 'active')
        throw new AppError(409, 'PAGE_ARCHIVED', 'Restore the page before editing.');
      const stored = await loadDocument(tx, page);
      if (stored.generation !== input.generation)
        throw new AppError(
          409,
          'DOCUMENT_RESET',
          'The page was restored or replaced. Review its current version before editing again.',
        );
      const doc = decodeDocument(stored.state);
      try {
        try {
          Y.applyUpdate(doc, Buffer.from(input.update, 'base64'));
        } catch {
          throw new AppError(
            400,
            'INVALID_DOCUMENT',
            'The collaborative update could not be decoded.',
          );
        }
        const { title, body } = documentContent(doc);
        const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
        const version =
          title === page.title && body === page.body
            ? page.version
            : await publishKnowledge(tx, p, page, title, body, 'Collaborative edit');
        await tx.query(
          'UPDATE knowledge_documents SET state=$3 WHERE workspace_id=$1 AND page_id=$2',
          [p.workspaceId, pageId, state],
        );
        return { generation: stored.generation, update: state, version, title, body };
      } finally {
        doc.destroy();
      }
    });
  });
  app.get('/v1/knowledge/:id/governance', async (req) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params);
    return db.transaction(async (tx) => {
      await knowledgePage(tx, p, pageId);
      const [meta] = await tx.query(
        'SELECT m.*,u.name owner_name FROM knowledge_metadata m JOIN memberships u ON u.workspace_id=m.workspace_id AND u.id=m.owner_id WHERE m.workspace_id=$1 AND m.page_id=$2',
        [p.workspaceId, pageId],
      );
      return {
        ...meta,
        reviewers: await tx.query(
          'SELECT r.member_id,m.name FROM knowledge_reviewers r JOIN memberships m ON m.workspace_id=r.workspace_id AND m.id=r.member_id WHERE r.workspace_id=$1 AND r.page_id=$2',
          [p.workspaceId, pageId],
        ),
        sources: await tx.query(
          'SELECT id,source_page_id,source_message_id,source_version,stale FROM knowledge_sources WHERE workspace_id=$1 AND page_id=$2 ORDER BY id LIMIT 100',
          [p.workspaceId, pageId],
        ),
        comments: await tx.query(
          'SELECT c.id,c.body,c.anchor,c.author_id,m.name author_name,c.resolved_at,c.created_at FROM knowledge_comments c JOIN memberships m ON m.workspace_id=c.workspace_id AND m.id=c.author_id WHERE c.workspace_id=$1 AND c.page_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 100',
          [p.workspaceId, pageId],
        ),
        proposals: await tx.query(
          "SELECT id,title,body,base_version,status,created_at FROM knowledge_proposals WHERE workspace_id=$1 AND page_id=$2 AND status='pending' ORDER BY created_at LIMIT 10",
          [p.workspaceId, pageId],
        ),
        schedule:
          (
            await tx.query(
              'SELECT enabled,interval_days,source_ids,next_at,last_error FROM knowledge_schedules WHERE workspace_id=$1 AND page_id=$2',
              [p.workspaceId, pageId],
            )
          )[0] ?? null,
      };
    });
  });
  app.put('/v1/knowledge/:id/governance', async (req) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params),
      input = knowledgeGovernance.parse(req.body);
    return db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, pageId, true);
      requireKnowledgeOwner(p, page);
      const [meta] = await tx.query(
        'SELECT version FROM knowledge_metadata WHERE workspace_id=$1 AND page_id=$2',
        [p.workspaceId, pageId],
      );
      if (meta?.version !== input.version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Page governance changed. Reload before saving.',
        );
      for (const memberId of new Set([input.ownerId, ...input.reviewers])) {
        const [member] = await tx.query(
          "SELECT m.id FROM memberships m WHERE m.workspace_id=$1 AND m.id=$2 AND m.kind='human' AND m.status='active' AND m.access_type='member' AND resource_visible_to($1,$3,$4,m.id) AND coalesce((m.permissions->>'knowledge.read')::boolean,true) AND coalesce((m.permissions->>'knowledge.write')::boolean,true) FOR SHARE",
          [p.workspaceId, memberId, page.conversation_id, page.created_at],
        );
        if (!member)
          throw new AppError(
            400,
            'INVALID_REVIEWER',
            'Owners and reviewers must be active human editors with access to the page.',
          );
      }
      for (const memberId of new Set([input.ownerId, ...input.reviewers])) {
        if (memberId === page.owner_id && input.ownerId === page.owner_id) continue;
        const [lineage] = await tx.query('SELECT knowledge_lineage_visible($1,$2,$3) allowed', [
          p.workspaceId,
          pageId,
          memberId,
        ]);
        if (!lineage?.allowed)
          throw new AppError(
            400,
            'SOURCE_ACCESS_REQUIRED',
            'New owners and reviewers must be able to read every cited source.',
          );
      }
      if (input.supersededBy) await sourcePage(tx, p, page, input.supersededBy);
      await tx.query(
        `UPDATE knowledge_metadata SET owner_id=$3,kind=$4,fresh_until=$5,state=$6,superseded_by=$7,version=version+1,review_epoch=review_epoch+1,review_state=CASE WHEN review_state='approved' THEN 'draft' ELSE review_state END WHERE workspace_id=$1 AND page_id=$2`,
        [
          p.workspaceId,
          pageId,
          input.ownerId,
          input.kind,
          input.freshUntil,
          input.state,
          input.supersededBy,
        ],
      );
      await tx.query('DELETE FROM knowledge_reviewers WHERE workspace_id=$1 AND page_id=$2', [
        p.workspaceId,
        pageId,
      ]);
      for (const member of input.reviewers)
        await tx.query(
          'INSERT INTO knowledge_reviewers(workspace_id,page_id,member_id) VALUES($1,$2,$3)',
          [p.workspaceId, pageId, member],
        );
      if (input.ownerId !== page.owner_id)
        await tx.query(
          'UPDATE knowledge_schedules SET enabled=false WHERE workspace_id=$1 AND page_id=$2',
          [p.workspaceId, pageId],
        );
      await recordChange(tx, p, 'knowledge.governance_changed', pageId, page.conversation_id);
      return { ok: true };
    });
  });
  app.post('/v1/knowledge/:id/sources', async (req) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params),
      input = sourceInput.parse(req.body);
    return db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, pageId, true);
      requireKnowledgeOwner(p, page);
      if (input.type === 'page') await sourcePage(tx, p, page, input.id, input.version);
      else {
        const [message] = await tx.query(
          'SELECT id,conversation_id,version,deleted_at FROM messages WHERE workspace_id=$1 AND id=$2',
          [p.workspaceId, input.id],
        );
        if (
          !message ||
          message.deleted_at ||
          message.conversation_id !== page.conversation_id ||
          message.version !== input.version
        )
          throw new AppError(
            409,
            'SOURCE_UNAVAILABLE',
            'Use a current message in the same audience.',
          );
      }
      const [count] = await tx.query(
        'SELECT count(*) count FROM knowledge_sources WHERE workspace_id=$1 AND page_id=$2',
        [p.workspaceId, pageId],
      );
      if (Number(count?.count ?? 0) >= 50)
        throw new AppError(
          409,
          'SOURCE_LIMIT',
          'A page supports at most fifty provenance sources.',
        );
      await tx.query(
        'INSERT INTO knowledge_sources(workspace_id,page_id,source_page_id,source_message_id,source_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [
          p.workspaceId,
          pageId,
          input.type === 'page' ? input.id : null,
          input.type === 'message' ? input.id : null,
          input.version,
        ],
      );
      await recordChange(tx, p, 'knowledge.source_added', pageId, page.conversation_id);
      return { ok: true };
    });
  });
  app.post('/v1/knowledge/:id/comments', async (req, reply) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params),
      input = knowledgeComment.parse(req.body);
    await db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, pageId, true);
      const [existing] = await tx.query(
        'SELECT page_id,author_id,body,anchor FROM knowledge_comments WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, input.clientId],
      );
      if (existing) {
        if (
          existing.page_id !== pageId ||
          existing.author_id !== p.membershipId ||
          existing.body !== input.body ||
          existing.anchor !== input.anchor
        )
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This comment identifier was already used.',
          );
        return;
      }
      await tx.query(
        'INSERT INTO knowledge_comments(id,workspace_id,page_id,author_id,body,anchor) VALUES($1,$2,$3,$4,$5,$6)',
        [input.clientId, p.workspaceId, pageId, p.membershipId, input.body, input.anchor],
      );
      await recordChange(tx, p, 'knowledge.comment_created', pageId, page.conversation_id);
    });
    return reply.code(201).send({ id: input.clientId });
  });
  app.post('/v1/knowledge/:id/comments/:commentId/resolve', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id: z.uuid(), commentId: z.uuid() }).parse(req.params);
    return db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, params.id, true);
      const [comment] = await tx.query(
        'SELECT author_id FROM knowledge_comments WHERE workspace_id=$1 AND page_id=$2 AND id=$3',
        [p.workspaceId, page.id, params.commentId],
      );
      if (!comment) throw notFound();
      if (comment.author_id !== p.membershipId && page.owner_id !== p.membershipId)
        throw new AppError(
          403,
          'COMMENT_OWNER_REQUIRED',
          'Only the author or page owner may resolve this comment.',
        );
      await tx.query(
        'UPDATE knowledge_comments SET resolved_at=coalesce(resolved_at,now()),resolved_by=$4 WHERE workspace_id=$1 AND page_id=$2 AND id=$3',
        [p.workspaceId, page.id, params.commentId, p.membershipId],
      );
      await recordChange(tx, p, 'knowledge.comment_resolved', page.id, page.conversation_id);
      return { ok: true };
    });
  });
  app.post('/v1/knowledge/:id/reviews', async (req) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params),
      input = z
        .object({
          version: z.number().int().positive(),
          decision: z.enum(['approved', 'changes_requested', 'contradiction']),
          reviewEpoch: z.number().int().positive(),
          evidence: z.string().trim().min(5).max(4000),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, pageId, true);
      if (page.version !== input.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'Review the current page version.');
      const [reviewContext] = await tx.query(
        'SELECT review_epoch,fresh_until FROM knowledge_metadata WHERE workspace_id=$1 AND page_id=$2',
        [p.workspaceId, pageId],
      );
      if (reviewContext?.review_epoch !== input.reviewEpoch)
        throw new AppError(
          409,
          'REVIEW_CONTEXT_CHANGED',
          'Ownership, reviewers or provenance changed. Reload and review the current context.',
        );
      if (
        input.decision === 'approved' &&
        reviewContext?.fresh_until &&
        Date.parse(String(reviewContext.fresh_until)) <= Date.now()
      )
        throw new AppError(
          409,
          'FRESHNESS_EXPIRED',
          'The owner must renew this page’s freshness before approval.',
        );
      const [reviewer] = await tx.query(
        'SELECT member_id FROM knowledge_reviewers WHERE workspace_id=$1 AND page_id=$2 AND member_id=$3',
        [p.workspaceId, pageId, p.membershipId],
      );
      if (!reviewer && page.owner_id !== p.membershipId)
        throw new AppError(
          403,
          'REVIEWER_REQUIRED',
          'An assigned reviewer or page owner must review the page.',
        );
      if (
        input.decision === 'approved' &&
        (page.blocked ||
          (await tx
            .query(
              'SELECT id FROM knowledge_sources WHERE workspace_id=$1 AND page_id=$2 AND stale LIMIT 1',
              [p.workspaceId, pageId],
            )
            .then((r) => r.length)))
      )
        throw new AppError(
          409,
          'STALE_SOURCES',
          'Reconcile stale or deleted sources before approving.',
        );
      await tx.query(
        'INSERT INTO knowledge_reviews(workspace_id,page_id,reviewer_id,page_version,decision,evidence,review_epoch) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          p.workspaceId,
          pageId,
          p.membershipId,
          page.version,
          input.decision,
          input.evidence,
          input.reviewEpoch,
        ],
      );
      const [pending] = await tx.query(
        `SELECT EXISTS(SELECT 1 FROM knowledge_reviewers r WHERE r.workspace_id=$1 AND r.page_id=$2 AND coalesce((SELECT v.decision FROM knowledge_reviews v WHERE v.workspace_id=r.workspace_id AND v.page_id=r.page_id AND v.reviewer_id=r.member_id AND v.page_version=$3 AND v.review_epoch=$4 ORDER BY v.created_at DESC,v.id DESC LIMIT 1),'pending')<>'approved') pending`,
        [p.workspaceId, pageId, page.version, input.reviewEpoch],
      );
      await tx.query(
        'UPDATE knowledge_metadata SET review_state=$3,version=version+1 WHERE workspace_id=$1 AND page_id=$2',
        [
          p.workspaceId,
          pageId,
          input.decision === 'contradiction'
            ? 'contradicted'
            : input.decision === 'changes_requested' || pending?.pending
              ? 'in_review'
              : 'approved',
        ],
      );
      await recordChange(tx, p, 'knowledge.reviewed', pageId, page.conversation_id);
      return { ok: true };
    });
  });
  app.put('/v1/knowledge/:id/schedule', async (req) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params),
      input = knowledgeSchedule.parse(req.body);
    return db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, pageId, true);
      requireKnowledgeOwner(p, page);
      for (const source of input.sourceIds) await sourcePage(tx, p, page, source);
      await tx.query(
        'INSERT INTO knowledge_schedules(workspace_id,page_id,owner_id,enabled,interval_days,source_ids) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,page_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,enabled=EXCLUDED.enabled,interval_days=EXCLUDED.interval_days,source_ids=EXCLUDED.source_ids,next_at=now(),last_error=NULL',
        [p.workspaceId, pageId, p.membershipId, input.enabled, input.intervalDays, input.sourceIds],
      );
      await recordChange(tx, p, 'knowledge.schedule_changed', pageId, page.conversation_id);
      return { ok: true };
    });
  });
  app.post('/v1/knowledge/:id/corrections', async (req) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params),
      input = z
        .object({
          version: z.number().int().positive(),
          title: z.string().trim().min(2).max(200),
          body: z.string().trim().min(1).max(50000),
          summary: z.string().trim().min(5).max(500),
          sources: z.array(sourceInput).max(50),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, pageId, true);
      requireKnowledgeOwner(p, page);
      if (page.version !== input.version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Review the current page before correcting it.',
        );
      for (const source of input.sources) {
        if (source.type === 'page') await sourcePage(tx, p, page, source.id, source.version);
        else {
          const [m] = await tx.query(
            'SELECT version,conversation_id FROM messages WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',
            [p.workspaceId, source.id],
          );
          if (!m || m.version !== source.version || m.conversation_id !== page.conversation_id)
            throw new AppError(
              409,
              'SOURCE_UNAVAILABLE',
              'A source changed or has a different audience.',
            );
        }
      }
      const version = await publishKnowledge(tx, p, page, input.title, input.body, input.summary);
      await tx.query('DELETE FROM knowledge_sources WHERE workspace_id=$1 AND page_id=$2', [
        p.workspaceId,
        pageId,
      ]);
      for (const source of input.sources)
        await tx.query(
          'INSERT INTO knowledge_sources(workspace_id,page_id,source_page_id,source_message_id,source_version) VALUES($1,$2,$3,$4,$5)',
          [
            p.workspaceId,
            pageId,
            source.type === 'page' ? source.id : null,
            source.type === 'message' ? source.id : null,
            source.version,
          ],
        );
      await tx.query(
        "UPDATE knowledge_metadata SET blocked=false,review_state='draft',version=version+1 WHERE workspace_id=$1 AND page_id=$2",
        [p.workspaceId, pageId],
      );
      await tx.query('DELETE FROM knowledge_documents WHERE workspace_id=$1 AND page_id=$2', [
        p.workspaceId,
        pageId,
      ]);
      await recordChange(tx, p, 'knowledge.corrected', pageId, page.conversation_id);
      return { version };
    });
  });
  app.post('/v1/knowledge/:id/proposals/:proposalId/decisions', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id: z.uuid(), proposalId: z.uuid() }).parse(req.params),
      input = z
        .object({ decision: z.enum(['accepted', 'rejected']) })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, params.id, true);
      requireKnowledgeOwner(p, page);
      const [proposal] = await tx.query(
        'SELECT * FROM knowledge_proposals WHERE workspace_id=$1 AND page_id=$2 AND id=$3 FOR UPDATE',
        [p.workspaceId, page.id, params.proposalId],
      );
      if (!proposal) throw notFound();
      if (proposal.status === input.decision) return { ok: true, replayed: true };
      if (proposal.status !== 'pending')
        throw new AppError(409, 'PROPOSAL_NOT_PENDING', 'This proposal is no longer pending.');
      if (input.decision === 'accepted') {
        if (page.version !== proposal.base_version)
          throw new AppError(
            409,
            'VERSION_CONFLICT',
            'This proposal predates a human edit. Generate a fresh proposal.',
          );
        const sources = proposal.sources as { id: string; version: number }[];
        for (const s of sources) await sourcePage(tx, p, page, s.id, s.version);
        await publishKnowledge(
          tx,
          p,
          page,
          String(proposal.title),
          String(proposal.body),
          'Accepted cited synthesis',
        );
        await tx.query('DELETE FROM knowledge_sources WHERE workspace_id=$1 AND page_id=$2', [
          p.workspaceId,
          page.id,
        ]);
        for (const s of sources)
          await tx.query(
            'INSERT INTO knowledge_sources(workspace_id,page_id,source_page_id,source_version) VALUES($1,$2,$3,$4)',
            [p.workspaceId, page.id, s.id, s.version],
          );
        await tx.query(
          "UPDATE knowledge_metadata SET blocked=false,review_state='draft',version=version+1 WHERE workspace_id=$1 AND page_id=$2",
          [p.workspaceId, page.id],
        );
        await tx.query('DELETE FROM knowledge_documents WHERE workspace_id=$1 AND page_id=$2', [
          p.workspaceId,
          page.id,
        ]);
      }
      await tx.query(
        'UPDATE knowledge_proposals SET status=$3,reviewed_by=$4 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, params.proposalId, input.decision, p.membershipId],
      );
      await recordChange(
        tx,
        p,
        'knowledge.proposal_' + input.decision,
        page.id,
        page.conversation_id,
      );
      return { ok: true };
    });
  });
  app.get('/v1/knowledge/:id/export', async (req, reply) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params);
    return db.transaction(async (tx) => {
      await requireGovernedExport(tx, p.workspaceId);
      const page = await knowledgePage(tx, p, pageId, true);
      requireKnowledgeOwner(p, page);
      const [meta] = await tx.query(
        'SELECT * FROM knowledge_metadata WHERE workspace_id=$1 AND page_id=$2',
        [p.workspaceId, pageId],
      );
      if (
        page.blocked ||
        page.state !== 'active' ||
        meta?.superseded_by ||
        meta?.review_state !== 'approved' ||
        (meta?.fresh_until && Date.parse(String(meta.fresh_until)) < Date.now())
      )
        throw new AppError(
          409,
          'EXPORT_REVIEW_REQUIRED',
          'Export requires an active, approved, current page without blocked or superseded sources.',
        );
      const [lineage] = await tx.query('SELECT knowledge_lineage_visible($1,$2,$3) allowed', [
        p.workspaceId,
        pageId,
        p.membershipId,
      ]);
      if (!lineage?.allowed)
        throw new AppError(
          409,
          'SOURCE_ACCESS_REQUIRED',
          'All cited sources must remain available before export.',
        );
      const sources = await tx.query(
        'SELECT source_page_id,source_message_id,source_version,stale FROM knowledge_sources WHERE workspace_id=$1 AND page_id=$2',
        [p.workspaceId, pageId],
      );
      if (sources.some((s) => s.stale))
        throw new AppError(409, 'STALE_SOURCES', 'Review stale sources before exporting.');
      const [counts] = await tx.query(
        'SELECT (SELECT count(*) FROM knowledge_provenance WHERE workspace_id=$1 AND page_id=$2) provenance,(SELECT count(*) FROM knowledge_reviews WHERE workspace_id=$1 AND page_id=$2) reviews',
        [p.workspaceId, pageId],
      );
      await recordChange(tx, p, 'knowledge.exported', pageId, page.conversation_id);
      reply.header('content-disposition', 'attachment; filename="knowledge-' + pageId + '.json"');
      return {
        omittedHistory: {
          provenance: Number(counts?.provenance ?? 0) > 10000,
          reviews: Number(counts?.reviews ?? 0) > 100,
        },
        provenance: await tx.query(
          'SELECT page_version,source_page_id,source_message_id,source_version,operation,created_at FROM knowledge_provenance WHERE workspace_id=$1 AND page_id=$2 ORDER BY id LIMIT 10000',
          [p.workspaceId, pageId],
        ),
        format: 'orbit.knowledge.v1',
        exportedAt: new Date().toISOString(),
        page: {
          id: page.id,
          title: page.title,
          body: page.body,
          version: page.version,
          conversationId: page.conversation_id,
        },
        governance: meta,
        sources,
        reviews: await tx.query(
          'SELECT reviewer_id,page_version,decision,evidence,created_at FROM knowledge_reviews WHERE workspace_id=$1 AND page_id=$2 ORDER BY created_at DESC LIMIT 100',
          [p.workspaceId, pageId],
        ),
      };
    });
  });
  app.delete('/v1/knowledge/:id', async (req) => {
    const p = await authenticate(db, req),
      pageId = pageParam(req.params),
      input = z
        .object({ version: z.number().int().positive(), reason: z.string().trim().min(5).max(500) })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const page = await knowledgePage(tx, p, pageId, true);
      requireKnowledgeOwner(p, page);
      if (page.version !== input.version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'The page changed. Review its current version before deleting.',
        );
      await tx.query(
        "UPDATE knowledge_metadata SET state='deleted',deleted_at=now(),version=version+1,deletion_reason=$3 WHERE workspace_id=$1 AND page_id=$2",
        [p.workspaceId, pageId, input.reason],
      );
      await tx.query(
        'UPDATE knowledge_schedules SET enabled=false WHERE workspace_id=$1 AND page_id=$2',
        [p.workspaceId, pageId],
      );
      await tx.query(
        "UPDATE knowledge_proposals SET status='invalidated' WHERE workspace_id=$1 AND page_id=$2 AND status='pending'",
        [p.workspaceId, pageId],
      );
      await recordChange(tx, p, 'knowledge.deleted', pageId, page.conversation_id);
      return { ok: true };
    });
  });
  app.get('/v1/knowledge-retention', async (req) => {
    const p = await authenticate(db, req);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'workspace.manage');
      return (
        (
          await tx.query('SELECT days,legal_hold FROM knowledge_retention WHERE workspace_id=$1', [
            p.workspaceId,
          ])
        )[0] ?? { days: 30, legal_hold: false }
      );
    });
  });
  app.put('/v1/knowledge-retention', async (req) => {
    const p = await authenticate(db, req),
      input = z
        .object({ days: z.number().int().min(7).max(3650), legalHold: z.boolean() })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const role = await lockAdministrator(tx, p, 'workspace.manage');
      if (role !== 'owner')
        throw new AppError(
          403,
          'OWNER_REQUIRED',
          'Only a workspace owner may change knowledge retention.',
        );
      await tx.query(
        'INSERT INTO knowledge_retention(workspace_id,days,legal_hold) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET days=EXCLUDED.days,legal_hold=EXCLUDED.legal_hold',
        [p.workspaceId, input.days, input.legalHold],
      );
      await recordChange(tx, p, 'knowledge.retention_changed', p.workspaceId);
      return { ok: true };
    });
  });
}
