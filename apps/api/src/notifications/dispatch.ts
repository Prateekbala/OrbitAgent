import type { Sql } from '@ao/database';
import type { Identity } from '../lib/policy.js';

const accessible = `((c.visibility='public' AND r.access_type='member') OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=r.id))`;
const recipient = `JOIN memberships r ON r.workspace_id=c.workspace_id AND r.status='active' AND r.kind='human' AND r.id<>$2
 LEFT JOIN notification_preferences np ON np.workspace_id=r.workspace_id AND np.membership_id=r.id
 LEFT JOIN conversation_notification_preferences cp ON cp.workspace_id=r.workspace_id AND cp.membership_id=r.id AND cp.conversation_id=c.id`;
async function insert(
  tx: Sql,
  p: Identity,
  resource: string,
  conversation: string | null,
  candidates: string,
  versioned = false,
) {
  await tx.query(
    `WITH candidates AS (${candidates}), inserted AS (
    INSERT INTO notifications(id,workspace_id,recipient_id,actor_id,conversation_id,resource_id,kind,delivery_version)
    SELECT gen_random_uuid(),$1,recipient_id,$2,$4::uuid,$3,kind,${versioned ? 'delivery_version' : '0'} FROM candidates WHERE kind IS NOT NULL
    ON CONFLICT DO NOTHING RETURNING id,recipient_id
  ) INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id)
    SELECT $1,'notification.created',id,recipient_id FROM inserted`,
    [p.workspaceId, p.membershipId, resource, conversation],
  );
}
export async function dispatchNotifications(
  tx: Sql,
  p: Identity,
  type: string,
  resource: string,
  conversation: string | null,
) {
  if (
    type.startsWith('task.') &&
    type !== 'task.comment_created' &&
    !type.startsWith('task.schedule')
  ) {
    await insert(
      tx,
      p,
      resource,
      conversation,
      `SELECT r.id recipient_id,'task_activity' kind,t.version delivery_version FROM tasks t JOIN task_participants tp ON tp.workspace_id=t.workspace_id AND tp.task_id=t.id JOIN memberships r ON r.workspace_id=tp.workspace_id AND r.id=tp.membership_id AND r.status='active' AND r.kind='human' AND r.id<>$2 LEFT JOIN notification_preferences np ON np.workspace_id=r.workspace_id AND np.membership_id=r.id LEFT JOIN conversation_notification_preferences cp ON cp.workspace_id=r.workspace_id AND cp.membership_id=r.id AND cp.conversation_id=t.conversation_id WHERE t.workspace_id=$1 AND t.id=$3 AND resource_visible_to(t.workspace_id,t.conversation_id,t.created_at,r.id) AND coalesce(np.enabled,true) AND coalesce(np.tasks,true) AND coalesce(cp.mode,'default')<>'muted'`,
      true,
    );
  }
  if (type === 'message.created') {
    await insert(
      tx,
      p,
      resource,
      conversation,
      `SELECT r.id recipient_id,CASE
      WHEN COALESCE(cp.mode,'default')='muted' THEN NULL
      WHEN COALESCE(np.mentions,true) AND EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.workspace_id=m.workspace_id AND mm.message_id=m.id AND mm.membership_id=r.id) THEN 'mention'
      WHEN COALESCE(np.replies,true) AND m.thread_id IS NOT NULL AND (thread_following($1,m.thread_id,r.id)=true OR (thread_following($1,m.thread_id,r.id) IS NULL AND EXISTS(SELECT 1 FROM messages previous WHERE previous.workspace_id=m.workspace_id AND previous.conversation_id=m.conversation_id AND previous.author_id=r.id AND previous.deleted_at IS NULL AND previous.sequence<m.sequence AND (previous.id=m.thread_id OR previous.thread_id=m.thread_id)))) THEN 'reply'
      WHEN cp.mode='all' THEN 'message'
      WHEN COALESCE(cp.mode,'default')='default' AND ((c.kind='direct' AND COALESCE(np.direct_messages,true)) OR (c.kind='group' AND COALESCE(np.group_messages,true))) THEN 'message'
      ELSE NULL END kind
      FROM messages m JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id ${recipient}
      WHERE m.workspace_id=$1 AND m.id=$3 AND c.id=$4 AND m.deleted_at IS NULL AND COALESCE(np.enabled,true) AND ${accessible} AND message_visible_to(m.workspace_id,m.conversation_id,m.sequence,m.thread_id,r.id)`,
    );
  } else if (type === 'message.reaction_changed') {
    await insert(
      tx,
      p,
      resource,
      conversation,
      `SELECT r.id recipient_id,'reaction' kind FROM messages m JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id ${recipient}
      WHERE m.workspace_id=$1 AND m.id=$3 AND c.id=$4 AND m.author_id=r.id AND m.deleted_at IS NULL
      AND COALESCE(np.enabled,true) AND COALESCE(np.reactions,true) AND COALESCE(cp.mode,'default')<>'muted' AND ${accessible}
      AND EXISTS(SELECT 1 FROM message_reactions mr WHERE mr.workspace_id=m.workspace_id AND mr.message_id=m.id AND mr.membership_id=$2)`,
    );
  } else if (type === 'task.created' || type === 'task.assigned') {
    const [task] = await tx.query(
      'SELECT assignee_id,conversation_id FROM tasks WHERE workspace_id=$1 AND id=$2',
      [p.workspaceId, resource],
    );
    if (!task?.assignee_id || task.assignee_id === p.membershipId) return;
    await insert(
      tx,
      p,
      resource,
      task.conversation_id ? String(task.conversation_id) : null,
      `SELECT r.id recipient_id,'task_assigned' kind,(SELECT assignment_version FROM tasks WHERE workspace_id=$1 AND id=$3) delivery_version FROM memberships r
      LEFT JOIN notification_preferences np ON np.workspace_id=r.workspace_id AND np.membership_id=r.id
      LEFT JOIN conversation_notification_preferences cp ON cp.workspace_id=r.workspace_id AND cp.membership_id=r.id AND cp.conversation_id=$4::uuid
      WHERE r.workspace_id=$1 AND r.id=(SELECT assignee_id FROM tasks WHERE workspace_id=$1 AND id=$3) AND r.kind='human' AND r.status='active' AND r.id<>$2 AND COALESCE(np.enabled,true) AND COALESCE(np.tasks,true) AND COALESCE(cp.mode,'default')<>'muted'
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=$1 AND c.id=$4 AND ${accessible}))`,
      true,
    );
  } else if (type === 'task.comment_created') {
    await insert(
      tx,
      p,
      resource,
      conversation,
      `SELECT r.id recipient_id,'task_comment' kind FROM task_comments comment JOIN tasks task ON task.workspace_id=comment.workspace_id AND task.id=comment.task_id
      JOIN memberships r ON r.workspace_id=task.workspace_id AND r.kind='human' AND r.status='active' AND r.id<>$2
      LEFT JOIN notification_preferences np ON np.workspace_id=r.workspace_id AND np.membership_id=r.id
      LEFT JOIN conversation_notification_preferences cp ON cp.workspace_id=r.workspace_id AND cp.membership_id=r.id AND cp.conversation_id=task.conversation_id
      WHERE comment.workspace_id=$1 AND comment.id=$3 AND resource_visible_to(task.workspace_id,task.conversation_id,task.created_at,r.id) AND comment.deleted_at IS NULL AND COALESCE(np.enabled,true) AND COALESCE(np.tasks,true) AND COALESCE(cp.mode,'default')<>'muted'
      AND (r.id=task.assignee_id OR r.id=task.created_by OR EXISTS(SELECT 1 FROM task_participants tp WHERE tp.workspace_id=task.workspace_id AND tp.task_id=task.id AND tp.membership_id=r.id) OR EXISTS(SELECT 1 FROM task_comments previous WHERE previous.workspace_id=task.workspace_id AND previous.task_id=task.id AND previous.author_id=r.id AND previous.sequence<comment.sequence AND previous.deleted_at IS NULL))
      AND (task.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=task.workspace_id AND c.id=task.conversation_id AND ${accessible}))`,
    );
  } else if (type === 'approval.requested') {
    await insert(
      tx,
      p,
      resource,
      conversation,
      `SELECT r.id recipient_id,'approval_request' kind FROM conversations c ${recipient}
      WHERE c.workspace_id=$1 AND c.id=$4 AND r.role IN ('owner','admin') AND COALESCE(np.enabled,true) AND COALESCE(np.approvals,true) AND COALESCE(cp.mode,'default')<>'muted' AND ${accessible}`,
    );
  } else if (type === 'conversation.created' || type === 'conversation.member_added') {
    await insert(
      tx,
      p,
      resource,
      conversation,
      `SELECT r.id recipient_id,'group_added' kind,CASE WHEN c.kind='group' THEN c.version+${type === 'conversation.created' ? 0 : 1} ELSE 0 END delivery_version FROM conversations c ${recipient}
      WHERE c.workspace_id=$1 AND c.id=$4 AND c.kind<>'direct' AND COALESCE(np.enabled,true) AND COALESCE(np.group_messages,true) AND COALESCE(cp.mode,'default')<>'muted' AND ${accessible}
      AND EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=r.id)
      AND (${type === 'conversation.member_added' ? 'r.id=$3::uuid' : "c.kind='group' AND $3::uuid=c.id"})`,
      true,
    );
  }
}
