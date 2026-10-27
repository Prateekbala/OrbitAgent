import { identityScope, scopedDatabase, type Database } from '@ao/database';
export class IdentityCleanupWorker {
  private readonly db: Database;
  private pending: Promise<void> | null = null;
  constructor(
    db: Database,
    private readonly onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    if (this.pending) return this.pending;
    this.pending = identityScope(async () => {
      for (const [table, key, predicate, order] of [
        ['sessions', 'token_hash', 'expires_at<=now()', 'expires_at'],
        ['authentication_challenges', 'token_hash', 'expires_at<=now()', 'expires_at'],
        ['federation_transactions', 'token_hash', 'expires_at<=now()', 'expires_at'],
        ['saml_request_ids', 'id', "created_at<=now()-interval '5 minutes'", 'created_at'],
        ['account_mfa', 'account_id', 'confirmed_at IS NULL AND expires_at<=now()', 'expires_at'],
      ] as const)
        await this.db.query(
          `DELETE FROM ${table} WHERE ${key} IN(SELECT ${key} FROM ${table} WHERE ${predicate} ORDER BY ${order},${key} LIMIT 1000)`,
        );
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  start(interval = 60000) {
    const run = () => {
      void this.tick().catch(() => this.onError('IDENTITY_CLEANUP_FAILED'));
    };
    const timer = setInterval(run, interval);
    timer.unref();
    run();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
}
