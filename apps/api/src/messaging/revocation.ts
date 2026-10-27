import type { Sql } from '@ao/database';
export async function revokeMessageComposition(
  tx: Sql,
  workspace: string,
  member: string,
  conversation?: string,
) {
  await tx.query('SET LOCAL ROLE ao_worker');
  await tx.query(
    'DELETE FROM message_drafts WHERE workspace_id=$1 AND membership_id=$2 AND ($3::uuid IS NULL OR conversation_id=$3)',
    [workspace, member, conversation ?? null],
  );
  await tx.query(
    "UPDATE files SET expires_at=least(expires_at,now()+interval '1 day') WHERE workspace_id=$1 AND id IN (SELECT sf.file_id FROM scheduled_message_files sf JOIN scheduled_messages s ON s.workspace_id=sf.workspace_id AND s.id=sf.schedule_id WHERE s.workspace_id=$1 AND s.membership_id=$2 AND ($3::uuid IS NULL OR s.conversation_id=$3) AND s.status='scheduled')",
    [workspace, member, conversation ?? null],
  );
  await tx.query(
    "UPDATE scheduled_messages SET status='cancelled',error_code='ACCESS_REVOKED',body='',attachment_ids='{}',mention_ids='{}',version=version+1 WHERE workspace_id=$1 AND membership_id=$2 AND ($3::uuid IS NULL OR conversation_id=$3) AND status IN ('scheduled','blocked')",
    [workspace, member, conversation ?? null],
  );
  if (!conversation)
    for (const table of ['saved_messages', 'thread_followers', 'personal_sidebars'])
      await tx.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND membership_id=$2`, [
        workspace,
        member,
      ]);
  await tx.query('SET LOCAL ROLE ao_runtime');
}
