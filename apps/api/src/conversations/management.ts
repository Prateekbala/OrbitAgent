import type { Sql } from '@ao/database';
import { AppError, notFound } from '../lib/errors.js';
import { requireActiveMember, requireConversation, type Identity } from '../lib/policy.js';
import { recordChange } from '../lib/events.js';
export async function lockConversationChange(tx: Sql, p: Identity, id: string) {
  if (p.kind !== 'human')
    throw new AppError(403, 'HUMAN_REQUIRED', 'A person must manage conversations.');
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
  await requireActiveMember(tx, p, p.membershipId);
  const runs = await tx.query(
    "SELECT id FROM agent_runs WHERE workspace_id=$1 AND conversation_id=$2 AND status IN ('queued','running','awaiting_approval','outcome_unknown') ORDER BY id FOR UPDATE",
    [p.workspaceId, id],
  );
  const [conversation] = await tx.query(
    'SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [p.workspaceId, id],
  );
  if (!conversation) throw notFound();
  await requireConversation(tx, p, id);
  return { conversation, runs };
}
export async function fenceConversationRuns(tx: Sql, runs: Record<string, unknown>[]) {
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
}
export async function groupOwner(tx: Sql, p: Identity, id: string) {
  const [own] = await tx.query(
    "SELECT cm.membership_id FROM conversation_members cm JOIN memberships m ON m.workspace_id=cm.workspace_id AND m.id=cm.membership_id WHERE cm.workspace_id=$1 AND cm.conversation_id=$2 AND cm.membership_id=$3 AND cm.role='owner' AND m.status='active' AND m.kind='human'",
    [p.workspaceId, id, p.membershipId],
  );
  if (!own)
    throw new AppError(
      403,
      'GROUP_OWNER_REQUIRED',
      'A current group owner must request a history expansion.',
    );
}
export async function grantConsentedHistory(
  tx: Sql,
  p: Identity,
  proposal: Record<string, unknown>,
  conversation: Record<string, unknown>,
  runs: Record<string, unknown>[],
) {
  if (
    conversation.version !== proposal.base_version ||
    conversation.archived_at ||
    new Date(String(proposal.expires_at)).getTime() <= Date.now()
  )
    throw new AppError(
      409,
      'CONSENT_EXPIRED',
      'The group changed or this request expired. Request fresh consent.',
    );
  const voters = await tx.query(
    "SELECT cm.membership_id FROM conversation_members cm JOIN memberships m ON m.id=cm.membership_id AND m.workspace_id=cm.workspace_id WHERE cm.workspace_id=$1 AND cm.conversation_id=$2 AND m.status='active' AND m.kind='human' ORDER BY cm.membership_id",
    [p.workspaceId, conversation.id],
  );
  if (
    JSON.stringify(voters.map((v) => v.membership_id)) !==
    JSON.stringify([...(proposal.voters as string[])].sort())
  )
    throw new AppError(
      409,
      'CONSENT_EXPIRED',
      'The participant audience changed. Request fresh consent.',
    );
  const [remaining] = await tx.query(
    "SELECT count(*)::int count FROM unnest($3::uuid[]) voter WHERE NOT EXISTS(SELECT 1 FROM group_history_votes v WHERE v.workspace_id=$1 AND v.proposal_id=$2 AND v.membership_id=voter AND v.decision='approve')",
    [p.workspaceId, proposal.id, proposal.voters],
  );
  if (Number(remaining?.count)) return false;
  await groupOwner(
    tx,
    { ...p, membershipId: String(proposal.requested_by) },
    String(conversation.id),
  );
  await requireActiveMember(tx, p, String(proposal.target_id));
  const [existing] = await tx.query(
    'SELECT membership_id FROM conversation_members WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3',
    [p.workspaceId, conversation.id, proposal.target_id],
  );
  if (existing)
    throw new AppError(409, 'ALREADY_PARTICIPANT', 'This person is already a participant.');
  await tx.query(
    "SELECT set_config('ao.group_membership_mutation',$1,true),set_config('ao.history_proposal_id',$2,true)",
    [conversation.id, proposal.id],
  );
  await tx.query(
    'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id,history_from_sequence) VALUES($1,$2,$3,0)',
    [p.workspaceId, conversation.id, proposal.target_id],
  );
  await tx.query(
    "UPDATE group_history_proposals SET status='accepted' WHERE workspace_id=$1 AND id=$2",
    [p.workspaceId, proposal.id],
  );
  await tx.query('UPDATE conversations SET version=version+1 WHERE workspace_id=$1 AND id=$2', [
    p.workspaceId,
    conversation.id,
  ]);
  await fenceConversationRuns(tx, runs);
  await recordChange(
    tx,
    p,
    'conversation.member_added',
    String(proposal.target_id),
    String(conversation.id),
  );
  await recordChange(
    tx,
    p,
    'conversation.updated',
    String(conversation.id),
    String(conversation.id),
  );
  return true;
}
