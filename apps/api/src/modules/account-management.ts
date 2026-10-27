import { randomBytes } from 'node:crypto';
import { identityScope, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import {
  profileInput,
  changeEmailInput,
  changePasswordInput,
  securityProof,
  mfaCode,
  id,
} from '@ao/contracts';
import { AppError, notFound } from '../lib/errors.js';
import { digest, hashPassword } from '../lib/security.js';
import { createSignInSession, sessionCookie } from '../lib/sessions.js';
import { AccountSecurity, currentSession, sessionMetadata } from '../identity/security.js';
import { issueAccountToken, securityEvent } from '../identity/tokens.js';
import type { EmailService } from '../email/service.js';
export function accountManagementRoutes(
  app: FastifyInstance,
  db: Database,
  security: AccountSecurity,
  email: EmailService,
  production: boolean,
) {
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.get('/v1/account', async (req) => {
    const session = await currentSession(db, req);
    return identityScope(async () => {
      const [account] = await db.query(
        `SELECT a.id,a.email,a.name,a.time_zone,a.locale,a.mfa_enabled,(SELECT target_email FROM account_tokens WHERE account_id=a.id AND purpose='change_email' AND consumed_at IS NULL AND expires_at>now()) pending_email FROM accounts a WHERE id=$1`,
        [session.account_id],
      );
      return account;
    });
  });
  app.patch('/v1/account', async (req) => {
    const session = await currentSession(db, req),
      input = profileInput.parse(req.body);
    await identityScope(() =>
      db.transaction(async (tx) => {
        await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [session.account_id]);
        await tx.query('UPDATE accounts SET name=$2,time_zone=$3,locale=$4 WHERE id=$1', [
          session.account_id,
          input.name,
          input.timeZone,
          input.locale,
        ]);
        const memberships = await tx.query(
          'SELECT id,workspace_id FROM memberships WHERE account_id=$1',
          [session.account_id],
        );
        for (const member of memberships) {
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [
            member?.workspace_id ?? '',
          ]);
          await tx.query('UPDATE memberships SET name=$2,version=version+1 WHERE id=$1', [
            member.id,
            input.name,
          ]);
        }
        await securityEvent(tx, session.account_id, 'profile.updated');
      }),
    );
    return { ok: true };
  });
  app.post('/v1/account/email', limited, async (req) => {
    const session = await currentSession(db, req),
      input = changeEmailInput.parse(req.body);
    email.requireConfigured();
    await identityScope(() =>
      db.transaction(async (tx) => {
        const account = await security.prove(tx, session, input);
        if (account.email === input.email)
          throw new AppError(400, 'EMAIL_UNCHANGED', 'Choose a different email address.');
        const [recent] = await tx.query(
          "SELECT id FROM account_tokens WHERE account_id=$1 AND purpose='change_email' AND created_at>now()-interval '1 minute'",
          [session.account_id],
        );
        if (recent)
          throw new AppError(
            429,
            'EMAIL_COOLDOWN',
            'Wait a minute before requesting another change.',
          );
        const policies = await tx.query(
          `SELECT o.allowed_domains FROM organizations o JOIN organization_members om ON om.organization_id=o.id WHERE om.account_id=$1 AND om.status='active'`,
          [session.account_id],
        );
        if (
          policies.some(
            (p) =>
              (p.allowed_domains as string[]).length &&
              !(p.allowed_domains as string[]).includes(input.email.split('@')[1]!),
          )
        )
          throw new AppError(
            403,
            'DOMAIN_RESTRICTED',
            'The new address must satisfy every active organization domain policy.',
          );
        const proof = await issueAccountToken(tx, session.account_id, 'change_email');
        await tx.query('UPDATE account_tokens SET target_email=$2 WHERE id=$1', [
          proof.id,
          input.email,
        ]);
        await tx.query(
          "UPDATE email_jobs SET status='cancelled',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE account_token_id IN (SELECT id FROM account_tokens WHERE account_id=$1 AND purpose='change_email' AND consumed_at IS NOT NULL) AND status IN ('queued','sending')",
          [session.account_id],
        );
        await email.enqueue(tx, {
          kind: 'change_email',
          to: input.email,
          token: proof.value,
          accountTokenId: proof.id,
        });
      }),
    );
    return { ok: true };
  });
  app.post('/v1/account/password', limited, async (req, reply) => {
    const session = await currentSession(db, req),
      input = changePasswordInput.parse(req.body),
      hash = await hashPassword(input.newPassword);
    await identityScope(() =>
      db.transaction(async (tx) => {
        await security.prove(tx, session, input);
        await tx.query(
          'UPDATE accounts SET password_hash=$2,auth_version=auth_version+1 WHERE id=$1',
          [session.account_id, hash],
        );
        await tx.query('DELETE FROM sessions WHERE account_id=$1', [session.account_id]);
        await tx.query('DELETE FROM authentication_challenges WHERE account_id=$1', [
          session.account_id,
        ]);
        await tx.query(
          'UPDATE account_tokens SET consumed_at=now() WHERE account_id=$1 AND consumed_at IS NULL',
          [session.account_id],
        );
        await securityEvent(tx, session.account_id, 'password.changed');
      }),
    );
    reply.clearCookie('ao_session', { path: '/' });
    return { ok: true };
  });
  app.get('/v1/account/sessions', async (req) => {
    const session = await currentSession(db, req);
    return identityScope(() =>
      db.query(
        `SELECT s.id,s.id=$2 current,coalesce(w.name,'Account') workspace_name,s.user_agent,s.ip_address,s.created_at,s.last_seen_at,s.expires_at,s.authentication_method,s.mfa_verified_at FROM sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id WHERE s.account_id=$1 AND s.expires_at>now() ORDER BY s.created_at DESC LIMIT 200`,
        [session.account_id, session.id],
      ),
    );
  });
  app.delete('/v1/account/sessions/:id', async (req, reply) => {
    const session = await currentSession(db, req),
      target = id.parse((req.params as { id: string }).id);
    await identityScope(() =>
      db.transaction(async (tx) => {
        const rows = await tx.query(
          'DELETE FROM sessions WHERE id=$1 AND account_id=$2 RETURNING id',
          [target, session.account_id],
        );
        if (!rows.length) throw notFound();
        await securityEvent(tx, session.account_id, 'session.revoked');
      }),
    );
    if (target === session.id) reply.clearCookie('ao_session', { path: '/' });
    return { ok: true };
  });
  app.post('/v1/account/sessions/revoke-others', limited, async (req) => {
    const session = await currentSession(db, req);
    await identityScope(() =>
      db.transaction(async (tx) => {
        await security.prove(tx, session, securityProof.parse(req.body));
        await tx.query('DELETE FROM sessions WHERE account_id=$1 AND id<>$2', [
          session.account_id,
          session.id,
        ]);
        await tx.query('DELETE FROM authentication_challenges WHERE account_id=$1', [
          session.account_id,
        ]);
        await securityEvent(tx, session.account_id, 'sessions.revoked');
      }),
    );
    return { ok: true };
  });
  app.get('/v1/account/security-events', async (req) => {
    const session = await currentSession(db, req);
    return identityScope(() =>
      db.query(
        'SELECT id,event_type,created_at FROM account_security_events WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
        [session.account_id],
      ),
    );
  });
  app.post('/v1/account/mfa/enroll', limited, async (req) =>
    security.beginEnrollment(await currentSession(db, req), securityProof.parse(req.body)),
  );
  app.post('/v1/account/mfa/confirm', limited, async (req, reply) => {
    const result = await security.confirmEnrollment(
      await currentSession(db, req),
      mfaCode.parse(req.body).code,
    );
    reply.setCookie('ao_session', result.session, sessionCookie(production));
    return { recoveryCodes: result.recoveryCodes };
  });
  app.post('/v1/account/mfa/disable', limited, async (req) => {
    const session = await currentSession(db, req),
      input = securityProof.parse(req.body);
    await identityScope(() =>
      db.transaction(async (tx) => {
        await security.prove(tx, session, input);
        const required = await tx.query(
          "SELECT o.id FROM organizations o JOIN organization_members om ON om.organization_id=o.id WHERE om.account_id=$1 AND om.status='active' AND o.require_mfa",
          [session.account_id],
        );
        if (required.length)
          throw new AppError(409, 'MFA_POLICY_REQUIRED', 'An organization requires MFA.');
        await tx.query(
          'UPDATE accounts SET mfa_enabled=false,auth_version=auth_version+1 WHERE id=$1',
          [session.account_id],
        );
        await tx.query('DELETE FROM account_mfa WHERE account_id=$1', [session.account_id]);
        await tx.query('DELETE FROM sessions WHERE account_id=$1', [session.account_id]);
        await securityEvent(tx, session.account_id, 'mfa.disabled');
      }),
    );
    return { ok: true };
  });
  app.post('/v1/account/mfa/recovery-codes', limited, async (req) => {
    const session = await currentSession(db, req),
      input = securityProof.parse(req.body);
    return identityScope(() =>
      db.transaction(async (tx) => {
        const account = await security.prove(tx, session, input);
        if (!account.mfa_enabled) throw new AppError(409, 'MFA_NOT_ENABLED', 'Enable MFA first.');
        const codes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex'));
        await tx.query('UPDATE account_mfa SET recovery_hashes=$2 WHERE account_id=$1', [
          session.account_id,
          codes.map(digest),
        ]);
        await securityEvent(tx, session.account_id, 'mfa.recovery_rotated');
        return { recoveryCodes: codes };
      }),
    );
  });
  app.post('/v1/auth/mfa', limited, async (req, reply) => {
    const input = mfaCode.parse(req.body),
      hash = digest(req.cookies.ao_mfa ?? '');
    const result = await identityScope(() =>
      db.transaction(async (tx) => {
        const [reference] = await tx.query(
          'SELECT account_id FROM authentication_challenges WHERE token_hash=$1',
          [hash],
        );
        if (!reference) return null;
        const [account] = await tx.query(
          'SELECT auth_version,mfa_enabled FROM accounts WHERE id=$1 FOR UPDATE',
          [reference.account_id],
        );
        const [challenge] = await tx.query(
          'SELECT * FROM authentication_challenges WHERE token_hash=$1 AND expires_at>now() AND attempts<5 FOR UPDATE',
          [hash],
        );
        if (
          !challenge ||
          !account ||
          challenge.auth_version !== account.auth_version ||
          !account.mfa_enabled
        )
          return null;
        await tx.query(
          'UPDATE authentication_challenges SET attempts=attempts+1 WHERE token_hash=$1',
          [hash],
        );
        if (!(await security.verifyMfa(tx, String(reference.account_id), input.code))) return null;
        await tx.query('DELETE FROM authentication_challenges WHERE token_hash=$1', [hash]);
        const [member] = await tx.query('SELECT workspace_id FROM memberships WHERE id=$1', [
          challenge.membership_id,
        ]);
        if (challenge.membership_id && !member) return null;
        await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [
          member?.workspace_id ?? '',
        ]);
        return createSignInSession(
          tx,
          String(reference.account_id),
          challenge.membership_id ? String(challenge.membership_id) : null,
          Number(challenge.auth_version),
          {
            ...sessionMetadata(req),
            mfaVerifiedAt: new Date(),
            method: challenge.method as 'password' | 'oidc' | 'saml',
            providerId: challenge.provider_id ? String(challenge.provider_id) : null,
          },
        );
      }),
    );
    if (!result)
      throw new AppError(
        401,
        'MFA_INVALID',
        'This challenge or code is invalid, expired, or already used.',
      );
    reply.clearCookie('ao_mfa', { path: '/' });
    reply.setCookie('ao_session', result, sessionCookie(production));
    return { ok: true };
  });
  app.get('/v1/account/identities', async (req) => {
    const session = await currentSession(db, req);
    return identityScope(() =>
      db.query(
        'SELECT p.id,p.name,p.protocol,p.organization_id FROM federated_identities f JOIN identity_providers p ON p.id=f.provider_id WHERE f.account_id=$1',
        [session.account_id],
      ),
    );
  });
  app.delete('/v1/account/identities/:id', limited, async (req) => {
    const session = await currentSession(db, req),
      provider = id.parse((req.params as { id: string }).id);
    await identityScope(() =>
      db.transaction(async (tx) => {
        await security.prove(tx, session, securityProof.parse(req.body));
        const [required] = await tx.query(
          'SELECT p.id FROM identity_providers p JOIN organizations o ON o.id=p.organization_id WHERE p.id=$1 AND o.require_sso',
          [provider],
        );
        if (required)
          throw new AppError(
            409,
            'SSO_POLICY_REQUIRED',
            'This identity is required by organization policy.',
          );
        await tx.query('DELETE FROM federated_identities WHERE provider_id=$1 AND account_id=$2', [
          provider,
          session.account_id,
        ]);
        await tx.query('DELETE FROM sessions WHERE provider_id=$1 AND account_id=$2', [
          provider,
          session.account_id,
        ]);
        await securityEvent(tx, session.account_id, 'federation.unlinked');
      }),
    );
    return { ok: true };
  });
}
