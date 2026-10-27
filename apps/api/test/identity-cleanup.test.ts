import { it, expect } from 'vitest';
import { messagingFixture } from './messaging-fixture.js';
import { IdentityCleanupWorker } from '../src/identity/worker.js';
import { token, digest } from '../src/lib/security.js';
it('prunes expired account sessions and challenges while preserving valid sessions and confirmed MFA', async () => {
  const f = await messagingFixture();
  try {
    const account = (await f.call(f.owner, 'GET', '/v1/account')).json();
    await f.db.query(
      "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",
      [digest(f.owner)],
    );
    await f.db.query(
      "INSERT INTO authentication_challenges(token_hash,account_id,membership_id,auth_version,expires_at) VALUES($1,$2,$3,1,now()-interval '1 minute')",
      [digest(token()), account.id, f.ownerBoot.me.id],
    );
    await f.db.query(
      "INSERT INTO account_mfa(account_id,secret,confirmed_at,expires_at) VALUES($1,'test-only-confirmed-seed',now(),now()-interval '1 minute')",
      [account.id],
    );
    const worker = new IdentityCleanupWorker(f.db);
    await worker.tick();
    expect(
      await f.db.query('SELECT token_hash FROM sessions WHERE token_hash=$1', [digest(f.owner)]),
    ).toEqual([]);
    expect(await f.db.query('SELECT token_hash FROM authentication_challenges')).toEqual([]);
    expect((await f.call(f.other, 'GET', '/v1/bootstrap')).statusCode).toBe(200);
    expect(
      await f.db.query('SELECT account_id FROM account_mfa WHERE account_id=$1', [account.id]),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
