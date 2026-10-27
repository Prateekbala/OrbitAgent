import type { Permission } from '@ao/contracts';
import type { Sql } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { hasPermission } from '../identity/authorization.js';
export async function workPrincipal(
  tx: Sql,
  workspace: string,
  member: string,
  expected?: { auth: number; policy: number },
  required: Permission[] = ['tasks.read', 'tasks.write'],
) {
  await tx.query('SET LOCAL ROLE ao_identity');
  const [row] = await tx.query(
    'SELECT m.*,a.auth_version,a.email_verified_at,a.disabled_at,o.version policy_version,om.status organization_status,o.allowed_domains,a.email FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN workspaces w ON w.id=m.workspace_id JOIN organizations o ON o.id=w.organization_id JOIN organization_members om ON om.organization_id=o.id AND om.account_id=a.id WHERE m.workspace_id=$1 AND m.id=$2 FOR SHARE OF m,a',
    [workspace, member],
  );
  await tx.query('SET LOCAL ROLE ao_worker');
  if (
    !row ||
    row.kind !== 'human' ||
    row.access_type !== 'member' ||
    row.status !== 'active' ||
    row.organization_status !== 'active' ||
    !row.email_verified_at ||
    row.disabled_at ||
    (expected && (row.auth_version !== expected.auth || row.policy_version !== expected.policy)) ||
    ((row.allowed_domains as string[]).length &&
      !(row.allowed_domains as string[]).includes(String(row.email).split('@')[1]!))
  )
    throw new AppError(
      409,
      'AUTHORITY_REVOKED',
      'Workflow or calendar authority changed. A person must review it.',
    );
  const p: Identity = {
    workspaceId: workspace,
    membershipId: member,
    name: String(row.name),
    role: row.role as Identity['role'],
    kind: 'human',
    accessType: 'member',
    permissions: row.permissions as NonNullable<Identity['permissions']>,
  };
  if (!required.every((permission) => hasPermission(p, permission)))
    throw new AppError(
      403,
      'PERMISSION_DENIED',
      'The owner no longer holds the required workspace permissions.',
    );
  return p;
}
export async function assumeWorkPrincipal(tx: Sql, p: Identity) {
  await tx.query(
    "SELECT set_config('ao.membership_id',$1,true),set_config('ao.access_type',$2,true)",
    [p.membershipId, p.accessType ?? 'member'],
  );
  await tx.query('SET LOCAL ROLE ao_runtime');
}
