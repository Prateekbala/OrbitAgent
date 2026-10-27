import type { Sql } from '@ao/database';
import { token, digest } from './security.js';
import { AppError } from './errors.js';
export function sessionCookie(production: boolean) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 604800,
  };
}
export async function createSession(
  tx: Sql,
  accountId: string,
  membershipId: string | null,
  expectedAuthVersion?: number,
  options: {
    mfaVerifiedAt?: Date | string | null;
    method?: 'password' | 'oidc' | 'saml';
    providerId?: string | null;
    userAgent?: string;
    ipAddress?: string;
    authenticatedAt?: Date | string;
  } = {},
) {
  const [account] = await tx.query(
    'SELECT auth_version,mfa_enabled,disabled_at,email FROM accounts WHERE id=$1 FOR SHARE',
    [accountId],
  );
  if (
    !account ||
    account.disabled_at ||
    (expectedAuthVersion !== undefined && account.auth_version !== expectedAuthVersion)
  )
    throw new AppError(401, 'CREDENTIALS_CHANGED', 'Sign in again with your current password.');
  const value = token();
  const authenticatedAt = options.authenticatedAt ? new Date(options.authenticatedAt) : new Date();
  const requireRecentAuthentication = (hours: number) => {
    if (
      !Number.isFinite(authenticatedAt.getTime()) ||
      Date.now() - authenticatedAt.getTime() >= hours * 3600000
    )
      throw new AppError(
        401,
        'SESSION_REAUTHENTICATION_REQUIRED',
        'Sign in again to satisfy the destination organization session policy.',
      );
  };
  if (account.mfa_enabled && !options.mfaVerifiedAt)
    throw new AppError(401, 'MFA_REQUIRED', 'Complete two-factor authentication to sign in.');
  if (!membershipId) {
    requireRecentAuthentication(168);
    await tx.query(
      "INSERT INTO sessions(token_hash,account_id,auth_version,expires_at,mfa_verified_at,authentication_method,provider_id,user_agent,ip_address,created_at) VALUES($1,$2,$3,now()+interval '7 days',$4,$5,$6,$7,$8,$9)",
      [
        digest(value),
        accountId,
        account.auth_version,
        options.mfaVerifiedAt ?? null,
        options.method ?? 'password',
        options.providerId ?? null,
        options.userAgent ?? '',
        options.ipAddress ?? '',
        authenticatedAt,
      ],
    );
    return value;
  }
  const [membership] = await tx.query(
    "SELECT m.id,m.access_type,o.id organization_id,o.require_sso,o.session_hours,o.allowed_domains,om.status organization_status FROM memberships m JOIN workspaces w ON w.id=m.workspace_id JOIN organizations o ON o.id=w.organization_id JOIN organization_members om ON om.organization_id=o.id AND om.account_id=m.account_id WHERE m.id=$1 AND m.account_id=$2 AND m.kind='human' AND m.status='active' FOR SHARE OF m",
    [membershipId, accountId],
  );
  if (!membership || membership.organization_status !== 'active')
    throw new AppError(
      401,
      'MEMBERSHIP_UNAVAILABLE',
      'This workspace membership is no longer active.',
    );
  requireRecentAuthentication(Number(membership.session_hours));
  if (account.mfa_enabled && !options.mfaVerifiedAt)
    throw new AppError(401, 'MFA_REQUIRED', 'Complete two-factor authentication to sign in.');
  const domains = membership.allowed_domains as string[];
  if (
    membership.access_type !== 'guest' &&
    domains.length &&
    !domains.includes(String(account.email).split('@')[1]!)
  )
    throw new AppError(
      403,
      'DOMAIN_RESTRICTED',
      'This email domain is not allowed by the organization.',
    );
  if (
    membership.require_sso &&
    (!options.providerId || options.method === 'password' || !options.method)
  )
    throw new AppError(403, 'SSO_REQUIRED', 'Use your organization’s single sign-on provider.');
  if (membership.require_sso) {
    const [bound] = await tx.query(
      'SELECT p.id FROM identity_providers p JOIN federated_identities f ON f.provider_id=p.id WHERE p.id=$1 AND p.organization_id=$2 AND p.enabled AND p.protocol=$3 AND f.account_id=$4 FOR SHARE OF p',
      [options.providerId, membership.organization_id, options.method, accountId],
    );
    if (!bound)
      throw new AppError(
        403,
        'SSO_REQUIRED',
        'Authenticate through an identity provider belonging to the destination organization.',
      );
  }
  await tx.query(
    'INSERT INTO sessions(token_hash,account_id,membership_id,workspace_id,auth_version,expires_at,mfa_verified_at,authentication_method,provider_id,user_agent,ip_address,created_at) SELECT $1,$2,id,workspace_id,$4,now()+$5::interval,$6,$7,$8,$9,$10,$11 FROM memberships WHERE id=$3',
    [
      digest(value),
      accountId,
      membershipId,
      account.auth_version,
      `${membership.session_hours} hours`,
      options.mfaVerifiedAt ?? null,
      options.method ?? 'password',
      options.providerId ?? null,
      options.userAgent ?? '',
      options.ipAddress ?? '',
      authenticatedAt,
    ],
  );
  return value;
}
export async function createSignInSession(...args: Parameters<typeof createSession>) {
  try {
    return await createSession(...args);
  } catch (error) {
    if (!(error instanceof AppError) || !['SSO_REQUIRED', 'DOMAIN_RESTRICTED'].includes(error.code))
      throw error;
    const [tx, accountId, , version, options] = args;
    return createSession(tx, accountId, null, version, options);
  }
}
