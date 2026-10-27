import { randomUUID } from 'node:crypto';
import type { Sql } from '@ao/database';
import type { z } from 'zod';
import type { messageContent } from '@ao/contracts/personal';
import { requireActiveMember, requireConversation, type Identity } from '../lib/policy.js';
import { requirePerson } from '../notifications/service.js';
import { AppError, notFound } from '../lib/errors.js';
import { hasPermission } from '../identity/authorization.js';

export async function personalAuthority(
  tx: Sql,
  p: Identity,
  conversation?: string,
  write = false,
  lock: 'share' | 'update' = 'share',
) {
  requirePerson(p);
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
  await requireActiveMember(tx, p, p.membershipId);
  if (conversation) {
    if (lock === 'update') {
      await tx.query('SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
        p.workspaceId,
        conversation,
      ]);
      await requireConversation(tx, p, conversation);
    } else await requireConversation(tx, p, conversation, true);
    if (write) {
      const [row] = await tx.query(
        'SELECT archived_at FROM conversations WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, conversation],
      );
      if (row?.archived_at)
        throw new AppError(
          409,
          'CHANNEL_ARCHIVED',
          'Restore the channel before composing messages.',
        );
    }
  }
  if (write && !hasPermission(p, 'messages.write'))
    throw new AppError(403, 'PERMISSION_DENIED', 'You cannot send messages.');
}
export async function contentReferences(
  tx: Sql,
  p: Identity,
  conversation: string,
  input: z.infer<typeof messageContent>,
) {
  if (input.threadId) {
    const [root] = await tx.query(
      'SELECT id FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND thread_id IS NULL',
      [p.workspaceId, conversation, input.threadId],
    );
    if (!root) throw notFound();
  }
  if (
    new Set(input.attachmentIds).size !== input.attachmentIds.length ||
    new Set(input.mentionIds).size !== input.mentionIds.length
  )
    throw new AppError(400, 'DUPLICATE_REFERENCE', 'Choose each attachment and mention once.');
  for (const file of [...input.attachmentIds].sort()) {
    const [row] = await tx.query(
      "SELECT id FROM files WHERE workspace_id=$1 AND id=$2 AND conversation_id=$3 AND uploader_id=$4 AND task_id IS NULL AND status='ready' AND expires_at>now() FOR UPDATE",
      [p.workspaceId, file, conversation, p.membershipId],
    );
    if (!row)
      throw new AppError(
        400,
        'INVALID_ATTACHMENT',
        'Choose ready files uploaded by you in this conversation.',
      );
  }
}
async function messageReference(tx: Sql, p: Identity, id: string) {
  await personalAuthority(tx, p);
  const [row] = await tx.query(
    'SELECT id,conversation_id,thread_id,deleted_at FROM messages WHERE workspace_id=$1 AND id=$2',
    [p.workspaceId, id],
  );
  if (!row || row.deleted_at) throw notFound();
  await requireConversation(tx, p, String(row.conversation_id), true);
  return row;
}
export async function setMessagePreference(
  tx: Sql,
  p: Identity,
  id: string,
  kind: 'save' | 'pin' | 'follow',
  enabled: boolean,
) {
  const message = await messageReference(tx, p, id);
  if (kind === 'pin') {
    if (p.accessType === 'guest' || !hasPermission(p, 'messages.write'))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'A full workspace member with message permission must manage pins.',
      );
    if (enabled)
      await tx.query(
        'INSERT INTO message_pins(workspace_id,conversation_id,message_id,pinned_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [p.workspaceId, message.conversation_id, id, p.membershipId],
      );
    else
      await tx.query('DELETE FROM message_pins WHERE workspace_id=$1 AND message_id=$2', [
        p.workspaceId,
        id,
      ]);
  } else if (kind === 'save') {
    if (enabled)
      await tx.query(
        'INSERT INTO saved_messages(workspace_id,membership_id,message_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [p.workspaceId, p.membershipId, id],
      );
    else
      await tx.query(
        'DELETE FROM saved_messages WHERE workspace_id=$1 AND membership_id=$2 AND message_id=$3',
        [p.workspaceId, p.membershipId, id],
      );
  } else
    await tx.query(
      'INSERT INTO thread_followers(workspace_id,membership_id,message_id,following) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,membership_id,message_id) DO UPDATE SET following=EXCLUDED.following',
      [p.workspaceId, p.membershipId, message.thread_id ?? id, enabled],
    );
  await tx.query(
    'INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id,audience_membership_id) VALUES($1,$2,$3,$4,$5)',
    [
      p.workspaceId,
      kind === 'pin' ? 'message.pin_changed' : 'personal.changed',
      id,
      message.conversation_id,
      kind === 'pin' ? null : p.membershipId,
    ],
  );
  return { ok: true };
}
export function futureSendTime(value: string) {
  const time = new Date(value);
  if (time.getTime() < Date.now() + 10000 || time.getTime() > Date.now() + 366 * 86400000)
    throw new AppError(
      400,
      'INVALID_SEND_TIME',
      'Schedule between ten seconds and one year from now.',
    );
  return time;
}
export function personalEvent(tx: Sql, p: Identity) {
  return tx.query(
    "INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id) VALUES($1,'personal.changed',$2,$3)",
    [p.workspaceId, randomUUID(), p.membershipId],
  );
}
