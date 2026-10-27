import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { SmtpTransport } from './smtp.js';
import { DeliveryError, emailMessage, type EmailMessage, type EmailProvider } from './provider.js';

export class MailpitProvider implements EmailProvider {
  readonly id = 'mailpit';
  readonly idempotent = false;
  private readonly transport: SmtpTransport;
  constructor(environment: string | undefined, transport?: SmtpTransport) {
    if (environment !== 'development' && environment !== 'test')
      throw new Error(
        'Mailpit requires NODE_ENV=development or test; live email is required in production.',
      );
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: '127.0.0.1',
        port: 1025,
        secure: false,
        ignoreTLS: true,
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
        logger: false,
        debug: false,
        pool: false,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
  }
  async verify() {
    try {
      await this.transport.verify();
    } catch {
      throw new DeliveryError('EMAIL_LOCAL_INBOX_UNAVAILABLE', true);
    }
  }
  async send(input: EmailMessage, key: string) {
    const message = emailMessage.parse(input);
    const from = message.from.match(/^(?:([^<>]*)<([^<>]+)>|([^<>]+))$/);
    const address = from?.[2] ?? from?.[3];
    if (!address || !z.email().safeParse(address.trim()).success)
      throw new DeliveryError('EMAIL_LOCAL_SENDER_INVALID', false);
    try {
      const result = await this.transport.sendMail({
        ...message,
        from: { name: from?.[1]?.trim() || 'Orbit', address: address.trim() },
        envelope: { from: address.trim(), to: message.to },
        messageId: `<${createHash('sha256').update(key).digest('hex')}@orbit.test>`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (!result.accepted.some((value) => value.toLowerCase() === message.to[0]!.toLowerCase()))
        throw new DeliveryError('EMAIL_SMTP_OUTCOME_UNKNOWN', false, true);
      return result.messageId;
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      const parsed = z.object({ responseCode: z.number() }).safeParse(error);
      if (parsed.success && parsed.data.responseCode >= 400 && parsed.data.responseCode < 600)
        throw new DeliveryError(
          `EMAIL_SMTP_${parsed.data.responseCode}`,
          parsed.data.responseCode < 500,
        );
      throw new DeliveryError('EMAIL_SMTP_OUTCOME_UNKNOWN', false, true);
    }
  }
}
