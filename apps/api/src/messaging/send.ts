import { randomUUID } from 'node:crypto';
import type { Sql } from '@ao/database';
import type { z } from 'zod';
import type { messageInput } from '@ao/contracts';
import { requireConversation, requireActiveMember, type Identity } from '../lib/policy.js';
import { attachFiles } from '../files/service.js';
import { storeMentions } from '../notifications/mentions.js';
import { recordChange } from '../lib/events.js';
import { digest } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
import { hasPermission } from '../identity/authorization.js';
export async function sendMessage(
  tx: Sql,
  p: Identity,
  channel: string,
  input: z.infer<typeof messageInput>,
) {
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
  const [conversation] = await tx.query(
    'SELECT id,kind,archived_at,history_policy FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [p.workspaceId, channel],
  );
  await requireActiveMember(tx, p, p.membershipId);
  await requireConversation(tx, p, channel);
  if (input.expectedAuthorId && input.expectedAuthorId !== p.membershipId)
    throw new AppError(
      409,
      'SENDING_IDENTITY_CHANGED',
      'Sign in to the account that queued this message.',
    );
  const [author] = await tx.query(
    'SELECT role,kind,access_type,permissions,version FROM memberships WHERE workspace_id=$1 AND id=$2',
    [p.workspaceId, p.membershipId],
  );
  if (
    input.expectedMembershipVersion !== undefined &&
    author?.version !== input.expectedMembershipVersion
  )
    throw new AppError(
      409,
      'SENDING_AUTHORITY_CHANGED',
      'Your membership changed. Review this queued message before sending a new request.',
    );
  if (input.expectedAccessInterval !== undefined) {
    const [interval] = await tx.query(
      'SELECT id FROM conversation_membership_intervals WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3 AND left_at IS NULL',
      [p.workspaceId, channel, p.membershipId],
    );
    if ((interval?.id ?? null) !== input.expectedAccessInterval)
      throw new AppError(
        409,
        'SENDING_AUTHORITY_CHANGED',
        'Your conversation grant changed. Review this queued message before sending a new request.',
      );
  }
  if (
    !author ||
    !hasPermission(
      {
        ...p,
        role: author.role as Identity['role'],
        accessType: author.access_type as NonNullable<Identity['accessType']>,
        permissions: author.permissions as NonNullable<Identity['permissions']>,
      },
      'messages.write',
    )
  )
    throw new AppError(403, 'PERMISSION_DENIED', 'You cannot send messages.');
  const [existing] = await tx.query(
    'SELECT id,creation_body_hash,creation_attachment_hash,creation_mention_hash,creation_format,conversation_id,thread_id FROM messages WHERE workspace_id=$1 AND author_id=$2 AND client_id=$3',
    [p.workspaceId, p.membershipId, input.clientId],
  );
  if (existing) {
    if (
      existing.creation_body_hash !== digest(input.body) ||
      existing.creation_format !== input.format ||
      existing.creation_attachment_hash !== digest(JSON.stringify(input.attachmentIds)) ||
      existing.creation_mention_hash !== digest(JSON.stringify(input.mentionIds)) ||
      existing.conversation_id !== channel ||
      existing.thread_id !== (input.threadId ?? null)
    )
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This request ID was already used for different content.',
      );
    return { id: existing.id, replayed: true };
  }
  if (conversation?.archived_at)
    throw new AppError(409, 'CHANNEL_ARCHIVED', 'Restore the channel before sending messages.');
  if (conversation?.history_policy === 'join_time') {
    const [joined] = await tx.query(
      'SELECT membership_id FROM conversation_members WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3',
      [p.workspaceId, channel, p.membershipId],
    );
    if (!joined)
      throw new AppError(
        403,
        'CHANNEL_JOIN_REQUIRED',
        'Join this channel before sending messages.',
      );
  }
  if (input.threadId) {
    const [root] = await tx.query(
      'SELECT id FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND thread_id IS NULL AND message_visible_to(workspace_id,conversation_id,sequence,thread_id,$4)',
      [p.workspaceId, channel, input.threadId, p.membershipId],
    );
    if (!root)
      throw new AppError(400, 'INVALID_THREAD', 'Choose a root message from this channel.');
  }
  const [counter] = await tx.query(
    'UPDATE conversations SET next_sequence=next_sequence+1 WHERE workspace_id=$1 AND id=$2 RETURNING next_sequence',
    [p.workspaceId, channel],
  );
  const messageId = randomUUID();
  await tx.query(
    'INSERT INTO messages(id,workspace_id,conversation_id,author_id,body,client_id,thread_id,sequence,creation_attachment_hash,creation_mention_hash,format,creation_format) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)',
    [
      messageId,
      p.workspaceId,
      channel,
      p.membershipId,
      input.body,
      input.clientId,
      input.threadId ?? null,
      counter!.next_sequence,
      digest(JSON.stringify(input.attachmentIds)),
      digest(JSON.stringify(input.mentionIds)),
      input.format,
    ],
  );
  await attachFiles(tx, p, channel, messageId, input.attachmentIds);
  await storeMentions(tx, p, channel, messageId, input.body, input.mentionIds, input.format);
  await recordChange(tx, p, 'message.created', messageId, channel);
  if (p.kind === 'human') {
    const agents = await tx.query(
      "SELECT a.id FROM agents a JOIN memberships m ON m.id=a.membership_id WHERE a.workspace_id=$1 AND shared_agent_allowed(a.workspace_id,$2) AND a.status='active' AND m.status='active' AND (EXISTS(SELECT 1 FROM conversations c WHERE c.id=$2 AND c.visibility='public') OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=$2 AND cm.membership_id=a.membership_id)) AND (EXISTS(SELECT 1 FROM conversations c WHERE c.id=$2 AND c.kind='direct') OR EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.workspace_id=a.workspace_id AND mm.message_id=$3 AND mm.membership_id=a.membership_id))",
      [p.workspaceId, channel, messageId],
    );
    for (const agent of agents) {
      await tx.query(
        'INSERT INTO agent_inbox(id,workspace_id,agent_id,message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [randomUUID(), p.workspaceId, agent.id, messageId],
      );
    }
  }
  return { id: messageId, replayed: false };
}
