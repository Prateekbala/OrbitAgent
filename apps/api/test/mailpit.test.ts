import { describe, it, expect } from 'vitest';
import { MailpitProvider } from '../src/email/mailpit.js';
import { configuredEmail } from '../src/email/service.js';
import { DeliveryError, type EmailMessage } from '../src/email/provider.js';
import type { SmtpTransport } from '../src/email/smtp.js';

const message: EmailMessage = {
  from: 'Orbit <development@orbit.test>',
  to: ['recipient@example.test'],
  subject: 'Local verification',
  text: 'A local message',
  html: '<p>A local message</p>',
};
describe('local development email', () => {
  it('requires explicit development/test configuration and never falls back to live credentials', () => {
    for (const NODE_ENV of [undefined, 'production', 'preview']) {
      expect(() =>
        configuredEmail({ NODE_ENV, EMAIL_PROVIDER: 'mailpit' }, 'http://localhost:3000'),
      ).toThrow('NODE_ENV');
    }
    const email = configuredEmail(
      {
        NODE_ENV: 'development',
        EMAIL_PROVIDER: 'mailpit',
        EMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        RESEND_API_KEY: 'must-not-be-used',
        GMAIL_USER: 'sender@gmail.com',
        GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
      },
      'http://localhost:3000',
    );
    expect(email.configured).toBe(true);
    expect(email.provider?.id).toBe('mailpit');
    expect(email.provider?.idempotent).toBe(false);
  });
  it('captures safe content with a stable correlation ID and explicit SMTP envelope', async () => {
    const sent: Parameters<SmtpTransport['sendMail']>[0][] = [];
    const provider = new MailpitProvider('test', {
      async verify() {
        return true;
      },
      async sendMail(input) {
        sent.push(input);
        return { messageId: input.messageId, accepted: input.to };
      },
    });
    await provider.verify();
    expect(await provider.send(message, 'job')).toBe(await provider.send(message, 'job'));
    expect(sent[0]).toMatchObject({
      from: { name: 'Orbit', address: 'development@orbit.test' },
      envelope: { from: 'development@orbit.test', to: message.to },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });
  it('sanitizes failures and never retries an uncertain local SMTP submission', async () => {
    for (const [error, expected] of [
      [{ responseCode: 451 }, new DeliveryError('EMAIL_SMTP_451', true)],
      [{ responseCode: 550 }, new DeliveryError('EMAIL_SMTP_550', false)],
      [
        new Error('private socket details'),
        new DeliveryError('EMAIL_SMTP_OUTCOME_UNKNOWN', false, true),
      ],
    ] as const) {
      const provider = new MailpitProvider('test', {
        async verify() {
          throw new Error('private details');
        },
        async sendMail() {
          throw error;
        },
      });
      await expect(provider.send(message, 'job')).rejects.toEqual(expected);
      await expect(provider.verify()).rejects.toThrow('EMAIL_LOCAL_INBOX_UNAVAILABLE');
    }
  });
});
