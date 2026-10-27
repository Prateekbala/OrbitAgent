import { sendMessage } from '../messaging/send.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { channelInput, messageInput, id } from '@ao/contracts';
import { authenticate } from './auth.js';
import { requireConversation, requireAdmin, requireActiveMember } from '../lib/policy.js';
import { recordChange } from '../lib/events.js';
import { listMessages } from '../messaging/service.js';
import { AppError } from '../lib/errors.js';
import { hasPermission } from '../identity/authorization.js';
export function collaborationRoutes(app: FastifyInstance, db: Database) {
  app.get('/v1/bootstrap', async (req) => {
    const p = await authenticate(db, req);
    const [workspace] = await db.query(
      'SELECT id,name,(SELECT epoch::text FROM retrieval_authority WHERE workspace_id=$1) retrieval_epoch FROM workspaces WHERE id=$1',
      [p.workspaceId],
    );
    const members = await db.query(
      `SELECT id,name,kind,role,version FROM memberships WHERE workspace_id=$1 AND status='active' ORDER BY kind,name`,
      [p.workspaceId],
    );
    const channels = await db.query(
      `SELECT c.id,(SELECT history_interval.id FROM conversation_membership_intervals history_interval WHERE history_interval.workspace_id=c.workspace_id AND history_interval.conversation_id=c.id AND history_interval.membership_id=$2 AND history_interval.left_at IS NULL) access_interval_id,c.archived_at,c.history_policy,EXISTS(SELECT 1 FROM conversation_members own WHERE own.workspace_id=c.workspace_id AND own.conversation_id=c.id AND own.membership_id=$2) joined,CASE WHEN c.kind='direct' THEN (SELECT dm.name FROM memberships dm WHERE dm.workspace_id=c.workspace_id AND dm.id=CASE WHEN c.direct_low=$2 THEN c.direct_high ELSE c.direct_low END) WHEN c.kind='group' THEN c.title ELSE c.name END name,c.description,c.visibility,c.kind,c.title,c.version,CASE WHEN c.kind='direct' THEN CASE WHEN c.direct_low=$2 THEN c.direct_high ELSE c.direct_low END ELSE NULL END peer_id,
       (SELECT count(*)::int FROM messages um WHERE um.workspace_id=c.workspace_id AND um.conversation_id=c.id AND um.author_id<>$2 AND um.deleted_at IS NULL AND um.sequence>COALESCE((SELECT cr.last_sequence FROM conversation_reads cr WHERE cr.workspace_id=c.workspace_id AND cr.conversation_id=c.id AND cr.membership_id=$2 AND cr.thread_id IS NOT DISTINCT FROM um.thread_id),0)) unread_count
       FROM conversations c WHERE c.workspace_id=$1 AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.membership_id=$2)) ORDER BY c.name`,
      [p.workspaceId, p.membershipId],
    );
    return {
      workspace,
      me: {
        id: p.membershipId,
        name: p.name,
        kind: p.kind,
        role: p.role,
        version: members.find((member) => member.id === p.membershipId)?.version,
        access_type: p.accessType,
        permissions: p.permissions,
      },
      members: hasPermission(p, 'people.read')
        ? members
        : members.filter((m) => m.id === p.membershipId),
      channels: hasPermission(p, 'messages.read') ? channels : [],
    };
  });
  app.post('/v1/conversations', async (req, reply) => {
    const p = await authenticate(db, req);
    requireAdmin(p);
    const input = channelInput.parse(req.body),
      channelId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO conversations(id,workspace_id,name,description,visibility) VALUES($1,$2,$3,$4,$5)',
        [channelId, p.workspaceId, input.name, input.description, input.visibility],
      );
      await tx.query(
        'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id) VALUES($1,$2,$3)',
        [p.workspaceId, channelId, p.membershipId],
      );
      await recordChange(tx, p, 'conversation.created', channelId, channelId);
    });
    return reply.code(201).send({ id: channelId });
  });
  app.post('/v1/conversations/:id/members', async (req) => {
    const p = await authenticate(db, req);
    requireAdmin(p);
    const channel = id.parse((req.params as { id: string }).id);
    const input = z.object({ membershipId: id }).strict().parse(req.body);
    await requireConversation(db, p, channel);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      const [actor] = await tx.query(
        "SELECT role FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",
        [p.workspaceId, p.membershipId],
      );
      if (!actor || !['owner', 'admin'].includes(String(actor.role)))
        throw new AppError(403, 'FORBIDDEN', 'An administrator is required.');
      await requireConversation(tx, p, channel, true);
      const [conversation] = await tx.query(
        'SELECT kind FROM conversations WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, channel],
      );
      if (conversation?.kind !== 'channel')
        throw new AppError(
          400,
          'CHANNEL_REQUIRED',
          'Manage group participants through group details.',
        );
      await requireActiveMember(tx, p, input.membershipId);
      await tx.query(
        'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [p.workspaceId, channel, input.membershipId],
      );
      await recordChange(tx, p, 'conversation.member_added', input.membershipId, channel);
    });
    return { ok: true };
  });
  app.get('/v1/conversations/:id/messages', async (req) => {
    const p = await authenticate(db, req);
    const channel = id.parse((req.params as { id: string }).id);
    await requireConversation(db, p, channel);
    const query = z
      .object({
        threadId: id.optional(),
        around: id.optional(),
        before: z.coerce.number().int().positive().max(2147483647).optional(),
      })
      .refine(
        (value) => !value.before || !value.around,
        'Choose either before or around, not both.',
      )
      .parse(req.query);
    return listMessages(
      db,
      p,
      channel,
      query.threadId ?? null,
      query.before ?? null,
      query.around ?? null,
    );
  });
  app.get('/v1/conversations/:id/mentionable-members', async (req) => {
    const p = await authenticate(db, req),
      conversation = id.parse((req.params as { id: string }).id);
    await requireConversation(db, p, conversation);
    return db.query(
      `SELECT m.id,m.name,m.kind FROM memberships m JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=$2 WHERE m.workspace_id=$1 AND m.status='active' AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=m.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=m.id)) AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members viewer WHERE viewer.workspace_id=c.workspace_id AND viewer.conversation_id=c.id AND viewer.membership_id=$3)) ORDER BY m.name,m.id`,
      [p.workspaceId, conversation, p.membershipId],
    );
  });
  app.post('/v1/conversations/:id/messages', async (req, reply) => {
    const p = await authenticate(db, req);
    const channel = id.parse((req.params as { id: string }).id),
      input = messageInput.parse(req.body);
    await requireConversation(db, p, channel);
    const result = await db.transaction((tx) => sendMessage(tx, p, channel, input));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
