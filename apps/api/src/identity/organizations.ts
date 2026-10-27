import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import { identityScope, accountSessionId } from '@ao/database';
import { AppError, notFound } from '../lib/errors.js';
export async function organizationActor(
  tx: Sql,
  organizationId: string,
  accountId: string,
  manage = false,
  lock = false,
) {
  const [org] = await tx.query(
    `SELECT o.*,m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE o.id=$1 AND m.account_id=$2 AND m.status='active'${lock ? ' FOR UPDATE OF o' : ''}`,
    [organizationId, accountId],
  );
  if (!org) throw notFound();
  const sessionId = accountSessionId();
  if (!sessionId)
    throw new AppError(401, 'HUMAN_REQUIRED', 'An authenticated account session is required.');
  const [session] = await tx.query(
    'SELECT s.mfa_verified_at,s.provider_id,s.authentication_method,a.email FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.id=$1 AND s.account_id=$2 AND s.expires_at>now() AND s.created_at>now()-$3::interval AND s.auth_version=a.auth_version AND a.disabled_at IS NULL',
    [sessionId, accountId, `${org.session_hours} hours`],
  );
  if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  if (org.require_mfa && !session.mfa_verified_at)
    throw new AppError(
      403,
      'MFA_ENROLLMENT_REQUIRED',
      'This organization requires two-factor authentication.',
    );
  if (
    (org.allowed_domains as string[]).length &&
    !(org.allowed_domains as string[]).includes(String(session.email).split('@')[1]!)
  ) {
    const [full] = await tx.query(
      "SELECT m.id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE w.organization_id=$1 AND m.account_id=$2 AND m.access_type='member' AND m.status='active' LIMIT 1",
      [organizationId, accountId],
    );
    if (full || ['owner', 'admin'].includes(String(org.role)))
      throw new AppError(
        403,
        'DOMAIN_RESTRICTED',
        'This email domain is not permitted by the organization.',
      );
  }
  if (org.require_sso) {
    const [bound] = await tx.query(
      'SELECT p.id FROM identity_providers p JOIN federated_identities f ON f.provider_id=p.id WHERE p.id=$1 AND p.organization_id=$2 AND p.enabled AND p.protocol=$3 AND f.account_id=$4',
      [session.provider_id, organizationId, session.authentication_method, accountId],
    );
    if (!bound)
      throw new AppError(
        403,
        'SSO_REQUIRED',
        'Authenticate through this organization’s identity provider.',
      );
  }
  if (manage && !['owner', 'admin'].includes(String(org.role)))
    throw new AppError(
      403,
      'ORGANIZATION_ADMIN_REQUIRED',
      'An organization administrator must perform this action.',
    );
  return org;
}
export async function organizationAudit(
  tx: Sql,
  org: string,
  actor: string | null,
  action: string,
  resource: string,
) {
  await tx.query(
    "INSERT INTO organization_audit(id,organization_id,actor_id,action,resource_id,credential_id) VALUES($1,$2,$3,$4,$5,nullif(current_setting('ao.scim_credential_id',true),'')::uuid)",
    [randomUUID(), org, actor, action, resource],
  );
}
export async function assertInvitationPolicy(
  db: Database,
  workspaceId: string,
  email: string,
  accessType = 'member',
) {
  return identityScope(async () => {
    const [policy] = await db.query(
      'SELECT o.allowed_domains FROM organizations o JOIN workspaces w ON w.organization_id=o.id WHERE w.id=$1',
      [workspaceId],
    );
    if (!policy) throw notFound();
    const allowed = policy.allowed_domains as string[];
    if (accessType !== 'guest' && allowed.length && !allowed.includes(email.split('@')[1]!))
      throw new AppError(
        403,
        'DOMAIN_RESTRICTED',
        'This organization only allows member invitations to its approved domains.',
      );
  });
}
