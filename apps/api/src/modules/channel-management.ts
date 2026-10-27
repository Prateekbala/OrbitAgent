import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import { id } from '@ao/contracts';
import { channelManagement, historyProposalInput, personalListQuery } from '@ao/contracts/personal';
import { authenticate } from './auth.js';
import { AppError, notFound } from '../lib/errors.js';
import { requireAdmin, requireActiveMember, requireConversation } from '../lib/policy.js';
import { recordChange } from '../lib/events.js';
import {
  lockConversationChange,
  fenceConversationRuns,
  groupOwner,
  grantConsentedHistory,
} from '../conversations/management.js';
import { pageBoundary, pageResult } from '../messaging/pagination.js';
export function channelManagementRoutes(app: FastifyInstance, db: Database) {
  app.get('/v1/channels/discover', async (req) => {
    const p = await authenticate(db, req),
      q = personalListQuery
        .extend({
          q: z.string().trim().max(100).default(''),
          archived: z.enum(['true', 'false']).default('false'),
        })
        .parse(req.query),
      scope = 'discovery:' + q.q + ':' + q.archived,
      b = pageBoundary(p, scope, q.after);
    if (p.accessType === 'service')
      throw new AppError(
        403,
        'HUMAN_REQUIRED',
        'Service accounts use their explicit conversation grants.',
      );
    const rows = await db.query(
      `SELECT c.id,c.name,c.description,c.archived_at,c.version,c.history_policy,c.created_at,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') position_time,c.visibility,EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2) joined FROM conversations c WHERE c.workspace_id=$1 AND c.kind='channel' AND (c.archived_at IS NOT NULL)=$3 AND (c.name ILIKE $4 OR c.description ILIKE $4) AND ((c.visibility='public' AND $5='member') OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2)) AND ($6::timestamptz IS NULL OR (c.created_at,c.id)<($6::timestamptz,$7::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT $8`,
      [
        p.workspaceId,
        p.membershipId,
        q.archived === 'true',
        '%' + q.q.replace(/[\\%_]/g, '\\$&') + '%',
        p.accessType ?? 'member',
        b?.at ?? null,
        b?.id ?? null,
        q.limit + 1,
      ],
    );
    return pageResult(p, scope, rows, q.limit);
  });
  app.patch('/v1/conversations/:id/channel', async (req) => {
    const p = await authenticate(db, req),
      conversation = id.parse((req.params as { id: string }).id),
      input = channelManagement.parse(req.body);
    requireAdmin(p);
    return db.transaction(async (tx) => {
      const { conversation: current, runs } = await lockConversationChange(tx, p, conversation);
      const [actor] = await tx.query(
        "SELECT role FROM memberships WHERE workspace_id=$1 AND id=$2 AND kind='human' AND status='active' AND access_type='member'",
        [p.workspaceId, p.membershipId],
      );
      if (!actor || !['owner', 'admin'].includes(String(actor.role)))
        throw new AppError(403, 'FORBIDDEN', 'A current administrator must manage channels.');
      if (current.kind !== 'channel')
        throw new AppError(400, 'CHANNEL_REQUIRED', 'Choose a channel.');
      if (current.version !== input.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'This channel changed. Reload its details.');
      await tx.query(
        'UPDATE conversations SET name=coalesce($3,name),description=coalesce($4,description),history_policy=coalesce($5,history_policy),archived_at=CASE WHEN $6::boolean IS NULL THEN archived_at WHEN $6 THEN coalesce(archived_at,now()) ELSE NULL END,archived_by=CASE WHEN $6::boolean IS NULL THEN archived_by WHEN $6 THEN $7 ELSE NULL END,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [
          p.workspaceId,
          conversation,
          input.name ?? null,
          input.description ?? null,
          input.historyPolicy ?? null,
          input.archived ?? null,
          p.membershipId,
        ],
      );
      await fenceConversationRuns(tx, runs);
      await recordChange(
        tx,
        p,
        input.archived === true
          ? 'conversation.archived'
          : input.archived === false
            ? 'conversation.restored'
            : 'conversation.updated',
        conversation,
        conversation,
      );
      return { ok: true };
    });
  });
  for (const method of ['PUT', 'DELETE'] as const)
    app.route({
      method,
      url: '/v1/conversations/:id/join',
      handler: async (req) => {
        const p = await authenticate(db, req),
          conversation = id.parse((req.params as { id: string }).id);
        if (p.kind !== 'human' || p.accessType !== 'member')
          throw new AppError(
            403,
            'FULL_MEMBER_REQUIRED',
            'Full workspace members can join public channels.',
          );
        return db.transaction(async (tx) => {
          const { conversation: current } = await lockConversationChange(tx, p, conversation);
          if (current.kind !== 'channel' || current.visibility !== 'public')
            throw new AppError(
              400,
              'PUBLIC_CHANNEL_REQUIRED',
              'Public channels support self-service joining.',
            );
          if (current.archived_at)
            throw new AppError(409, 'CHANNEL_ARCHIVED', 'Restore the channel before joining it.');
          if (method === 'PUT')
            await tx.query(
              'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
              [p.workspaceId, conversation, p.membershipId],
            );
          else
            await tx.query(
              'DELETE FROM conversation_members WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3',
              [p.workspaceId, conversation, p.membershipId],
            );
          await recordChange(tx, p, 'conversation.updated', conversation, conversation);
          return { ok: true };
        });
      },
    });
  app.get('/v1/conversations/:id/history-proposals', async (req) => {
    const p = await authenticate(db, req),
      conversation = id.parse((req.params as { id: string }).id),
      query = personalListQuery.parse(req.query),
      scope = 'history-proposals:' + conversation,
      b = pageBoundary(p, scope, query.after);
    await requireConversation(db, p, conversation);
    const rows = await db.query(
      "SELECT h.id,h.created_at,to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') position_time,h.target_id,m.name target_name,h.requested_by,h.base_version,CASE WHEN h.status='pending' AND (h.expires_at<=now() OR h.base_version<>c.version) THEN 'expired' ELSE h.status END status,h.expires_at,cardinality(h.voters) required,(SELECT count(*)::int FROM group_history_votes v WHERE v.workspace_id=h.workspace_id AND v.proposal_id=h.id AND v.decision='approve') approved,(SELECT decision FROM group_history_votes v WHERE v.workspace_id=h.workspace_id AND v.proposal_id=h.id AND v.membership_id=$3) my_decision FROM group_history_proposals h JOIN conversations c ON c.workspace_id=h.workspace_id AND c.id=h.conversation_id JOIN memberships m ON m.workspace_id=h.workspace_id AND m.id=h.target_id WHERE h.workspace_id=$1 AND h.conversation_id=$2 AND $3=ANY(h.voters) AND ($4::timestamptz IS NULL OR (h.created_at,h.id)<($4::timestamptz,$5::uuid)) ORDER BY h.created_at DESC,h.id DESC LIMIT $6",
      [p.workspaceId, conversation, p.membershipId, b?.at ?? null, b?.id ?? null, query.limit + 1],
    );
    return pageResult(p, scope, rows, query.limit);
  });
  app.post('/v1/conversations/:id/history-proposals', async (req, reply) => {
    const p = await authenticate(db, req),
      conversation = id.parse((req.params as { id: string }).id),
      input = historyProposalInput.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const { conversation: current, runs } = await lockConversationChange(tx, p, conversation);
      if (current.kind !== 'group' || current.archived_at)
        throw new AppError(400, 'GROUP_REQUIRED', 'Choose an active private group.');
      await groupOwner(tx, p, conversation);
      if (current.version !== input.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'The group changed. Reload its details.');
      await requireActiveMember(tx, p, input.membershipId);
      const participants = await tx.query(
        'SELECT cm.membership_id,m.kind,m.status FROM conversation_members cm JOIN memberships m ON m.workspace_id=cm.workspace_id AND m.id=cm.membership_id WHERE cm.workspace_id=$1 AND cm.conversation_id=$2 ORDER BY cm.membership_id',
        [p.workspaceId, conversation],
      );
      if (participants.some((m) => m.membership_id === input.membershipId))
        throw new AppError(409, 'ALREADY_PARTICIPANT', 'This person is already in the group.');
      if (participants.length >= 50)
        throw new AppError(409, 'GROUP_FULL', 'Groups support up to 50 participants.');
      await tx.query(
        "UPDATE group_history_proposals SET status='expired' WHERE workspace_id=$1 AND conversation_id=$2 AND status='pending' AND (expires_at<=now() OR base_version<>$3)",
        [p.workspaceId, conversation, current.version],
      );
      const [pending] = await tx.query(
        "SELECT id FROM group_history_proposals WHERE workspace_id=$1 AND conversation_id=$2 AND target_id=$3 AND base_version=$4 AND status='pending'",
        [p.workspaceId, conversation, input.membershipId, current.version],
      );
      if (pending)
        throw new AppError(
          409,
          'HISTORY_CONSENT_PENDING',
          'A consent request for this person is already pending.',
        );
      const voters = participants
          .filter((m) => m.kind === 'human' && m.status === 'active')
          .map((m) => m.membership_id),
        proposal = randomUUID();
      const [row] = await tx.query(
        'INSERT INTO group_history_proposals(id,workspace_id,conversation_id,target_id,requested_by,base_version,voters) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [
          proposal,
          p.workspaceId,
          conversation,
          input.membershipId,
          p.membershipId,
          input.version,
          voters,
        ],
      );
      await tx.query(
        "INSERT INTO group_history_votes(workspace_id,proposal_id,membership_id,decision) VALUES($1,$2,$3,'approve')",
        [p.workspaceId, proposal, p.membershipId],
      );
      const accepted = await grantConsentedHistory(tx, p, row!, current, runs);
      await recordChange(tx, p, 'conversation.consent_requested', proposal, conversation);
      return { id: proposal, accepted };
    });
    return reply.code(201).send(result);
  });
  app.put('/v1/conversations/:id/history-proposals/:proposal/vote', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id, proposal: id }).parse(req.params),
      input = z
        .object({ decision: z.enum(['approve', 'reject']) })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const { conversation, runs } = await lockConversationChange(tx, p, params.id);
      const [proposal] = await tx.query(
        "SELECT * FROM group_history_proposals WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND status='pending' FOR UPDATE",
        [p.workspaceId, params.id, params.proposal],
      );
      if (!proposal) throw notFound();
      if (!(proposal.voters as string[]).includes(p.membershipId)) throw notFound();
      if (
        conversation.version !== proposal.base_version ||
        new Date(String(proposal.expires_at)).getTime() <= Date.now()
      )
        throw new AppError(409, 'CONSENT_EXPIRED', 'The group changed or this request expired.');
      await tx.query(
        'INSERT INTO group_history_votes(workspace_id,proposal_id,membership_id,decision) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,proposal_id,membership_id) DO UPDATE SET decision=EXCLUDED.decision',
        [p.workspaceId, proposal.id, p.membershipId, input.decision],
      );
      let accepted = false;
      if (input.decision === 'reject')
        await tx.query(
          "UPDATE group_history_proposals SET status='rejected' WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, proposal.id],
        );
      else accepted = await grantConsentedHistory(tx, p, proposal, conversation, runs);
      await recordChange(tx, p, 'conversation.consent_updated', String(proposal.id), params.id);
      return { ok: true, accepted };
    });
  });
}
