import type { Sql } from '@ao/database';
import { randomUUID } from 'node:crypto';
export async function escalateAutomation(
  tx: Sql,
  workspace: string,
  automation: string,
  occurrence: string,
  owner: string,
  recipient: string,
  conversation: string,
) {
  await tx.query(
    "INSERT INTO notifications(id,workspace_id,recipient_id,actor_id,conversation_id,resource_id,kind,delivery_version) SELECT $1,$2,m.id,$3,$4,$5,'automation_attention',1 FROM memberships m LEFT JOIN notification_preferences np ON np.workspace_id=m.workspace_id AND np.membership_id=m.id LEFT JOIN conversation_notification_preferences cp ON cp.workspace_id=m.workspace_id AND cp.membership_id=m.id AND cp.conversation_id=$4 WHERE m.workspace_id=$2 AND m.id=$6 AND m.status='active' AND m.kind='human' AND coalesce((m.permissions->>'execution.read')::boolean,true) AND coalesce(np.enabled,true) AND coalesce(np.approvals,true) AND coalesce(cp.mode,'default')<>'muted' AND resource_visible_to($2,$4,now(),m.id) ON CONFLICT DO NOTHING",
    [randomUUID(), workspace, owner, conversation, occurrence, recipient],
  );
  await tx.query(
    "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id,audience_membership_id,payload) SELECT $1,'automation.escalated',$2,$3,m.id,jsonb_build_object('automationId',$4::text) FROM memberships m WHERE m.workspace_id=$1 AND m.id=$5 AND m.status='active' AND coalesce((m.permissions->>'execution.read')::boolean,true) AND resource_visible_to($1,$3,now(),m.id)",
    [workspace, occurrence, conversation, automation, recipient],
  );
  await tx.query(
    "INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id) SELECT $1,'notification.created',n.id,n.recipient_id FROM notifications n WHERE n.workspace_id=$1 AND n.resource_id=$2 AND n.kind='automation_attention'",
    [workspace, occurrence],
  );
}
