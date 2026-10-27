import type { Sql } from '@ao/database';
import { digest, token } from '../lib/security.js';

export async function revokeMemberMachines(
  tx: Sql,
  workspace: string,
  target: string,
  successor?: string,
) {
  const affected = `(owner_id=$2 OR credential_issuer_id=$2 OR (owner_id IS NULL AND credential_issuer_id IS NULL))`;
  const runs = await tx.query(
    `SELECT id FROM agent_runs WHERE workspace_id=$1 AND agent_id IN (SELECT id FROM agents WHERE workspace_id=$1 AND ${affected}) AND status IN ('queued','running','awaiting_approval','outcome_unknown') ORDER BY id FOR UPDATE`,
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
  const agents = await tx.query(
    `SELECT id,runtime,owner_id FROM agents WHERE workspace_id=$1 AND ${affected} ORDER BY id FOR UPDATE`,
    [workspace, target],
  );
  for (const agent of agents) {
    await tx.query(
      "UPDATE agents SET status='paused',key_hash=$3,credential_issuer_id=NULL,owner_id=CASE WHEN owner_id=$2 OR owner_id IS NULL THEN $4 ELSE owner_id END WHERE workspace_id=$1 AND id=$5",
      [
        workspace,
        target,
        agent.runtime === 'external' ? digest(token()) : null,
        successor ?? null,
        agent.id,
      ],
    );
  }
  await tx.query(
    'UPDATE agent_credentials SET revoked_at=now() WHERE workspace_id=$1 AND created_by=$2 AND revoked_at IS NULL',
    [workspace, target],
  );
  await tx.query(
    "UPDATE agent_inbox SET state=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,lease_token=NULL,lease_expires_at=NULL,credential_id=NULL,fence=fence+1 WHERE workspace_id=$1 AND state='leased' AND credential_id IN (SELECT id FROM agent_credentials WHERE workspace_id=$1 AND created_by=$2 AND revoked_at IS NOT NULL)",
    [workspace, target],
  );
  await tx.query('SET LOCAL ROLE ao_identity');
  await tx.query(
    'UPDATE service_credentials SET revoked_at=now() WHERE workspace_id=$1 AND (membership_id=$2 OR created_by=$2) AND revoked_at IS NULL',
    [workspace, target],
  );
  await tx.query(
    "UPDATE memberships SET status='suspended',version=version+1 WHERE workspace_id=$1 AND access_type='service' AND id IN (SELECT membership_id FROM service_credentials WHERE workspace_id=$1 AND created_by=$2)",
    [workspace, target],
  );
  await tx.query(
    'UPDATE scim_credentials SET revoked_at=now() WHERE created_by=(SELECT account_id FROM memberships WHERE workspace_id=$1 AND id=$2) AND organization_id=(SELECT organization_id FROM workspaces WHERE id=$1) AND revoked_at IS NULL',
    [workspace, target],
  );
  await tx.query('SET LOCAL ROLE ao_runtime');
}
