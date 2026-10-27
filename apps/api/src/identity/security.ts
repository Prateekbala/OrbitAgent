import { randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { identityScope, identifyAccountSession, type Database, type Sql } from '@ao/database';
import type { FastifyRequest } from 'fastify';
import { digest, verifyPassword, token } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
import { securityEvent } from './tokens.js';
import { IdentitySecrets } from './secrets.js';
import { createSession } from '../lib/sessions.js';
export interface AccountSessionRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  membership_id: string | null;
  workspace_id: string | null;
  auth_version: number;
  mfa_verified_at: Date | null;
  authentication_method: 'password' | 'oidc' | 'saml';
  provider_id: string | null;
  created_at: Date;
  user_agent: string;
  ip_address: string;
}
export async function lookupAccountSession(db: Database, value: string | undefined) {
  if (!value) return undefined;
  const [row] = await identityScope(() =>
    db.query<AccountSessionRow>(
      `SELECT s.*,EXISTS(SELECT 1 FROM identity_providers ip JOIN federated_identities fi ON fi.provider_id=ip.id WHERE ip.id=s.provider_id AND ip.organization_id=w.organization_id AND ip.protocol=s.authentication_method AND ip.enabled AND fi.account_id=a.id) sso_authorized,a.email_verified_at,a.mfa_enabled,a.email,m.access_type,o.allowed_domains,o.require_mfa,o.require_sso FROM sessions s JOIN accounts a ON a.id=s.account_id LEFT JOIN memberships m ON m.id=s.membership_id LEFT JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN organizations o ON o.id=w.organization_id LEFT JOIN organization_members om ON om.organization_id=w.organization_id AND om.account_id=a.id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.created_at>now()-coalesce(o.session_hours,168)*interval '1 hour' AND s.auth_version=a.auth_version AND a.disabled_at IS NULL AND (s.membership_id IS NULL OR (m.status='active' AND om.status='active'))`,
      [digest(value)],
    ),
  );
  return row;
}
export async function currentSession(db: Database, request: FastifyRequest) {
  const row = await lookupAccountSession(db, request.cookies.ao_session);
  if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  if (!row.email_verified_at)
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address to continue.');
  identifyAccountSession(row.id);
  return row;
}
export function sessionMetadata(req: FastifyRequest) {
  return {
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 500),
    ipAddress: req.ip.slice(0, 80),
  };
}
export class AccountSecurity {
  constructor(
    readonly db: Database,
    readonly secrets: IdentitySecrets,
  ) {}
  async verifyMfa(tx: Sql, accountId: string, code: string) {
    const [mfa] = await tx.query(
      'SELECT * FROM account_mfa WHERE account_id=$1 AND confirmed_at IS NOT NULL FOR UPDATE',
      [accountId],
    );
    if (!mfa) return false;
    const hashes = mfa.recovery_hashes as string[];
    const hash = digest(code.replace(/[\s-]/g, '').toLowerCase());
    if (hashes.includes(hash)) {
      await tx.query(
        'UPDATE account_mfa SET recovery_hashes=array_remove(recovery_hashes,$2) WHERE account_id=$1',
        [accountId, hash],
      );
      await securityEvent(tx, accountId, 'mfa.recovery_used');
      return true;
    }
    if (!/^\d{6}$/.test(code)) return false;
    const result = await verify({
      secret: this.secrets.open('mfa:' + accountId, String(mfa.secret)),
      token: code,
      epochTolerance: 30,
      afterTimeStep: Number(mfa.last_step),
    });
    if (!result.valid || !('timeStep' in result)) return false;
    await tx.query('UPDATE account_mfa SET last_step=$2 WHERE account_id=$1', [
      accountId,
      result.timeStep,
    ]);
    return true;
  }
  async prove(
    tx: Sql,
    session: AccountSessionRow,
    input: { password: string; code?: string | undefined },
  ) {
    const [account] = await tx.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [
      session.account_id,
    ]);
    if (
      !account ||
      account.auth_version !== session.auth_version ||
      !(await verifyPassword(input.password, String(account.password_hash)))
    )
      throw new AppError(401, 'INVALID_CREDENTIALS', 'The current password is incorrect.');
    if (account.mfa_enabled && !(await this.verifyMfa(tx, session.account_id, input.code ?? '')))
      throw new AppError(401, 'MFA_INVALID', 'Enter a fresh authenticator or recovery code.');
    return account;
  }
  async beginEnrollment(
    session: AccountSessionRow,
    input: { password: string; code?: string | undefined },
  ) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const account = await this.prove(tx, session, input);
        if (account.mfa_enabled) throw new AppError(409, 'MFA_ENABLED', 'MFA is already enabled.');
        const secret = generateSecret();
        await tx.query(
          "INSERT INTO account_mfa(account_id,secret) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET secret=excluded.secret,expires_at=now()+interval '10 minutes',last_step=-1,recovery_hashes='{}'",
          [session.account_id, this.secrets.seal('mfa:' + session.account_id, secret)],
        );
        return {
          secret,
          uri: generateURI({ issuer: 'Orbit', label: String(account.email), secret }),
        };
      }),
    );
  }
  async confirmEnrollment(session: AccountSessionRow, code: string) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const [account] = await tx.query(
          'SELECT mfa_enabled,auth_version FROM accounts WHERE id=$1 FOR UPDATE',
          [session.account_id],
        );
        const [mfa] = await tx.query(
          'SELECT * FROM account_mfa WHERE account_id=$1 AND confirmed_at IS NULL AND expires_at>now() FOR UPDATE',
          [session.account_id],
        );
        if (!mfa || account?.mfa_enabled || account?.auth_version !== session.auth_version)
          throw new AppError(409, 'ENROLLMENT_EXPIRED', 'Start a new authenticator enrollment.');
        const result = await verify({
          secret: this.secrets.open('mfa:' + session.account_id, String(mfa.secret)),
          token: code,
          epochTolerance: 30,
        });
        if (!result.valid || !('timeStep' in result))
          throw new AppError(401, 'MFA_INVALID', 'The authenticator code is incorrect.');
        const codes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex'));
        await tx.query(
          'UPDATE account_mfa SET confirmed_at=now(),last_step=$2,recovery_hashes=$3 WHERE account_id=$1',
          [session.account_id, result.timeStep, codes.map(digest)],
        );
        await tx.query('UPDATE accounts SET mfa_enabled=true WHERE id=$1', [session.account_id]);
        await tx.query('DELETE FROM sessions WHERE account_id=$1', [session.account_id]);
        await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [
          session.workspace_id ?? '',
        ]);
        const value = await createSession(
          tx,
          session.account_id,
          session.membership_id,
          session.auth_version,
          {
            mfaVerifiedAt: new Date(),
            method: session.authentication_method,
            providerId: session.provider_id,
            userAgent: String(session.user_agent),
            ipAddress: String(session.ip_address),
          },
        );
        await securityEvent(tx, session.account_id, 'mfa.enabled');
        return { recoveryCodes: codes, session: value };
      }),
    );
  }
  async challenge(
    tx: Sql,
    accountId: string,
    memberId: string | null,
    version: number,
    method = 'password',
    providerId?: string,
  ) {
    const value = token();
    await tx.query(
      'DELETE FROM authentication_challenges WHERE account_id=$1 OR expires_at<=now()',
      [accountId],
    );
    await tx.query(
      'INSERT INTO authentication_challenges(token_hash,account_id,membership_id,auth_version,method,provider_id) VALUES($1,$2,$3,$4,$5,$6)',
      [digest(value), accountId, memberId, version, method, providerId ?? null],
    );
    return value;
  }
}
