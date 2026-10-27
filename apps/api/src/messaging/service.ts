import { notificationChanged } from '../notifications/service.js';
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { requireConversation, type Identity } from '../lib/policy.js';
import { storeMentions } from '../notifications/mentions.js';

async function currentMember(tx: Sql, p: Identity) {
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
  const [member] = await tx.query(
    "SELECT role,kind FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",
    [p.workspaceId, p.membershipId],
  );
  if (!member) throw new AppError(403, 'FORBIDDEN', 'Active workspace membership is required.');
  return member;
}
export class MessageService {
  constructor(private readonly db: Database) {}
  private async message(tx: Sql, p: Identity, messageId: string) {
    const member = await currentMember(tx, p);
    const [reference] = await tx.query(
      'SELECT conversation_id FROM messages WHERE workspace_id=$1 AND id=$2',
      [p.workspaceId, messageId],
    );
    if (!reference) throw notFound();
    await requireConversation(tx, p, String(reference.conversation_id), true);
    const [message] = await tx.query(
      'SELECT id,author_id,conversation_id,body,format,version,deleted_at,sequence,thread_id FROM messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [p.workspaceId, messageId],
    );
    if (!message) throw notFound();
    await requireConversation(tx, p, String(message.conversation_id));
    return { message, member };
  }
  async edit(
    p: Identity,
    messageId: string,
    input: { body: string; version: number; format?: 'plain' | 'markdown' | undefined },
  ) {
    return this.db.transaction(async (tx) => {
      const { message } = await this.message(tx, p, messageId);
      const [conversation] = await tx.query(
        'SELECT archived_at FROM conversations WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, message.conversation_id],
      );
      if (conversation?.archived_at)
        throw new AppError(
          409,
          'CHANNEL_ARCHIVED',
          'Restore this channel before editing messages.',
        );
      if (message.author_id !== p.membershipId)
        throw new AppError(403, 'FORBIDDEN', 'Only the author can edit this message.');
      if (message.deleted_at)
        throw new AppError(410, 'MESSAGE_DELETED', 'This message was deleted.');
      if (message.version !== input.version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'This message changed. Reload it before editing.',
        );
      if (!input.body) {
        const [attachment] = await tx.query(
          'SELECT file_id FROM message_attachments WHERE workspace_id=$1 AND message_id=$2 LIMIT 1',
          [p.workspaceId, messageId],
        );
        if (!attachment)
          throw new AppError(400, 'EMPTY_MESSAGE', 'Keep text or a file in this message.');
      }
      if (message.body === input.body && (!input.format || message.format === input.format))
        return { ok: true, version: message.version };
      await tx.query('DELETE FROM message_mentions WHERE workspace_id=$1 AND message_id=$2', [
        p.workspaceId,
        messageId,
      ]);
      await storeMentions(
        tx,
        p,
        String(message.conversation_id),
        messageId,
        input.body,
        [],
        input.format ?? (message.format as 'plain' | 'markdown'),
      );
      const [updated] = await tx.query(
        'UPDATE messages SET body=$3,format=coalesce($4,format),version=version+1,edited_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING version',
        [p.workspaceId, messageId, input.body, input.format ?? null],
      );
      await recordChange(tx, p, 'message.edited', messageId, String(message.conversation_id));
      return { ok: true, version: updated!.version };
    });
  }
  async delete(p: Identity, messageId: string, version: number) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const { message, member } = await this.message(tx, p, messageId);
      if (
        message.author_id !== p.membershipId &&
        !(member.kind === 'human' && ['admin', 'owner'].includes(String(member.role)))
      )
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the author or an administrator can delete this message.',
        );
      if (message.deleted_at) return { ok: true, version: message.version };
      if (message.version !== version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'This message changed. Reload it before deleting.',
        );
      const linked = await tx.query(
        "SELECT r.id,r.conversation_id FROM agent_runs r JOIN agent_inbox i ON i.workspace_id=r.workspace_id AND i.run_id=r.id WHERE i.workspace_id=$1 AND i.message_id=$2 AND r.status IN ('queued','running','awaiting_approval','outcome_unknown') ORDER BY r.id FOR UPDATE OF r",
        [p.workspaceId, messageId],
      );
      for (const run of linked) {
        await tx.query(
          "UPDATE agent_runs SET status='cancelled',prompt=CASE WHEN dispatch_started THEN prompt ELSE '[Source message deleted]' END,lease_token=NULL,lease_expires_at=NULL,error_code='SOURCE_DELETED',updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, run.id],
        );
        await tx.query(
          "UPDATE tool_invocations SET status='cancelled' WHERE workspace_id=$1 AND run_id=$2 AND status IN ('pending','approved')",
          [p.workspaceId, run.id],
        );
        await recordChange(tx, p, 'run.cancelled', String(run.id), String(run.conversation_id));
      }
      await tx.query(
        "UPDATE agent_inbox SET state='expired',expires_at=least(expires_at,now()),lease_token=NULL,lease_expires_at=NULL,fence=fence+1,summary='Source message deleted' WHERE workspace_id=$1 AND message_id=$2 AND state IN ('pending','leased')",
        [p.workspaceId, messageId],
      );
      const [updated] = await tx.query(
        "UPDATE messages SET body='',deleted_at=now(),deleted_by=$3,version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING version",
        [p.workspaceId, messageId, p.membershipId],
      );
      await tx.query('DELETE FROM message_reactions WHERE workspace_id=$1 AND message_id=$2', [
        p.workspaceId,
        messageId,
      ]);
      await tx.query(
        "UPDATE files SET status='deleting',cleanup_after=now()+interval '5 minutes' WHERE workspace_id=$1 AND id IN (SELECT file_id FROM message_attachments WHERE workspace_id=$1 AND message_id=$2)",
        [p.workspaceId, messageId],
      );
      await recordChange(tx, p, 'message.deleted', messageId, String(message.conversation_id));
      return { ok: true, version: updated!.version };
    });
  }
  async react(p: Identity, messageId: string, emoji: string, remove: boolean) {
    return this.db.transaction(async (tx) => {
      const { message } = await this.message(tx, p, messageId);
      if (message.deleted_at)
        throw new AppError(410, 'MESSAGE_DELETED', 'This message was deleted.');
      const changed = remove
        ? await tx.query(
            'DELETE FROM message_reactions WHERE workspace_id=$1 AND message_id=$2 AND membership_id=$3 AND emoji=$4 RETURNING message_id',
            [p.workspaceId, messageId, p.membershipId, emoji],
          )
        : await tx.query(
            'INSERT INTO message_reactions(workspace_id,conversation_id,message_id,membership_id,emoji) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING message_id',
            [p.workspaceId, message.conversation_id, messageId, p.membershipId, emoji],
          );
      if (changed.length)
        await recordChange(
          tx,
          p,
          'message.reaction_changed',
          messageId,
          String(message.conversation_id),
        );
      return { ok: true };
    });
  }
  async read(p: Identity, channel: string, messageId: string) {
    return this.db.transaction(async (tx) => {
      const member = await currentMember(tx, p);
      if (member.kind !== 'human')
        throw new AppError(403, 'HUMAN_REQUIRED', 'Read receipts require a human member.');
      await requireConversation(tx, p, channel, true);
      const [message] = await tx.query(
        'SELECT sequence,thread_id FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3',
        [p.workspaceId, channel, messageId],
      );
      if (!message) throw notFound();
      const changed = await tx.query(
        `INSERT INTO conversation_reads(id,workspace_id,conversation_id,membership_id,thread_id,last_message_id,last_sequence) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT ON CONSTRAINT conversation_reads_scope DO UPDATE SET last_sequence=EXCLUDED.last_sequence,last_message_id=EXCLUDED.last_message_id,updated_at=now()
        WHERE conversation_reads.last_sequence<EXCLUDED.last_sequence RETURNING last_sequence`,
        [
          randomUUID(),
          p.workspaceId,
          channel,
          p.membershipId,
          message.thread_id,
          messageId,
          message.sequence,
        ],
      );
      const acknowledged = await tx.query(
        `UPDATE notifications SET read_at=now() WHERE workspace_id=$1 AND recipient_id=$2 AND conversation_id=$3 AND kind IN ('message','mention','reply') AND read_at IS NULL AND resource_id IN (SELECT id FROM messages WHERE workspace_id=$1 AND conversation_id=$3 AND thread_id IS NOT DISTINCT FROM $4::uuid AND sequence<=$5) RETURNING id`,
        [p.workspaceId, p.membershipId, channel, message.thread_id, message.sequence],
      );
      if (acknowledged.length) await notificationChanged(tx, p, p.membershipId);
      if (changed.length) await recordChange(tx, p, 'conversation.read', p.membershipId, channel);
      return { ok: true };
    });
  }
}

export async function listMessages(
  db: Sql,
  p: Identity,
  channel: string,
  thread: string | null,
  before: number | null,
  around: string | null = null,
  options: { after?: number; limit?: number } = {},
) {
  await requireConversation(db, p, channel);
  let anchor: number | null = null;
  if (around) {
    const [row] = await db.query(
      'SELECT sequence FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND thread_id IS NOT DISTINCT FROM $3::uuid AND id=$4',
      [p.workspaceId, channel, thread, around],
    );
    if (!row) throw notFound();
    anchor = Number(row.sequence);
  }
  return db.query(
    `WITH candidates AS NOT MATERIALIZED (
      SELECT * FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND thread_id IS NOT DISTINCT FROM $3::uuid AND ($4::integer IS NULL OR sequence<$4) AND ($7::integer IS NULL OR sequence>$7)
      AND EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=$1 AND c.id=$2 AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=$1 AND cm.conversation_id=$2 AND cm.membership_id=$5)))
    ), selected AS (
      (SELECT * FROM candidates WHERE $6::integer IS NULL ORDER BY CASE WHEN $7::integer IS NOT NULL THEN sequence END ASC,sequence DESC LIMIT $8)
      UNION ALL (SELECT * FROM candidates WHERE $6::integer IS NOT NULL AND sequence<=$6 ORDER BY sequence DESC LIMIT (($8+1)/2))
      UNION ALL (SELECT * FROM candidates WHERE $6::integer IS NOT NULL AND sequence>$6 ORDER BY sequence ASC LIMIT ($8/2))
    ) SELECT m.id,m.body,m.format,m.author_id,coalesce(m.source_attribution->>'authorName',a.name) author_name,a.kind author_kind,m.source_attribution,member_external_attribution(m.workspace_id,m.author_id) external_organization,m.sequence,m.created_at,m.thread_id,m.version,m.edited_at,m.deleted_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'size',f.size,'content_type',f.content_type,'has_preview',f.preview_key IS NOT NULL) ORDER BY a.ordinal) FROM message_attachments a JOIN files f ON f.workspace_id=a.workspace_id AND f.id=a.file_id WHERE a.workspace_id=m.workspace_id AND a.message_id=m.id AND f.status='attached' AND m.deleted_at IS NULL),'[]'::jsonb) attachments,
    (SELECT count(*)::int FROM messages r WHERE r.workspace_id=m.workspace_id AND r.thread_id=m.id) reply_count,
    EXISTS(SELECT 1 FROM message_pins pin WHERE pin.workspace_id=m.workspace_id AND pin.message_id=m.id) pinned,EXISTS(SELECT 1 FROM saved_messages saved WHERE saved.workspace_id=m.workspace_id AND saved.message_id=m.id AND saved.membership_id=$5) saved,COALESCE((SELECT following FROM thread_followers follow WHERE follow.workspace_id=m.workspace_id AND follow.message_id=coalesce(m.thread_id,m.id) AND follow.membership_id=$5),EXISTS(SELECT 1 FROM messages participation WHERE participation.workspace_id=m.workspace_id AND participation.author_id=$5 AND participation.deleted_at IS NULL AND (participation.id=coalesce(m.thread_id,m.id) OR participation.thread_id=coalesce(m.thread_id,m.id)))) following,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',mentioned.id,'name',mentioned.name,'kind',mentioned.kind)) FROM message_mentions mm JOIN memberships mentioned ON mentioned.workspace_id=mm.workspace_id AND mentioned.id=mm.membership_id WHERE mm.workspace_id=m.workspace_id AND mm.message_id=m.id),'[]'::jsonb) mentions,COALESCE(reactions.items,'[]'::jsonb) reactions,COALESCE(readers.items,'[]'::jsonb) read_by,COALESCE(readers.total,0)::int read_count
    FROM selected m
    JOIN memberships a ON a.workspace_id=m.workspace_id AND a.id=m.author_id
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('emoji',emoji,'count',total,'reacted',reacted) ORDER BY emoji) items FROM
      (SELECT r.emoji,count(*)::int total,bool_or(r.membership_id=$5) reacted FROM message_reactions r JOIN memberships rm ON rm.workspace_id=r.workspace_id AND rm.id=r.membership_id AND rm.status='active'
       WHERE r.workspace_id=m.workspace_id AND r.message_id=m.id AND m.deleted_at IS NULL GROUP BY r.emoji) grouped) reactions ON true
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('membership_id',membership_id,'name',name) ORDER BY name,membership_id) items,max(total) total FROM
      (SELECT r.membership_id,rm.name,count(*) OVER() total FROM conversation_reads r JOIN memberships rm ON rm.workspace_id=r.workspace_id AND rm.id=r.membership_id AND rm.status='active' AND rm.kind='human'
       WHERE r.workspace_id=m.workspace_id AND r.conversation_id=m.conversation_id AND r.thread_id IS NOT DISTINCT FROM m.thread_id AND r.last_sequence>=m.sequence AND r.membership_id<>m.author_id AND m.deleted_at IS NULL
       ORDER BY rm.name,r.membership_id LIMIT 20) seen) readers ON true
    ORDER BY m.sequence DESC`,
    [
      p.workspaceId,
      channel,
      thread,
      before,
      p.membershipId,
      anchor,
      options.after ?? null,
      options.limit ?? 100,
    ],
  );
}
