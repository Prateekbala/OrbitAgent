import type { Database, Sql } from '@ao/database';
import { identityScope } from '@ao/database';
import { EmailService } from '../email/service.js';
import { issueAccountToken, type TokenPurpose } from './tokens.js';
import { lookupAccountSession } from './security.js';
export class AccountService {
  constructor(
    private readonly db: Database,
    private readonly email: EmailService,
  ) {}
  async queueProof(tx: Sql, accountId: string, email: string, purpose: TokenPurpose) {
    const proof = await issueAccountToken(tx, accountId, purpose);
    await tx.query(
      "UPDATE email_jobs SET status='cancelled',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE account_token_id IN (SELECT id FROM account_tokens WHERE account_id=$1 AND purpose=$2) AND status IN ('queued','sending')",
      [accountId, purpose],
    );
    await this.email.enqueue(tx, {
      kind: purpose,
      to: email,
      token: proof.value,
      accountTokenId: proof.id,
    });
  }
  async request(email: string, purpose: TokenPurpose) {
    this.email.requireConfigured();
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const [account] = await tx.query(
          'SELECT id,email_verified_at FROM accounts WHERE email=$1 FOR UPDATE',
          [email],
        );
        if (!account || (purpose === 'verify_email' && account.email_verified_at)) return;
        const [recent] = await tx.query(
          "SELECT id FROM account_tokens WHERE account_id=$1 AND purpose=$2 AND created_at>now()-interval '1 minute' LIMIT 1",
          [account.id, purpose],
        );
        if (recent) return;
        await this.queueProof(tx, String(account.id), email, purpose);
      }),
    );
  }
  async status(session: string | undefined) {
    const delivery = {
      deliveryAvailable: this.email.configured,
      ...(this.email.provider?.id === 'mailpit'
        ? { developmentInbox: 'http://localhost:8025' as const }
        : {}),
    };
    if (!session) return { signedIn: false, ...delivery };
    const account = await lookupAccountSession(this.db, session);
    return account
      ? {
          signedIn: true,
          email: String(account.email),
          verified: Boolean(account.email_verified_at),
          ...delivery,
        }
      : { signedIn: false, ...delivery };
  }
}
