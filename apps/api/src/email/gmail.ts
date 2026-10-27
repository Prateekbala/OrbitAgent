import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { DeliveryError, emailMessage, type EmailMessage, type EmailProvider } from './provider.js';

import type { SmtpTransport } from './smtp.js';
export type { SmtpTransport as GmailTransport } from './smtp.js';

function smtpError(error: unknown): DeliveryError {
  const metadata = z
    .object({ code: z.string().optional(), responseCode: z.number().optional() })
    .safeParse(error);
  if (metadata.success) {
    const { code, responseCode } = metadata.data;
    if (code === 'EAUTH') return new DeliveryError('EMAIL_GMAIL_AUTH_FAILED', false);
    if (responseCode && responseCode >= 400 && responseCode < 600)
      return new DeliveryError(`EMAIL_SMTP_${responseCode}`, responseCode < 500);
    if (code === 'EDNS') return new DeliveryError('EMAIL_GMAIL_DNS_FAILED', true);
  }
  return new DeliveryError('EMAIL_SMTP_OUTCOME_UNKNOWN', false, true);
}

export class GmailProvider implements EmailProvider {
  readonly id = 'gmail';
  readonly idempotent = false;
  readonly user: string;
  private readonly transport: SmtpTransport;
  constructor(user: string, appPassword: string, transport?: SmtpTransport) {
    this.user = z.email().parse(user.trim().toLowerCase());
    if (!/@(?:gmail|googlemail)\.com$/.test(this.user))
      throw new Error('GMAIL_USER must be a personal Gmail address.');
    const password = appPassword.replace(/\s/g, '');
    if (!/^[a-zA-Z0-9]{16}$/.test(password))
      throw new Error('GMAIL_APP_PASSWORD must be a 16-character Google app password.');
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: this.user, pass: password },
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.gmail.com' },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
        dnsTimeout: 10000,
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
    } catch (error) {
      throw smtpError(error);
    }
  }
  async send(input: EmailMessage, key: string) {
    const message = emailMessage.parse(input);
    const from = message.from.match(/^(?:([^<>]*)<([^<>]+)>|([^<>]+))$/);
    if (!from || (from[2] ?? from[3])?.trim().toLowerCase() !== this.user)
      throw new DeliveryError('EMAIL_GMAIL_SENDER_MISMATCH', false);
    try {
      const result = await this.transport.sendMail({
        ...message,
        from: { name: from[1]?.trim() || 'Orbit', address: this.user },
        envelope: { from: this.user, to: message.to },
        messageId: `<${createHash('sha256').update(key).digest('hex')}@gmail.com>`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (
        !result.accepted.some((address) => address.toLowerCase() === message.to[0]!.toLowerCase())
      )
        throw new DeliveryError('EMAIL_SMTP_OUTCOME_UNKNOWN', false, true);
      return result.messageId;
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw smtpError(error);
    }
  }
}
