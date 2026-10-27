import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentInput, pageInput, id } from '@ao/contracts';
import { authenticate } from './auth.js';
import {
  requireAdmin,
  requireConversation,
  requireActiveMember,
  lockAdministrator,
} from '../lib/policy.js';
import { recordChange } from '../lib/events.js';
import { token, digest } from '../lib/security.js';
import { notFound } from '../lib/errors.js';
import { initializeAgent, fenceAgent } from '../agents/control.js';
export function workRoutes(app: FastifyInstance, db: Database) {
  app.get('/v1/agents', async (req) => {
    const p = await authenticate(db, req);
    return db.query(
      'SELECT a.id,a.membership_id,m.name,a.instructions,a.status,a.runtime,a.owner_id,a.version,a.revision,a.last_seen_at,a.created_at FROM agents a JOIN memberships m ON m.id=a.membership_id WHERE a.workspace_id=$1 ORDER BY a.created_at',
      [p.workspaceId],
    );
  });
  app.post('/v1/agents', async (req, reply) => {
    const p = await authenticate(db, req);
    requireAdmin(p);
    const input = agentInput.parse(req.body),
      agentId = randomUUID(),
      memberId = randomUUID(),
      key = input.runtime === 'external' ? token() : null;
    await db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      await tx.query(
        "INSERT INTO memberships(id,workspace_id,name,kind,role) VALUES($1,$2,$3,'agent','member')",
        [memberId, p.workspaceId, input.name],
      );
      await tx.query(
        'INSERT INTO agents(id,workspace_id,membership_id,instructions,key_hash,runtime,owner_id,credential_issuer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
        [
          agentId,
          p.workspaceId,
          memberId,
          input.role,
          key ? digest(key) : null,
          input.runtime,
          p.membershipId,
        ],
      );
      await initializeAgent(tx, p, agentId, input.role, key);
      await recordChange(tx, p, 'agent.created', agentId);
    });
    return reply.code(201).send({ id: agentId, ...(key ? { key } : {}) });
  });
  app.patch('/v1/agents/:id', async (req) => {
    const p = await authenticate(db, req);
    requireAdmin(p);
    const agentId = id.parse((req.params as { id: string }).id),
      input = z
        .object({ status: z.enum(['active', 'paused']) })
        .strict()
        .parse(req.body);
    await db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'agents.manage');
      if (input.status === 'paused') {
        await fenceAgent(tx, p.workspaceId, agentId);
        const runs = await tx.query(
          "SELECT id FROM agent_runs WHERE workspace_id=$1 AND agent_id=$2 AND status IN ('queued','running','awaiting_approval') ORDER BY id FOR UPDATE",
          [p.workspaceId, agentId],
        );
        for (const run of runs) {
          await tx.query(
            "UPDATE agent_runs SET status='cancelled',lease_token=NULL,updated_at=now() WHERE id=$1",
            [run.id],
          );
          await tx.query(
            "UPDATE tool_invocations SET status='cancelled' WHERE run_id=$1 AND status IN ('pending','approved')",
            [run.id],
          );
        }
      }
      const rows = await tx.query(
        "UPDATE agents SET status=$1,version=version+1 WHERE workspace_id=$2 AND id=$3 AND status<>'archived' RETURNING id",
        [input.status, p.workspaceId, agentId],
      );
      if (!rows.length) throw notFound();
      await recordChange(tx, p, 'agent.' + input.status, agentId);
    });
    return { ok: true };
  });
  app.get('/v1/knowledge', async (req) => {
    const p = await authenticate(db, req);
    return db.query(
      `SELECT k.*,m.name author_name FROM knowledge_pages k JOIN memberships m ON m.id=k.author_id WHERE k.workspace_id=$1 AND (k.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=k.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.membership_id=$2)))) ORDER BY k.updated_at DESC LIMIT 200`,
      [p.workspaceId, p.membershipId],
    );
  });
  app.post('/v1/knowledge', async (req, reply) => {
    const p = await authenticate(db, req),
      input = pageInput.parse(req.body),
      pageId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      await requireActiveMember(tx, p, p.membershipId);
      if (input.conversationId) await requireConversation(tx, p, input.conversationId, true);
      await tx.query(
        'INSERT INTO knowledge_pages(id,workspace_id,conversation_id,title,body,author_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          pageId,
          p.workspaceId,
          input.conversationId ?? null,
          input.title,
          input.body,
          p.membershipId,
        ],
      );
      await tx.query(
        'INSERT INTO knowledge_versions(id,page_id,title,body,version,author_id,workspace_id) VALUES($1,$2,$3,$4,1,$5,$6)',
        [randomUUID(), pageId, input.title, input.body, p.membershipId, p.workspaceId],
      );
      await tx.query('UPDATE knowledge_metadata SET kind=$3 WHERE workspace_id=$1 AND page_id=$2', [
        p.workspaceId,
        pageId,
        input.kind,
      ]);
      await recordChange(tx, p, 'knowledge.created', pageId, input.conversationId ?? null);
    });
    return reply.code(201).send({ id: pageId });
  });
  app.get('/v1/audit', async (req) => {
    const p = await authenticate(db, req);
    requireAdmin(p);
    return db.query(
      `SELECT e.id,e.action,m.name actor_name,e.created_at FROM audit_events e JOIN memberships m ON m.id=e.actor_id WHERE e.workspace_id=$1
      AND (e.audience_membership_id IS NULL OR e.audience_membership_id=$2)
      AND (e.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=e.workspace_id AND c.id=e.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2))))
      ORDER BY e.created_at DESC LIMIT 100`,
      [p.workspaceId, p.membershipId],
    );
  });
  app.get('/v1/search', async (req) => {
    const p = await authenticate(db, req);
    const { q } = z.object({ q: z.string().trim().min(2).max(200) }).parse(req.query);
    return db.query(
      `SELECT m.id,m.body,m.conversation_id,CASE WHEN c.kind='group' THEN c.title WHEN c.kind='direct' THEN (SELECT dm.name FROM memberships dm WHERE dm.workspace_id=c.workspace_id AND dm.id=CASE WHEN c.direct_low=$3 THEN c.direct_high ELSE c.direct_low END) ELSE c.name END channel_name,a.name author_name,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN memberships a ON a.id=m.author_id WHERE m.workspace_id=$1 AND m.deleted_at IS NULL AND to_tsvector('english',m.body) @@ plainto_tsquery('english',$2) AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.membership_id=$3)) ORDER BY m.created_at DESC LIMIT 50`,
      [p.workspaceId, q, p.membershipId],
    );
  });
}
