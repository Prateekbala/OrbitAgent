import { storeMentions } from '../notifications/mentions.js';
import { dispatchNotifications } from '../notifications/dispatch.js';
import { randomUUID } from 'node:crypto';
import type { Sql } from '@ao/database';
import type { Identity } from './policy.js';
export async function recordChange(
  tx: Sql,
  identity: Identity,
  type: string,
  resourceId: string,
  conversationId: string | null = null,
  audienceMembershipId: string | null = null,
) {
  const [outbox] = await tx.query(
    "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id,audience_membership_id,actor_id,origin_automation_id) VALUES($1,$2,$3,$4,$5,$6,nullif(current_setting('ao.automation_id',true),'')::uuid) RETURNING id",
    [
      identity.workspaceId,
      type,
      resourceId,
      conversationId,
      audienceMembershipId,
      identity.membershipId,
    ],
  );
  await tx.query(
    'INSERT INTO audit_events(id,workspace_id,actor_id,action,resource_id,conversation_id,audience_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      randomUUID(),
      identity.workspaceId,
      identity.membershipId,
      type,
      resourceId,
      conversationId,
      audienceMembershipId,
    ],
  );
  if (type === 'message.created' && identity.kind === 'agent' && conversationId) {
    const [message] = await tx.query('SELECT body FROM messages WHERE workspace_id=$1 AND id=$2', [
      identity.workspaceId,
      resourceId,
    ]);
    if (message)
      await storeMentions(tx, identity, conversationId, resourceId, String(message.body), []);
  }
  if (
    ['task.created', 'task.updated', 'task.transitioned', 'task.comment_created'].includes(type)
  ) {
    await tx.query(
      `INSERT INTO workflow_events(id,workspace_id,task_id,conversation_id,event_type,task_version,state,origin_run_id,created_by)
       SELECT gen_random_uuid(),t.workspace_id,t.id,t.conversation_id,$3,t.version,t.state,nullif(current_setting('ao.workflow_run_id',true),'')::uuid,$4 FROM tasks t WHERE t.workspace_id=$1 AND t.id=CASE WHEN $3='task.comment_created' THEN (SELECT task_id FROM task_comments WHERE workspace_id=$1 AND id=$2) ELSE $2::uuid END`,
      [identity.workspaceId, resourceId, type, identity.membershipId],
    );
  }
  if (outbox)
    await tx.query('SELECT publish_shared_activity($1,$2)', [identity.workspaceId, outbox.id]);
  if (
    outbox &&
    ['message.created', 'message.edited', 'message.deleted', 'message.reaction_changed'].includes(
      type,
    ) &&
    identity.accessType !== 'guest'
  )
    await tx.query(
      'SELECT queue_migration_delivery($1,$2) WHERE NOT EXISTS(SELECT 1 FROM shared_channel_grants_access($1,$3) policy WHERE NOT policy.export_allowed) AND member_external_attribution($1,$4) IS NULL',
      [identity.workspaceId, outbox.id, conversationId, identity.membershipId],
    );
  if (!['migration.message_imported'].includes(type))
    await dispatchNotifications(tx, identity, type, resourceId, conversationId);
}
