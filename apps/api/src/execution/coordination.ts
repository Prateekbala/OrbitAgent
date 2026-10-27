import { randomUUID } from 'node:crypto';
import type { Sql } from '@ao/database';
import type { RunRow } from './types.js';
import { publicTrace } from './controls.js';

export async function coordinationState(tx: Sql, workspace: string, run: string) {
  const [state] = await tx.query(
    "WITH RECURSIVE children AS (SELECT id,status,verification_status FROM agent_runs WHERE workspace_id=$1 AND parent_run_id=$2 UNION ALL SELECT r.id,r.status,r.verification_status FROM agent_runs r JOIN children c ON r.parent_run_id=c.id WHERE r.workspace_id=$1) SELECT count(*)::int total,count(*) FILTER(WHERE status IN ('failed','cancelled','outcome_unknown') OR verification_status IN ('rejected','escalated'))::int blocked,count(*) FILTER(WHERE status<>'succeeded' OR verification_status<>'accepted')::int pending FROM children",
    [workspace, run],
  );
  return Number(state?.blocked) > 0
    ? 'blocked'
    : Number(state?.pending) > 0
      ? 'awaiting_verification'
      : Number(state?.total) > 0
        ? 'verified'
        : 'none';
}
export async function escalateDelegation(tx: Sql, run: RunRow) {
  await publicTrace(
    tx,
    run,
    'escalation',
    'Delegated work requires its owner and independent verifier to review the outcome.',
  );
  for (const member of new Set([run.owner_id, run.verifier_id])) {
    if (typeof member !== 'string') continue;
    const [notice] = await tx.query(
      "INSERT INTO notifications(id,workspace_id,recipient_id,actor_id,conversation_id,resource_id,kind,delivery_version) SELECT $1,$2,m.id,$3,$4,$5,'agent_attention',1 FROM memberships m LEFT JOIN notification_preferences pref ON pref.workspace_id=m.workspace_id AND pref.membership_id=m.id LEFT JOIN conversation_notification_preferences cp ON cp.workspace_id=m.workspace_id AND cp.membership_id=m.id AND cp.conversation_id=$4 WHERE m.workspace_id=$2 AND m.id=$6 AND m.status='active' AND m.kind='human' AND coalesce(pref.enabled,true) AND coalesce(pref.approvals,true) AND coalesce(cp.mode,'default')<>'muted' AND resource_visible_to($2,$4,$7,m.id) ON CONFLICT DO NOTHING RETURNING id",
      [
        randomUUID(),
        run.workspace_id,
        run.requester_id,
        run.conversation_id,
        run.id,
        member,
        run.created_at,
      ],
    );
    if (notice)
      await tx.query(
        "INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id) VALUES($1,'notification.created',$2,$3)",
        [run.workspace_id, notice.id, member],
      );
  }
}
