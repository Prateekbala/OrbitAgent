import type { Sql } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { requireConversation } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import type { RunRow } from './types.js';
import { hasPermission } from '../identity/authorization.js';
export async function runIdentities(
  tx: Sql,
  run: RunRow,
): Promise<{ requester: Identity; agent: Identity }> {
  const [origin] = await tx.query(
    'WITH RECURSIVE lineage AS (SELECT id,parent_run_id,automation_occurrence_id FROM agent_runs WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT r.id,r.parent_run_id,r.automation_occurrence_id FROM agent_runs r JOIN lineage l ON r.id=l.parent_run_id WHERE r.workspace_id=$1) SELECT automation_occurrence_id FROM lineage WHERE automation_occurrence_id IS NOT NULL LIMIT 1',
    [run.workspace_id, run.id],
  );
  if (origin) {
    const [allowed] = await tx.query('SELECT automation_occurrence_allowed($1,$2) allowed', [
      run.workspace_id,
      origin.automation_occurrence_id,
    ]);
    if (!allowed?.allowed)
      throw new AppError(
        409,
        'AUTOMATION_STOPPED',
        'Automation authority changed or its deadline expired.',
      );
    await tx.query(
      "SELECT set_config('ao.automation_id',(SELECT automation_id::text FROM automation_occurrences WHERE workspace_id=$1 AND id=$2),true),set_config('ao.automation_occurrence_id',$2::text,true)",
      [run.workspace_id, origin.automation_occurrence_id],
    );
  }
  const [credentialOrigin] = await tx.query(
    'WITH RECURSIVE lineage AS (SELECT id,parent_run_id,platform_credential_id,requester_id FROM agent_runs WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT r.id,r.parent_run_id,r.platform_credential_id,r.requester_id FROM agent_runs r JOIN lineage l ON r.id=l.parent_run_id WHERE r.workspace_id=$1) SELECT platform_credential_id,requester_id FROM lineage WHERE platform_credential_id IS NOT NULL LIMIT 1',
    [run.workspace_id, run.id],
  );
  if (credentialOrigin) {
    const [allowed] = await tx.query('SELECT platform_execution_allowed($1,$2,$3,$4) allowed', [
      run.workspace_id,
      credentialOrigin.platform_credential_id,
      credentialOrigin.requester_id,
      run.conversation_id,
    ]);
    if (!allowed?.allowed)
      throw new AppError(
        409,
        'CREDENTIAL_REVOKED',
        'The execution credential expired, was revoked, or lost its audience.',
      );
  }
  if (run.parent_run_id) {
    const members = await tx.query(
      "SELECT id FROM memberships WHERE workspace_id=$1 AND id IN ($2,$3) AND status='active' AND kind='human' AND access_type='member' AND coalesce((permissions->>'execution.manage')::boolean,true) AND coalesce((permissions->>'execution.read')::boolean,true) AND coalesce((permissions->>'messages.read')::boolean,true)",
      [run.workspace_id, run.owner_id, run.verifier_id],
    );
    if (members.length !== 2)
      throw new AppError(
        409,
        'DELEGATION_AUTHORITY_REVOKED',
        'The delegation owner or verifier lost execution authority.',
      );
    const [blocked] = await tx.query(
      "WITH RECURSIVE ancestors AS (SELECT id,parent_run_id,status,verification_status FROM agent_runs WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT r.id,r.parent_run_id,r.status,r.verification_status FROM agent_runs r JOIN ancestors a ON r.id=a.parent_run_id WHERE r.workspace_id=$1) SELECT id FROM ancestors WHERE status IN ('failed','cancelled','outcome_unknown') OR verification_status IN ('rejected','escalated') LIMIT 1",
      [run.workspace_id, run.parent_run_id],
    );
    if (
      blocked ||
      (run.delegation_deadline && new Date(run.delegation_deadline).getTime() <= Date.now())
    )
      throw new AppError(
        409,
        'DELEGATION_STOPPED',
        'An ancestor stopped or the delegation deadline expired.',
      );
  }
  const [conversation] = await tx.query(
    'SELECT archived_at FROM conversations WHERE workspace_id=$1 AND id=$2',
    [run.workspace_id, run.conversation_id],
  );
  if (run.requester_policy_version !== undefined && run.requester_policy_version !== null) {
    const [policy] = await tx.query('SELECT workspace_policy_version($1) version', [
      run.workspace_id,
    ]);
    if (Number(policy?.version) !== run.requester_policy_version)
      throw new AppError(
        409,
        'AUTHORITY_REVOKED',
        'Organization policy changed. Review this run before restarting.',
      );
  }
  if (conversation?.archived_at)
    throw new AppError(409, 'CHANNEL_ARCHIVED', 'Restore the channel before agent execution.');
  const [row] = await tx.query(
    `SELECT a.status,a.runtime,a.revision,m.id,m.name,m.kind,m.role,m.permissions agent_permissions,m.access_type agent_access_type,r.permissions requester_permissions,r.access_type requester_access_type,r.id requester_id,r.name requester_name,r.role requester_role,r.kind requester_kind FROM agents a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id JOIN memberships r ON r.workspace_id=a.workspace_id AND r.id=$3 WHERE a.workspace_id=$1 AND a.id=$2 AND m.status='active' AND r.status='active' FOR UPDATE OF a FOR SHARE OF m,r`,
    [run.workspace_id, run.agent_id, run.requester_id],
  );
  const [authority] = await tx.query('SELECT * FROM public.member_account_authority($1,$2)', [
    run.workspace_id,
    run.requester_id,
  ]);
  if (
    !authority?.verified ||
    Number(authority.auth_version) !== run.requester_auth_version ||
    !row ||
    row.status !== 'active' ||
    row.runtime !== 'managed' ||
    row.agent_access_type !== 'member' ||
    row.requester_kind !== 'human' ||
    row.requester_access_type !== 'member' ||
    (row.requester_permissions as Record<string, unknown>)?.['execution.manage'] === false ||
    (run.agent_revision != null && row.revision !== run.agent_revision)
  )
    throw new AppError(
      409,
      'AUTHORITY_REVOKED',
      'This run no longer has active execution authority.',
    );
  const requester: Identity = {
    workspaceId: run.workspace_id,
    membershipId: run.requester_id,
    name: String(row.requester_name),
    role: row.requester_role as Identity['role'],
    kind: 'human',
    accessType: 'member',
    permissions: row.requester_permissions as NonNullable<Identity['permissions']>,
  };
  const agent: Identity = {
    workspaceId: run.workspace_id,
    membershipId: String(row.id),
    name: String(row.name),
    role: 'member',
    kind: 'agent',
    accessType: 'member',
    permissions: row.agent_permissions as NonNullable<Identity['permissions']>,
  };
  if (!hasPermission(requester, 'messages.read') || !hasPermission(agent, 'messages.read'))
    throw new AppError(409, 'AUTHORITY_REVOKED', 'Source message permission was revoked.');
  await requireConversation(tx, requester, run.conversation_id);
  await requireConversation(tx, agent, run.conversation_id);
  return { requester, agent };
}

export async function requireRunContext(tx: Sql, run: RunRow) {
  if (run.retrieval_epoch != null) {
    const [authority] = await tx.query(
      'SELECT epoch FROM retrieval_authority WHERE workspace_id=$1',
      [run.workspace_id],
    );
    if (String(authority?.epoch) !== String(run.retrieval_epoch))
      throw new AppError(
        409,
        'RETRIEVAL_CONTEXT_INVALIDATED',
        'Workspace access changed. Restart with freshly authorized context.',
      );
  }
}
