import type { z } from 'zod';
import type { Database, Sql } from '@ao/database';
import type { notificationPreferenceUpdate } from '@ao/contracts';
import { defaultNotificationPreferences } from '@ao/contracts';
import type { Identity } from '../lib/policy.js';
import { requireActiveMember, requireConversation } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
export function requirePerson(p: Identity) {
  if (p.kind !== 'human')
    throw new AppError(403, 'HUMAN_REQUIRED', 'This feature requires a human workspace member.');
}
export async function notificationChanged(
  tx: Sql,
  p: Identity,
  resource: string,
  type = 'notification.read_changed',
) {
  await tx.query(
    'INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id) VALUES($1,$2,$3,$4)',
    [p.workspaceId, type, resource, p.membershipId],
  );
}
export const notificationVisible = `FROM notifications n
 JOIN memberships recipient ON recipient.workspace_id=n.workspace_id AND recipient.id=n.recipient_id AND recipient.status='active' AND recipient.kind='human'
 JOIN memberships actor ON actor.workspace_id=n.workspace_id AND actor.id=n.actor_id
 LEFT JOIN conversations c ON c.workspace_id=n.workspace_id AND c.id=n.conversation_id
 LEFT JOIN messages m ON m.workspace_id=n.workspace_id AND m.id=n.resource_id AND n.kind IN ('message','mention','reply','reaction')
 LEFT JOIN task_comments task_comment ON task_comment.workspace_id=n.workspace_id AND task_comment.id=n.resource_id AND n.kind='task_comment'
 LEFT JOIN task_reminder_deliveries delivery ON delivery.workspace_id=n.workspace_id AND delivery.id=n.resource_id AND n.kind='task_reminder'
 LEFT JOIN task_reminders reminder ON reminder.workspace_id=delivery.workspace_id AND reminder.task_id=delivery.task_id
 LEFT JOIN tasks t ON t.workspace_id=n.workspace_id AND t.id=CASE WHEN n.kind='task_comment' THEN task_comment.task_id WHEN n.kind='task_reminder' THEN delivery.task_id ELSE n.resource_id END AND n.kind IN ('task_assigned','task_comment','task_reminder','task_activity')
 LEFT JOIN workflow_runs workflow ON workflow.workspace_id=n.workspace_id AND workflow.id=n.resource_id AND n.kind='workflow_attention'
 LEFT JOIN automation_occurrences occurrence ON occurrence.workspace_id=n.workspace_id AND occurrence.id=n.resource_id AND n.kind='automation_attention'
 LEFT JOIN automations automation ON automation.workspace_id=occurrence.workspace_id AND automation.id=occurrence.automation_id
 LEFT JOIN agent_runs execution ON execution.workspace_id=n.workspace_id AND execution.id=n.resource_id AND n.kind='agent_attention'
 LEFT JOIN tool_invocations invocation ON invocation.workspace_id=n.workspace_id AND invocation.id=n.resource_id AND n.kind='approval_request'
 LEFT JOIN agent_runs run ON run.workspace_id=invocation.workspace_id AND run.id=invocation.run_id
 WHERE n.workspace_id=$1 AND n.recipient_id=$2
 AND (n.conversation_id IS NULL OR (c.id IS NOT NULL AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2))))
 AND CASE
  WHEN n.kind IN ('message','mention','reply') THEN m.id IS NOT NULL AND m.deleted_at IS NULL
  WHEN n.kind='reaction' THEN m.id IS NOT NULL AND m.deleted_at IS NULL AND EXISTS(SELECT 1 FROM message_reactions mr JOIN memberships rm ON rm.workspace_id=mr.workspace_id AND rm.id=mr.membership_id AND rm.status='active' WHERE mr.workspace_id=n.workspace_id AND mr.message_id=m.id AND mr.membership_id=n.actor_id)
  WHEN n.kind='task_activity' THEN t.id IS NOT NULL AND EXISTS(SELECT 1 FROM task_participants tp WHERE tp.workspace_id=t.workspace_id AND tp.task_id=t.id AND tp.membership_id=$2)
  WHEN n.kind='workflow_attention' THEN workflow.id IS NOT NULL AND EXISTS(SELECT 1 FROM workflow_notices wn WHERE wn.workspace_id=workflow.workspace_id AND wn.run_id=workflow.id AND wn.recipient_id=$2)
  WHEN n.kind='automation_attention' THEN coalesce((recipient.permissions->>'execution.read')::boolean,true) AND automation.id IS NOT NULL AND occurrence.status IN ('failed','outcome_unknown')
  WHEN n.kind='agent_attention' THEN execution.id IS NOT NULL AND (execution.owner_id=$2 OR execution.verifier_id=$2) AND execution.verification_status IN ('escalated','rejected')
  WHEN n.kind='task_assigned' THEN t.assignee_id=$2 AND n.delivery_version=t.assignment_version AND t.conversation_id IS NOT DISTINCT FROM n.conversation_id
  WHEN n.kind='task_reminder' THEN reminder.enabled AND reminder.version=delivery.reminder_version AND delivery.recipient_id=$2 AND COALESCE(t.assignee_id,t.created_by)=$2 AND t.due_version=delivery.due_version AND t.assignment_version=delivery.assignment_version AND t.due_date IS NOT NULL AND t.state NOT IN ('completed','cancelled') AND t.conversation_id IS NOT DISTINCT FROM n.conversation_id
  WHEN n.kind='task_comment' THEN t.id IS NOT NULL AND task_comment.deleted_at IS NULL AND t.conversation_id IS NOT DISTINCT FROM n.conversation_id
  WHEN n.kind='approval_request' THEN invocation.status='pending' AND run.status='awaiting_approval' AND recipient.role IN ('owner','admin')
  WHEN n.kind='group_added' THEN EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=n.workspace_id AND cm.conversation_id=n.conversation_id AND cm.membership_id=$2)
  ELSE false END`;
const visible = notificationVisible;
async function actor(tx: Sql, p: Identity) {
  requirePerson(p);
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
  await requireActiveMember(tx, p, p.membershipId);
}
export class NotificationService {
  constructor(private readonly db: Database) {}
  async list(p: Identity, input: { before?: string | undefined; unread: string; limit: number }) {
    requirePerson(p);
    if (input.before) {
      const [cursor] = await this.db.query(
        'SELECT id FROM notifications WHERE workspace_id=$1 AND recipient_id=$2 AND id=$3',
        [p.workspaceId, p.membershipId, input.before],
      );
      if (!cursor)
        throw new AppError(400, 'INVALID_CURSOR', 'This notification cursor is unavailable.');
    }
    const items = await this.db.query(
      `SELECT n.id,n.kind,actor.name actor_name,n.conversation_id,
      CASE WHEN c.kind='direct' THEN (SELECT name FROM memberships peer WHERE peer.workspace_id=c.workspace_id AND peer.id=CASE WHEN c.direct_low=$2 THEN c.direct_high ELSE c.direct_low END) WHEN c.kind='group' THEN c.title ELSE c.name END conversation_name,
      n.resource_id,automation.id automation_id,workflow.id workflow_run_id,execution.id agent_run_id,m.id message_id,m.thread_id,t.id task_id,
      CASE WHEN automation.id IS NOT NULL THEN automation.name || ': ' || coalesce(occurrence.reason,'Review the automation outcome') WHEN task_comment.id IS NOT NULL THEN left(task_comment.body,240) WHEN m.id IS NOT NULL THEN left(m.body,240) WHEN t.id IS NOT NULL THEN t.title WHEN workflow.id IS NOT NULL THEN coalesce(workflow.error_code,'Workflow needs your attention') ELSE NULL END excerpt,n.read_at,n.created_at
      ${visible} AND ($3::uuid IS NULL OR n.sequence<(SELECT sequence FROM notifications WHERE workspace_id=$1 AND recipient_id=$2 AND id=$3))
      AND (NOT $4::boolean OR n.read_at IS NULL) ORDER BY n.sequence DESC LIMIT $5`,
      [
        p.workspaceId,
        p.membershipId,
        input.before ?? null,
        input.unread === 'true',
        input.limit + 1,
      ],
    );
    const [count] = await this.db.query(
      `SELECT count(*)::int total ${visible} AND n.read_at IS NULL`,
      [p.workspaceId, p.membershipId],
    );
    const hasMore = items.length > input.limit;
    const page = items.slice(0, input.limit);
    return {
      items: page,
      unread_count: Number(count!.total),
      next_cursor: hasMore ? page.at(-1)!.id : null,
    };
  }
  async read(p: Identity, id: string, read: boolean) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const [row] = await tx.query(`SELECT n.id ${visible} AND n.id=$3`, [
        p.workspaceId,
        p.membershipId,
        id,
      ]);
      if (!row) throw notFound();
      const updated = await tx.query(
        'UPDATE notifications SET read_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE workspace_id=$1 AND recipient_id=$2 AND id=$3 AND (read_at IS NULL)=$4 RETURNING id',
        [p.workspaceId, p.membershipId, id, read],
      );
      if (updated.length) await notificationChanged(tx, p, id);
      return { ok: true };
    });
  }
  async readAll(p: Identity, through: string) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const [cutoff] = await tx.query(
        'SELECT sequence FROM notifications WHERE workspace_id=$1 AND recipient_id=$2 AND id=$3',
        [p.workspaceId, p.membershipId, through],
      );
      if (!cutoff) throw notFound();
      const updated = await tx.query(
        `UPDATE notifications SET read_at=now() WHERE workspace_id=$1 AND recipient_id=$2 AND read_at IS NULL AND sequence<=$3 AND id IN(SELECT n.id ${visible}) RETURNING id`,
        [p.workspaceId, p.membershipId, cutoff.sequence],
      );
      if (updated.length) await notificationChanged(tx, p, through);
      return { ok: true };
    });
  }
  async preferences(p: Identity) {
    requirePerson(p);
    const [row] = await this.db.query(
      'SELECT enabled,mentions,replies,direct_messages,group_messages,reactions,tasks,approvals FROM notification_preferences WHERE workspace_id=$1 AND membership_id=$2',
      [p.workspaceId, p.membershipId],
    );
    return { ...defaultNotificationPreferences, ...row };
  }
  async updatePreferences(p: Identity, input: z.infer<typeof notificationPreferenceUpdate>) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      await tx.query(
        'INSERT INTO notification_preferences(workspace_id,membership_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [p.workspaceId, p.membershipId],
      );
      const keys = Object.keys(input) as (keyof z.infer<typeof notificationPreferenceUpdate>)[];
      await tx.query(
        `UPDATE notification_preferences SET ${keys.map((key, index) => `${key}=$${index + 3}`).join(',')} WHERE workspace_id=$1 AND membership_id=$2`,
        [p.workspaceId, p.membershipId, ...keys.map((key) => input[key])],
      );
      await notificationChanged(tx, p, p.membershipId, 'notification.preferences_changed');
      return { ok: true };
    });
  }
  async conversationPreference(p: Identity, conversation: string) {
    requirePerson(p);
    await requireConversation(this.db, p, conversation);
    const [row] = await this.db.query(
      'SELECT mode FROM conversation_notification_preferences WHERE workspace_id=$1 AND membership_id=$2 AND conversation_id=$3',
      [p.workspaceId, p.membershipId, conversation],
    );
    return { mode: row?.mode ?? 'default' };
  }
  async updateConversationPreference(p: Identity, conversation: string, mode: string) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      await requireConversation(tx, p, conversation, true);
      await tx.query(
        'INSERT INTO conversation_notification_preferences(workspace_id,membership_id,conversation_id,mode) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,membership_id,conversation_id) DO UPDATE SET mode=EXCLUDED.mode',
        [p.workspaceId, p.membershipId, conversation, mode],
      );
      await notificationChanged(tx, p, p.membershipId, 'notification.preferences_changed');
      return { ok: true };
    });
  }
}
