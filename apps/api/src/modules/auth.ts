import { authenticatePlatform } from '../developer/auth.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  identityScope,
  identifyWorkspace,
  identifyPrincipal,
  identifyAgentCredential,
  type Database,
} from '@ao/database';
import { randomUUID } from 'node:crypto';
import { signUpInput, signInInput } from '@ao/contracts';
import { digest, hashPassword, verifyPassword } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
import type { Identity } from '../lib/policy.js';
import type { EmailService } from '../email/service.js';
import { AccountService } from '../identity/service.js';
import { createSession, createSignInSession, sessionCookie } from '../lib/sessions.js';
import { authorizeRequest } from '../identity/authorization.js';
import { AccountSecurity, sessionMetadata } from '../identity/security.js';
export async function authenticate(db: Database, request: FastifyRequest): Promise<Identity> {
  if (request.headers.authorization?.startsWith('Bearer orb_'))
    return authenticatePlatform(db, request);
  const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const rows = await identityScope(async () =>
    bearer
      ? await db.query(
          `SELECT m.*,c.id credential_id,c.scopes credential_scopes FROM agent_credentials c JOIN agents a ON a.workspace_id=c.workspace_id AND a.id=c.agent_id JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>now() AND a.status='active' AND m.status='active'
           UNION ALL SELECT m.*,NULL::uuid credential_id,NULL::text[] credential_scopes FROM service_credentials c JOIN memberships m ON m.workspace_id=c.workspace_id AND m.id=c.membership_id WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>now() AND m.status='active' AND m.access_type='service'`,
          [digest(bearer)],
        )
      : request.cookies.ao_session
        ? await db.query(
            `SELECT m.*,a.auth_version principal_auth_version,o.version principal_policy_version,EXISTS(SELECT 1 FROM identity_providers ip JOIN federated_identities fi ON fi.provider_id=ip.id WHERE ip.id=s.provider_id AND ip.organization_id=w.organization_id AND ip.protocol=s.authentication_method AND ip.enabled AND fi.account_id=a.id) sso_authorized,a.email_verified_at,a.mfa_enabled,a.email,s.mfa_verified_at,s.authentication_method,s.provider_id,o.require_mfa,o.require_sso,o.allowed_domains FROM sessions s JOIN memberships m ON m.id=s.membership_id JOIN accounts a ON a.id=s.account_id JOIN workspaces w ON w.id=m.workspace_id JOIN organizations o ON o.id=w.organization_id JOIN organization_members om ON om.organization_id=o.id AND om.account_id=a.id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.created_at>now()-o.session_hours*interval '1 hour' AND s.auth_version=a.auth_version AND m.status='active' AND om.status='active' AND public.organization_live(m.workspace_id) AND a.disabled_at IS NULL`,
            [digest(request.cookies.ao_session)],
          )
        : [],
  );
  const row = rows[0];
  if (!row && !bearer && request.cookies.ao_session) {
    const [accountOnly] = await identityScope(() =>
      db.query(
        'SELECT a.email_verified_at FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.membership_id IS NULL AND s.expires_at>now() AND s.auth_version=a.auth_version AND a.disabled_at IS NULL',
        [digest(request.cookies.ao_session!)],
      ),
    );
    if (accountOnly) {
      if (!accountOnly.email_verified_at)
        throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address to continue.');
      throw new AppError(
        403,
        'WORKSPACE_REQUIRED',
        'Choose or create an organization workspace to continue.',
      );
    }
  }
  if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  if (!bearer && !row.email_verified_at)
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address to continue.');
  if (!bearer && (row.mfa_enabled || row.require_mfa) && !row.mfa_verified_at)
    throw new AppError(
      403,
      'MFA_ENROLLMENT_REQUIRED',
      'Set up two-factor authentication in account security to access this organization.',
    );
  if (!bearer && row.require_sso && !row.sso_authorized)
    throw new AppError(403, 'SSO_REQUIRED', 'Sign in with your organization’s identity provider.');
  if (
    !bearer &&
    row.access_type !== 'guest' &&
    (row.allowed_domains as string[]).length &&
    !(row.allowed_domains as string[]).includes(String(row.email).split('@')[1]!)
  )
    throw new AppError(
      403,
      'DOMAIN_RESTRICTED',
      'This email domain is no longer allowed by the organization.',
    );
  identifyWorkspace(String(row.workspace_id));
  identifyPrincipal(String(row.id), String(row.access_type));
  if (row.credential_id) identifyAgentCredential(String(row.credential_id));
  const identity: Identity = {
    workspaceId: String(row.workspace_id),
    membershipId: String(row.id),
    name: String(row.name),
    role: row.role as Identity['role'],
    kind: row.kind as Identity['kind'],
    ...(row.credential_id
      ? {
          credentialId: String(row.credential_id),
          credentialScopes: row.credential_scopes as string[],
        }
      : {}),
    ...(row.account_id ? { accountId: String(row.account_id) } : {}),
    ...(row.principal_auth_version != null
      ? {
          authVersion: Number(row.principal_auth_version),
          policyVersion: Number(row.principal_policy_version),
        }
      : {}),
    accessType: row.access_type as NonNullable<Identity['accessType']>,
    permissions: row.permissions as NonNullable<Identity['permissions']>,
  };
  authorizeRequest(identity, request);
  if (identity.credentialId)
    await identityScope(
      () =>
        db.query(
          "UPDATE agent_credentials SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')",
          [identity.credentialId],
        ),
      identity.workspaceId,
    );
  if (bearer && row.access_type === 'service')
    await identityScope(() =>
      db.query(
        "UPDATE service_credentials SET last_used_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at<now()-interval '5 minutes')",
        [digest(bearer)],
      ),
    );
  if (!bearer)
    await identityScope(() =>
      db.query(
        "UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND last_seen_at<now()-interval '1 minute'",
        [digest(request.cookies.ao_session!)],
      ),
    );
  return identity;
}
export function authRoutes(
  app: FastifyInstance,
  db: Database,
  production: boolean,
  email: EmailService,
  security: AccountSecurity,
  region = 'global',
) {
  const accounts = new AccountService(db, email);
  const session = (
    accountId: string,
    memberId: string | null,
    workspaceId: string | null,
    authVersion?: number,
    metadata: ReturnType<typeof sessionMetadata> = { userAgent: '', ipAddress: '' },
  ) =>
    identityScope(
      () =>
        db.transaction((tx) => createSignInSession(tx, accountId, memberId, authVersion, metadata)),
      workspaceId,
    );
  const cookie = sessionCookie(production);
  app.post(
    '/v1/auth/signup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = signUpInput.parse(req.body);
      email.requireConfigured();
      const passwordHash = await hashPassword(input.password);
      const accountId = randomUUID(),
        workspaceId = randomUUID(),
        memberId = randomUUID();
      const value = await identityScope(
        () =>
          db.transaction(async (tx) => {
            await tx.query(
              'INSERT INTO accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
              [accountId, input.email, input.name, passwordHash],
            );
            await tx.query('INSERT INTO workspaces(id,name,region) VALUES($1,$2,$3)', [
              workspaceId,
              input.workspace,
              region,
            ]);
            await tx.query(
              "INSERT INTO memberships(id,workspace_id,account_id,name,kind,role) VALUES($1,$2,$3,$4,'human','owner')",
              [memberId, workspaceId, accountId, input.name],
            );
            await accounts.queueProof(tx, accountId, input.email, 'verify_email');
            for (const [name, description] of [
              ['general', 'Shared updates and team conversations'],
              ['engineering', 'Build, investigate, and ship together'],
              ['ideas', 'Explore what comes next'],
            ]) {
              await tx.query(
                "INSERT INTO conversations(id,workspace_id,name,description,visibility) VALUES($1,$2,$3,$4,'public')",
                [randomUUID(), workspaceId, name, description],
              );
            }
            return createSession(tx, accountId, memberId, undefined, sessionMetadata(req));
          }),
        workspaceId,
      ).catch((error: unknown) => {
        const failure = error as { code?: string; constraint?: string };
        if (failure?.code === '23505' && failure.constraint === 'accounts_email_key')
          throw new AppError(
            409,
            'EMAIL_IN_USE',
            'An account with this email already exists. Sign in or reset your password.',
          );
        throw error;
      });
      reply.setCookie('ao_session', value, cookie);
      return reply.code(201).send({ ok: true });
    },
  );
  app.post(
    '/v1/auth/signin',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = signInInput.parse(req.body);
      const [account] = await identityScope(() =>
        db.query(
          `SELECT a.id,a.password_hash,a.auth_version,a.mfa_enabled,m.id AS membership_id,m.workspace_id FROM accounts a LEFT JOIN LATERAL(SELECT m.id,m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id JOIN organizations o ON o.id=w.organization_id JOIN organization_members om ON om.organization_id=w.organization_id AND om.account_id=m.account_id WHERE m.account_id=a.id AND m.status='active' AND om.status='active' AND public.organization_live(m.workspace_id) ORDER BY o.require_sso,m.id LIMIT 1) m ON true WHERE a.email=$1 AND a.disabled_at IS NULL`,
          [input.email],
        ),
      );
      const fallback = '00000000000000000000000000000000:' + '00'.repeat(64);
      const valid = await verifyPassword(
        input.password,
        String(account?.password_hash ?? fallback),
      );
      if (!account || !valid)
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      if (account.mfa_enabled) {
        const challenge = await identityScope(() =>
          db.transaction(async (tx) => {
            const [current] = await tx.query(
              'SELECT auth_version FROM accounts WHERE id=$1 FOR UPDATE',
              [account.id],
            );
            if (current?.auth_version !== account.auth_version)
              throw new AppError(401, 'CREDENTIALS_CHANGED', 'Sign in again.');
            return security.challenge(
              tx,
              String(account.id),
              account.membership_id ? String(account.membership_id) : null,
              Number(account.auth_version),
            );
          }),
        );
        reply.clearCookie('ao_session', { path: '/' });
        reply.setCookie('ao_mfa', challenge, { ...cookie, maxAge: 300 });
        return { mfaRequired: true };
      }
      reply.setCookie(
        'ao_session',
        await session(
          String(account.id),
          account.membership_id ? String(account.membership_id) : null,
          account.workspace_id ? String(account.workspace_id) : null,
          Number(account.auth_version),
          sessionMetadata(req),
        ),
        cookie,
      );
      return { ok: true };
    },
  );
  app.post('/v1/auth/signout', async (req, reply) => {
    if (req.cookies.ao_session)
      await identityScope(() =>
        db.query('DELETE FROM sessions WHERE token_hash=$1', [digest(req.cookies.ao_session!)]),
      );
    if (req.cookies.ao_mfa)
      await identityScope(() =>
        db.query('DELETE FROM authentication_challenges WHERE token_hash=$1', [
          digest(req.cookies.ao_mfa!),
        ]),
      );
    if (req.cookies.ao_federation)
      await identityScope(() =>
        db.query('DELETE FROM federation_transactions WHERE browser_hash=$1', [
          digest(req.cookies.ao_federation!),
        ]),
      );
    reply.clearCookie('ao_session', { path: '/' });
    reply.clearCookie('ao_mfa', { path: '/' });
    reply.clearCookie('ao_federation', { path: '/' });
    return { ok: true };
  });
}
