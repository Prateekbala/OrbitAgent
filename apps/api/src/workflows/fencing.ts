import type { Sql } from '@ao/database';
export async function fenceWorkflowAgents(tx: Sql, workspace: string, run: string) {
  const children = await tx.query(
    "SELECT r.id,r.conversation_id FROM agent_runs r JOIN workflow_steps s ON s.workspace_id=r.workspace_id AND r.id=nullif(s.output->>'runId','')::uuid WHERE s.workspace_id=$1 AND s.run_id=$2 AND r.status IN ('queued','running','awaiting_approval','outcome_unknown') ORDER BY r.id FOR UPDATE OF r",
    [workspace, run],
  );
  for (const child of children) {
    await tx.query(
      "UPDATE agent_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
      [workspace, child.id],
    );
    await tx.query(
      "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id) VALUES($1,'run.cancelled',$2,$3)",
      [workspace, child.id, child.conversation_id],
    );
    await tx.query(
      "UPDATE tool_invocations SET status='cancelled' WHERE workspace_id=$1 AND run_id=$2 AND status IN ('pending','approved')",
      [workspace, child.id],
    );
  }
}
