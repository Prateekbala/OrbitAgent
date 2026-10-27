import type { Database } from '@ao/database';
import { scopedDatabase } from '@ao/database';
import { EmailService } from '../src/email/service.js';
import type { EmailMessage, EmailProvider } from '../src/email/provider.js';
import { consumeAccountToken } from '../src/identity/tokens.js';
export class TestMailbox implements EmailProvider {
  readonly id = 'resend';
  readonly idempotent = true;
  readonly messages: Array<{ message: EmailMessage; key: string }> = [];
  async send(message: EmailMessage, key: string) {
    if (!this.messages.some((item) => item.key === key)) this.messages.push({ message, key });
    return 'test-provider-' + key;
  }
}
export function testEmail(provider: EmailProvider = new TestMailbox()) {
  return new EmailService(
    provider,
    Buffer.alloc(32, 7).toString('base64'),
    'Orbit <test@example.test>',
    'http://localhost:3000',
  );
}
export async function verifyFixtureAccount(db: Database, address: string) {
  const [job] = await db.query(
    "SELECT j.id,j.ciphertext FROM email_jobs j JOIN account_tokens t ON t.id=j.account_token_id JOIN accounts a ON a.id=t.account_id WHERE a.email=$1 AND t.purpose='verify_email' AND t.consumed_at IS NULL ORDER BY j.created_at DESC LIMIT 1",
    [address],
  );
  if (!job) throw new Error('Missing verification fixture');
  const message = testEmail().decrypt(String(job.id), String(job.ciphertext));
  const token = message.text.match(/\/verify-email#([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error('Missing verification link');
  await consumeAccountToken(scopedDatabase(db), token, 'verify_email');
}
