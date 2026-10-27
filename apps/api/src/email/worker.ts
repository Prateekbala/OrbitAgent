import { randomUUID } from 'node:crypto';
import { identityScope, scopedDatabase, type Database } from '@ao/database';
import { EmailService } from './service.js';
import { DeliveryError } from './provider.js';
interface Job extends Record<string, unknown> {
  id: string;
  ciphertext: string;
  lease_token: string;
  attempts: number;
  idempotent: boolean;
}
export class EmailWorker {
  private readonly db: Database;
  private active: Promise<void> | null = null;
  constructor(
    db: Database,
    private readonly email: EmailService,
    private readonly onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    if (this.active) return this.active;
    const operation = identityScope(() => this.process());
    this.active = operation.finally(() => {
      this.active = null;
    });
    return this.active;
  }
  start(interval = 1000) {
    const timer = setInterval(() => {
      void this.tick().catch(() => this.onError('EMAIL_WORKER_FAILED'));
    }, interval);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.active;
    };
  }
  private async process() {
    if (!this.email.configured) return;
    await this.db.query(
      "UPDATE email_jobs SET status='outcome_unknown',error_code='EMAIL_SMTP_OUTCOME_UNKNOWN',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE status='sending' AND NOT idempotent AND lease_expires_at<=now()",
    );
    await this.db.query(
      "UPDATE email_jobs SET status='failed',error_code='EMAIL_DEADLINE_EXCEEDED',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE status IN ('queued','sending') AND deadline<=now()",
    );
    for (let index = 0; index < 10; index++) {
      const job = await this.db.transaction(async (tx) => {
        const [row] = await tx.query<Job>(
          "SELECT * FROM email_jobs WHERE provider=$1 AND idempotent=$2 AND (status='queued' AND available_at<=now() OR status='sending' AND idempotent AND lease_expires_at<=now()) AND deadline>now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
          [this.email.provider!.id, this.email.provider!.idempotent],
        );
        if (!row) return null;
        if (row.attempts >= 8) {
          await tx.query(
            "UPDATE email_jobs SET status='failed',error_code='EMAIL_ATTEMPTS_EXHAUSTED',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
            [row.id],
          );
          return { cancelled: true } as const;
        }
        const [valid] = await tx.query(
          `SELECT j.id FROM email_jobs j LEFT JOIN account_tokens t ON t.id=j.account_token_id LEFT JOIN invitations i ON i.id=j.invitation_id LEFT JOIN memberships m ON m.id=i.inviter_id WHERE j.id=$1 AND ((j.kind<>'invitation' AND t.consumed_at IS NULL AND t.expires_at>now() AND t.id IS NOT NULL) OR (j.kind='invitation' AND i.status='pending' AND i.expires_at>now() AND m.status='active' AND (m.role='owner' OR m.role='admin' AND i.role='member')))`,
          [row.id],
        );
        if (!valid) {
          await tx.query(
            "UPDATE email_jobs SET status='cancelled',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
            [row.id],
          );
          return { cancelled: true } as const;
        }
        const lease = randomUUID();
        await tx.query(
          "UPDATE email_jobs SET status='sending',attempts=attempts+1,lease_token=$1,lease_expires_at=now()+interval '1 minute' WHERE id=$2",
          [lease, row.id],
        );
        return { ...row, lease_token: lease, attempts: row.attempts + 1 };
      });
      if (!job) break;
      if ('cancelled' in job) continue;
      let dispatched = false;
      try {
        const message = this.email.decrypt(job.id, job.ciphertext);
        dispatched = true;
        const providerId = await this.email.provider!.send(message, `orbit-email/${job.id}`);
        await this.db.query(
          "UPDATE email_jobs SET status='sent',provider_id=$1,sent_at=now(),ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL,error_code=NULL WHERE id=$2 AND status='sending' AND lease_token=$3",
          [providerId, job.id, job.lease_token],
        );
      } catch (error) {
        const uncertain =
          dispatched && !job.idempotent && (!(error instanceof DeliveryError) || error.uncertain);
        const retryable =
          error instanceof DeliveryError ? error.retryable : dispatched && job.idempotent;
        const retry = !uncertain && retryable && job.attempts < 8;
        const status = uncertain ? 'outcome_unknown' : retry ? 'queued' : 'failed';
        const code = uncertain
          ? 'EMAIL_SMTP_OUTCOME_UNKNOWN'
          : error instanceof DeliveryError
            ? error.code
            : dispatched
              ? 'EMAIL_COMPLETION_UNCERTAIN'
              : 'EMAIL_PAYLOAD_INVALID';
        const seconds = Math.ceil(
          Math.min(1800, 30 * 2 ** (job.attempts - 1)) * (0.8 + Math.random() * 0.4),
        );
        await this.db.query(
          "UPDATE email_jobs SET status=$1,error_code=$2,available_at=now()+$3::interval,ciphertext=CASE WHEN $1='queued' THEN ciphertext ELSE NULL END,lease_token=NULL,lease_expires_at=NULL WHERE id=$4 AND status='sending' AND lease_token=$5",
          [status, code, `${seconds} seconds`, job.id, job.lease_token],
        );
        this.onError(code);
      }
    }
  }
}
