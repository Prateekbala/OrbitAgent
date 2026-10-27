import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Sql } from '@ao/database';
import { GmailProvider } from './gmail.js';
import { MailpitProvider } from './mailpit.js';
import { AppError } from '../lib/errors.js';
import { emailMessage, type EmailMessage, type EmailProvider, ResendProvider } from './provider.js';
export type EmailKind = 'invitation' | 'verify_email' | 'reset_password' | 'change_email';
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
export class EmailService {
  readonly configured: boolean;
  private readonly key: Buffer | null;
  readonly origin: string;
  constructor(
    readonly provider: EmailProvider | null,
    key: string | undefined,
    private readonly from: string | undefined,
    origin: string,
  ) {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw new Error(
        'Email links require a trusted HTTPS origin (loopback HTTP is allowed locally).',
      );
    this.origin = url.origin;
    this.key = key ? Buffer.from(key, 'base64') : null;
    if (this.key && (this.key.length !== 32 || this.key.toString('base64') !== key))
      throw new Error('EMAIL_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key.');
    if (
      from &&
      (!emailMessage.shape.from.safeParse(from).success ||
        !emailMessage.shape.to.safeParse([from.match(/<([^<>]+)>$/)?.[1] ?? from]).success)
    )
      throw new Error('EMAIL_FROM is invalid.');
    if (
      provider instanceof GmailProvider &&
      from &&
      (from.match(/<([^<>]+)>$/)?.[1] ?? from).trim().toLowerCase() !== provider.user
    )
      throw new Error('EMAIL_FROM must match GMAIL_USER when EMAIL_PROVIDER=gmail.');
    this.configured = Boolean(provider && this.key && from);
  }
  requireConfigured() {
    if (!this.configured)
      throw new AppError(
        503,
        'EMAIL_UNAVAILABLE',
        'Email delivery is not configured. Contact the workspace operator.',
      );
  }
  decrypt(id: string, value: string) {
    if (!this.key) throw new Error('Email encryption key is unavailable.');
    const [nonce, tag, body] = value.split('.');
    if (!nonce || !tag || !body) throw new Error('Invalid encrypted email.');
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64url'));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return emailMessage.parse(
      JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString(
          'utf8',
        ),
      ),
    );
  }
  notificationMessage(to: string, count: number) {
    this.requireConfigured();
    if (count < 1) throw new Error('A notification email needs an eligible notification.');
    return emailMessage.parse({
      from: this.from,
      to: [to],
      subject: 'Your Orbit notifications',
      text: `You have unread notifications. Open Orbit to view what you can currently access.\n\n${this.origin}/app`,
      html: `<p>You have unread notifications.</p><p><a href="${escape(this.origin)}/app">Open Orbit</a> to view your notifications.</p>`,
    });
  }

  async enqueue(
    tx: Sql,
    input: {
      kind: EmailKind;
      to: string;
      token: string;
      invitationId?: string;
      workspaceId?: string;
      accountTokenId?: string;
      workspace?: string;
    },
  ) {
    this.requireConfigured();
    const id = randomUUID(),
      path =
        input.kind === 'invitation'
          ? '/invite'
          : input.kind === 'change_email'
            ? '/change-email'
            : input.kind === 'verify_email'
              ? '/verify-email'
              : '/reset-password';
    const link = `${this.origin}${path}#${input.token}`;
    const title =
      input.kind === 'invitation'
        ? `Join ${input.workspace ?? 'your team'} on Orbit`
        : input.kind === 'change_email'
          ? 'Confirm your new Orbit email'
          : input.kind === 'verify_email'
            ? 'Verify your Orbit email'
            : 'Reset your Orbit password';
    const description =
      input.kind === 'invitation'
        ? 'You have been invited to a workspace. This invitation expires in seven days.'
        : input.kind === 'change_email'
          ? 'Confirm the change to this email address. All existing sessions will be signed out. This link expires in 30 minutes.'
          : input.kind === 'verify_email'
            ? 'Confirm this email address to access your workspace. This link expires in 24 hours.'
            : 'Use this link to choose a new password. It expires in 30 minutes. If you did not request this, you can ignore this email.';
    const message: EmailMessage = emailMessage.parse({
      from: this.from,
      to: [input.to],
      subject: title.replace(/[\r\n]/g, ' ').slice(0, 200),
      text: `${title}\n\n${description}\n\n${link}\n\nIf you were not expecting this email, you can ignore it.`,
      html: `<h1>${escape(title)}</h1><p>${escape(description)}</p><p><a href="${escape(link)}">${input.kind === 'invitation' ? 'View invitation' : input.kind === 'verify_email' ? 'Verify email' : 'Reset password'}</a></p><p>If you were not expecting this email, you can ignore it.</p>`,
    });
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key!, nonce);
    cipher.setAAD(Buffer.from(id));
    const body = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
    const ciphertext = [nonce, cipher.getAuthTag(), body]
      .map((part) => part.toString('base64url'))
      .join('.');
    await tx.query(
      'INSERT INTO email_jobs(id,workspace_id,invitation_id,account_token_id,kind,ciphertext,deadline,provider,idempotent) VALUES($1,$2,$3,$4,$5,$6,now()+$7::interval,$8,$9)',
      [
        id,
        input.workspaceId ?? null,
        input.invitationId ?? null,
        input.accountTokenId ?? null,
        input.kind,
        ciphertext,
        input.kind === 'reset_password' ? '30 minutes' : '23 hours',
        this.provider!.id,
        this.provider!.idempotent,
      ],
    );
    return id;
  }
}
export function configuredEmail(env: NodeJS.ProcessEnv, origin: string) {
  const selected = env.EMAIL_PROVIDER || 'resend';
  if (!['resend', 'gmail', 'mailpit'].includes(selected))
    throw new Error('EMAIL_PROVIDER must be gmail, resend or mailpit.');
  const provider =
    selected === 'mailpit'
      ? new MailpitProvider(env.NODE_ENV)
      : selected === 'gmail'
        ? env.GMAIL_USER && env.GMAIL_APP_PASSWORD
          ? new GmailProvider(env.GMAIL_USER, env.GMAIL_APP_PASSWORD)
          : null
        : env.RESEND_API_KEY
          ? new ResendProvider(env.RESEND_API_KEY)
          : null;
  const from =
    env.EMAIL_FROM ||
    (selected === 'mailpit'
      ? 'Orbit <development@orbit.test>'
      : selected === 'gmail' && env.GMAIL_USER
        ? `Orbit <${env.GMAIL_USER}>`
        : undefined);
  return new EmailService(provider, env.EMAIL_ENCRYPTION_KEY, from, origin);
}
