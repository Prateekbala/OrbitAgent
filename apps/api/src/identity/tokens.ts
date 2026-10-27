import { randomUUID } from 'node:crypto';
import type { Sql, Database } from '@ao/database';
import { identityScope } from '@ao/database';
import { digest, hashPassword, token } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
export type TokenPurpose = 'verify_email' | 'reset_password' | 'change_email';
const unavailable = () =>
  new AppError(
    410,
    'TOKEN_UNAVAILABLE',
    'This link is invalid, expired, or already used. Request a new email.',
  );
export async function securityEvent(tx: Sql, accountId: string, event: string) {
  await tx.query('INSERT INTO account_security_events(id,account_id,event_type) VALUES($1,$2,$3)', [
    randomUUID(),
    accountId,
    event,
  ]);
}
export async function issueAccountToken(tx: Sql, accountId: string, purpose: TokenPurpose) {
  await tx.query(
    'UPDATE account_tokens SET consumed_at=now() WHERE account_id=$1 AND purpose=$2 AND consumed_at IS NULL',
    [accountId, purpose],
  );
  const value = token(),
    id = randomUUID();
  await tx.query(
    'INSERT INTO account_tokens(id,account_id,purpose,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+$5::interval)',
    [id, accountId, purpose, digest(value), purpose === 'verify_email' ? '24 hours' : '30 minutes'],
  );
  await securityEvent(tx, accountId, purpose + '.requested');
  return { id, value };
}
async function tokenAccount(db: Database, value: string, purpose: TokenPurpose) {
  const [row] = await db.query(
    'SELECT account_id FROM account_tokens WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>now()',
    [digest(value), purpose],
  );
  if (!row) throw unavailable();
  return String(row.account_id);
}
export async function consumeAccountToken(
  db: Database,
  value: string,
  purpose: TokenPurpose,
  password?: string,
) {
  return identityScope(async () => {
    const accountId = await tokenAccount(db, value, purpose);
    const passwordHash =
      purpose === 'reset_password' && password ? await hashPassword(password) : null;
    if (purpose === 'reset_password' && !passwordHash)
      throw new Error('A password is required for recovery.');
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [accountId]);
      const [current] = await tx.query(
        'SELECT id,target_email FROM account_tokens WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
        [digest(value), purpose],
      );
      if (!current) throw unavailable();
      if (purpose === 'change_email') {
        if (!current.target_email) throw unavailable();
        const policies = await tx.query(
          "SELECT o.allowed_domains FROM organizations o JOIN organization_members om ON om.organization_id=o.id WHERE om.account_id=$1 AND om.status='active'",
          [accountId],
        );
        if (
          policies.some(
            (p) =>
              (p.allowed_domains as string[]).length &&
              !(p.allowed_domains as string[]).includes(
                String(current.target_email).split('@')[1]!,
              ),
          )
        )
          throw new AppError(
            403,
            'DOMAIN_RESTRICTED',
            'This address no longer satisfies organization policy.',
          );
        await tx.query(
          'UPDATE accounts SET email=$2,email_verified_at=now(),auth_version=auth_version+1 WHERE id=$1',
          [accountId, current.target_email],
        );
        await tx.query('DELETE FROM sessions WHERE account_id=$1', [accountId]);
      } else if (purpose === 'verify_email')
        await tx.query(
          'UPDATE accounts SET email_verified_at=coalesce(email_verified_at,now()) WHERE id=$1',
          [accountId],
        );
      else {
        await tx.query(
          'UPDATE accounts SET password_hash=$1,auth_version=auth_version+1,email_verified_at=coalesce(email_verified_at,now()) WHERE id=$2',
          [passwordHash, accountId],
        );
        await tx.query('DELETE FROM sessions WHERE account_id=$1', [accountId]);
      }
      await tx.query(
        "UPDATE account_tokens SET consumed_at=now() WHERE account_id=$1 AND consumed_at IS NULL AND (purpose=$2 OR $2 IN ('reset_password','change_email'))",
        [accountId, purpose],
      );
      await tx.query(
        "UPDATE email_jobs SET status='cancelled',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE account_token_id IN (SELECT id FROM account_tokens WHERE account_id=$1 AND consumed_at IS NOT NULL) AND status IN ('queued','sending')",
        [accountId],
      );
      await securityEvent(tx, accountId, purpose + '.completed');
    });
  });
}
