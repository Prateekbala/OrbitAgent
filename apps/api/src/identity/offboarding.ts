import { revokeMessageComposition } from '../messaging/revocation.js';
import type { Sql } from '@ao/database';
import { AppError, notFound } from '../lib/errors.js';
import { revokeMemberMachines } from './machine-credentials.js';
export async function offboardWorkspace(
  tx: Sql,
  workspace: string,
  target: string,
  successor?: string,
) {
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace]);
  const [member] = await tx.query('SELECT * FROM memberships WHERE workspace_id=$1 AND id=$2', [
    workspace,
    target,
  ]);
  if (!member) throw notFound();
  if (successor === target)
    throw new AppError(400, 'INVALID_SUCCESSOR', 'Choose another member as successor.');
  let replacement: Record<string, unknown> | undefined;
  if (successor) {
    [replacement] = await tx.query(
      "SELECT * FROM memberships WHERE workspace_id=$1 AND id=$2 AND kind='human' AND access_type='member' AND status='active' FOR SHARE",
      [workspace, successor],
    );
    if (!replacement)
      throw new AppError(
        400,
        'INVALID_SUCCESSOR',
        'An active full member in the same workspace is required.',
      );
  }
  if (member.role === 'owner' && member.status === 'active') {
    const [owners] = await tx.query(
      "SELECT count(*)::int count FROM memberships WHERE workspace_id=$1 AND role='owner' AND status='active' AND id<>$2",
      [workspace, target],
    );
    if (!Number(owners?.count) && !replacement)
      throw new AppError(
        409,
        'LAST_OWNER',
        'Transfer workspace ownership before offboarding its last owner.',
      );
    if (replacement)
      await tx.query("UPDATE memberships SET role='owner',version=version+1 WHERE id=$1", [
        successor,
      ]);
  }
  const [projects] = await tx.query(
    'SELECT count(*)::int count FROM projects WHERE workspace_id=$1 AND owner_id=$2',
    [workspace, target],
  );
  if (Number(projects?.count) && !successor)
    throw new AppError(409, 'SUCCESSOR_REQUIRED', 'Choose a successor for this member’s projects.');
  if (successor) {
    const inaccessible = await tx.query(
      `SELECT conversation_id FROM tasks WHERE workspace_id=$1 AND assignee_id=$2 AND conversation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=tasks.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.membership_id=$3)))
     UNION SELECT conversation_id FROM projects WHERE workspace_id=$1 AND owner_id=$2 AND conversation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=projects.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.membership_id=$3)))`,
      [workspace, target, successor],
    );
    if (inaccessible.length)
      throw new AppError(
        409,
        'SUCCESSOR_ACCESS_REQUIRED',
        'Share all assigned task and project conversations with the successor first.',
      );
  }
  const runs = await tx.query(
    "SELECT id FROM agent_runs WHERE workspace_id=$1 AND requester_id=$2 AND status IN ('queued','running','awaiting_approval','outcome_unknown') ORDER BY id FOR UPDATE",
    [workspace, target],
  );
  for (const run of runs) {
    await tx.query(
      "UPDATE agent_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
      [run.id],
    );
    await tx.query(
      "UPDATE tool_invocations SET status='cancelled' WHERE run_id=$1 AND status IN ('pending','approved')",
      [run.id],
    );
  }
  await revokeMemberMachines(tx, workspace, target, successor);
  await tx.query(
    'UPDATE tasks SET assignee_id=$3,version=version+1 WHERE workspace_id=$1 AND assignee_id=$2',
    [workspace, target, successor ?? null],
  );
  if (successor)
    await tx.query(
      'UPDATE projects SET owner_id=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND owner_id=$2',
      [workspace, target, successor],
    );
  await tx.query(
    "UPDATE task_recurrences SET paused=true,paused_reason='CREATOR_OFFBOARDED',version=version+1 WHERE workspace_id=$1 AND created_by=$2 AND NOT paused",
    [workspace, target],
  );
  const groups = await tx.query(
    "SELECT cm.conversation_id FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id WHERE cm.workspace_id=$1 AND cm.membership_id=$2 AND cm.role='owner' AND c.kind='group' ORDER BY cm.conversation_id",
    [workspace, target],
  );
  for (const group of groups) {
    const [next] = await tx.query(
      "SELECT cm.membership_id FROM conversation_members cm JOIN memberships m ON m.id=cm.membership_id WHERE cm.conversation_id=$1 AND cm.membership_id<>$2 AND m.status='active' AND m.kind='human' ORDER BY (cm.membership_id=$3) DESC,cm.joined_at,cm.membership_id LIMIT 1",
      [group.conversation_id, target, successor ?? null],
    );
    if (next)
      await tx.query(
        "UPDATE conversation_members SET role='owner' WHERE conversation_id=$1 AND membership_id=$2",
        [group.conversation_id, next.membership_id],
      );
  }
  await revokeMessageComposition(tx, workspace, target);
  await tx.query('SET LOCAL ROLE ao_worker');
  await tx.query(
    "UPDATE workflow_runs SET status='cancelled',error_code='OWNER_OFFBOARDED',version=version+1,finished_at=clock_timestamp() WHERE workspace_id=$1 AND created_by=$2 AND status IN ('queued','running','waiting')",
    [workspace, target],
  );
  await tx.query(
    'UPDATE workflow_triggers SET enabled=false,version=version+1 WHERE workspace_id=$1 AND created_by=$2',
    [workspace, target],
  );
  await tx.query(
    'UPDATE work_templates SET archived=true,version=version+1 WHERE workspace_id=$1 AND created_by=$2',
    [workspace, target],
  );
  await tx.query('DELETE FROM task_participants WHERE workspace_id=$1 AND membership_id=$2', [
    workspace,
    target,
  ]);
  await tx.query(
    "UPDATE calendar_connections SET status='disconnected',credentials='',lease_token=NULL,lease_expires_at=NULL,version=version+1 WHERE workspace_id=$1 AND membership_id=$2",
    [workspace, target],
  );
  await tx.query(
    'UPDATE calendar_feeds SET revoked_at=now() WHERE workspace_id=$1 AND membership_id=$2',
    [workspace, target],
  );
  await tx.query('SET LOCAL ROLE ao_runtime');

  await tx.query('DELETE FROM conversation_members WHERE workspace_id=$1 AND membership_id=$2', [
    workspace,
    target,
  ]);
  await tx.query(
    "UPDATE memberships SET status='suspended',role=CASE WHEN role='owner' THEN 'member' ELSE role END,offboarded_at=now(),version=version+1 WHERE workspace_id=$1 AND id=$2",
    [workspace, target],
  );
  await tx.query('DELETE FROM sessions WHERE workspace_id=$1 AND membership_id=$2', [
    workspace,
    target,
  ]);
  await tx.query(
    "UPDATE invitations SET status='revoked' WHERE workspace_id=$1 AND inviter_id=$2 AND status='pending'",
    [workspace, target],
  );
  await tx.query(
    "UPDATE email_jobs SET status='cancelled',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE invitation_id IN (SELECT id FROM invitations WHERE workspace_id=$1 AND inviter_id=$2) AND status IN ('queued','sending')",
    [workspace, target],
  );
  await tx.query(
    "INSERT INTO outbox_events(workspace_id,event_type,resource_id,payload) VALUES($1,'member.offboarded',$2,'{}')",
    [workspace, target],
  );
}
