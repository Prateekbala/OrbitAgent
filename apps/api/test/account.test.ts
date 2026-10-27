import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { identityScope, scopedDatabase, migrate, type Database } from '@ao/database';
import { testDatabase } from './database.js';
import { hashPassword, verifyPassword } from '../src/lib/security.js';
import { issueAccountToken, consumeAccountToken } from '../src/identity/tokens.js';
let db: Database, scoped: Database;
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
  scoped = scopedDatabase(db);
}, 30000);
afterAll(async () => db.close());
async function account() {
  const id = randomUUID();
  await db.query('INSERT INTO accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
    id,
    id + '@identity.test',
    'Identity Test',
    await hashPassword('original-account-password'),
  ]);
  return id;
}
async function issue(id: string, purpose: 'verify_email' | 'reset_password') {
  return identityScope(() =>
    scoped.transaction(async (tx) => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [id]);
      return issueAccountToken(tx, id, purpose);
    }),
  );
}
describe('account security tokens', () => {
  it('stores only a hash, verifies email once, and enforces token purpose', async () => {
    const id = await account(),
      proof = await issue(id, 'verify_email');
    const [row] = await db.query('SELECT token_hash FROM account_tokens WHERE id=$1', [proof.id]);
    expect(row?.token_hash).not.toBe(proof.value);
    await expect(
      consumeAccountToken(scoped, proof.value, 'reset_password', 'replacement-password'),
    ).rejects.toThrow('invalid, expired');
    await consumeAccountToken(scoped, proof.value, 'verify_email');
    expect(
      (await db.query('SELECT email_verified_at FROM accounts WHERE id=$1', [id]))[0]
        ?.email_verified_at,
    ).toBeTruthy();
    await expect(consumeAccountToken(scoped, proof.value, 'verify_email')).rejects.toThrow(
      'already used',
    );
  });
  it('invalidates previous links on reissue and rejects expired links', async () => {
    const id = await account(),
      old = await issue(id, 'verify_email'),
      current = await issue(id, 'verify_email');
    await expect(consumeAccountToken(scoped, old.value, 'verify_email')).rejects.toThrow(
      'already used',
    );
    await db.query("UPDATE account_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [
      current.id,
    ]);
    await expect(consumeAccountToken(scoped, current.value, 'verify_email')).rejects.toThrow(
      'expired',
    );
  });
  it('allows one concurrent reset, changes the hash, increments credential version and invalidates all open proofs', async () => {
    const id = await account(),
      proof = await issue(id, 'reset_password');
    await issue(id, 'verify_email');
    const attempts = await Promise.allSettled([
      consumeAccountToken(scoped, proof.value, 'reset_password', 'replacement-password'),
      consumeAccountToken(scoped, proof.value, 'reset_password', 'replacement-password'),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const [row] = await db.query('SELECT password_hash,auth_version FROM accounts WHERE id=$1', [
      id,
    ]);
    expect(await verifyPassword('replacement-password', String(row!.password_hash))).toBe(true);
    expect(await verifyPassword('original-account-password', String(row!.password_hash))).toBe(
      false,
    );
    expect(row?.auth_version).toBe(2);
    expect(
      await db.query('SELECT id FROM account_tokens WHERE account_id=$1 AND consumed_at IS NULL', [
        id,
      ]),
    ).toHaveLength(0);
  });
  it('does not expose account tokens or security events to a tenant role', async () => {
    await expect(scoped.query('SELECT * FROM account_tokens')).rejects.toThrow('permission denied');
    await expect(scoped.query('SELECT * FROM account_security_events')).rejects.toThrow(
      'permission denied',
    );
  });
});
