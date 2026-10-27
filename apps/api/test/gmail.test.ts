import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { testDatabase } from './database.js';
import { verifyFixtureAccount, testEmail, TestMailbox } from './email.js';
import { GmailProvider, type GmailTransport } from '../src/email/gmail.js';
import { EmailService, configuredEmail } from '../src/email/service.js';
import { DeliveryError, type EmailMessage } from '../src/email/provider.js';
import { EmailWorker } from '../src/email/worker.js';
import { buildApp } from '../src/app.js';

const key = Buffer.alloc(32, 7).toString('base64');
const user = 'sender@gmail.com',
  appPassword = 'abcdefghijklmnop';
const message: EmailMessage = {
  from: `Orbit <${user}>`,
  to: ['recipient@example.test'],
  subject: 'Verify email',
  text: 'A test message',
  html: '<p>A test message</p>',
};
const transport = (send: GmailTransport['sendMail']): GmailTransport => ({
  sendMail: send,
  async verify() {
    return true;
  },
});
describe('Gmail transport', () => {
  it('selects Gmail explicitly without falling back to another configured provider', () => {
    const configured = configuredEmail(
      {
        EMAIL_PROVIDER: 'gmail',
        GMAIL_USER: user,
        GMAIL_APP_PASSWORD: appPassword,
        EMAIL_ENCRYPTION_KEY: key,
        RESEND_API_KEY: 'unused-key',
      },
      'http://localhost:3000',
    );
    expect(configured.configured).toBe(true);
    expect(configured.provider?.id).toBe('gmail');
    expect(configured.provider?.idempotent).toBe(false);
    const absent = configuredEmail(
      {
        EMAIL_PROVIDER: 'gmail',
        GMAIL_USER: user,
        RESEND_API_KEY: 'unused-key',
        EMAIL_ENCRYPTION_KEY: key,
      },
      'http://localhost:3000',
    );
    expect(absent.configured).toBe(false);
    expect(absent.provider).toBeNull();
    expect(() =>
      configuredEmail({ EMAIL_PROVIDER: 'unsupported' }, 'http://localhost:3000'),
    ).toThrow('EMAIL_PROVIDER');
  });
  it('validates the Gmail account, app-password format and matching sender', () => {
    expect(() => new GmailProvider('sender@example.test', appPassword)).toThrow('personal Gmail');
    expect(() => new GmailProvider(user, 'normal-password')).toThrow('Google app password');
    const provider = new GmailProvider(user, 'abcd efgh ijkl mnop');
    expect(
      () => new EmailService(provider, key, 'other@gmail.com', 'http://localhost:3000'),
    ).toThrow('match GMAIL_USER');
  });
  it('binds the envelope and From address and uses a stable correlation ID', async () => {
    const sent: Parameters<GmailTransport['sendMail']>[0][] = [];
    const provider = new GmailProvider(
      user,
      appPassword,
      transport(async (input) => {
        sent.push(input);
        return { messageId: input.messageId, accepted: input.to };
      }),
    );
    const first = await provider.send(message, 'job-id'),
      second = await provider.send(message, 'job-id');
    expect(first).toBe(second);
    expect(sent[0]?.from).toEqual({ name: 'Orbit', address: user });
    expect(sent[0]?.envelope).toEqual({ from: user, to: message.to });
    expect(sent[0]?.disableFileAccess).toBe(true);
    expect(sent[0]?.disableUrlAccess).toBe(true);
    await expect(
      provider.send({ ...message, from: 'other@gmail.com' }, 'another-job'),
    ).rejects.toEqual(new DeliveryError('EMAIL_GMAIL_SENDER_MISMATCH', false));
    expect(sent).toHaveLength(2);
  });
  it('sanitizes authentication failures and explicitly rejected SMTP messages', async () => {
    const auth = new GmailProvider(user, appPassword, {
      async sendMail() {
        throw Object.assign(new Error('secret server response'), {
          code: 'EAUTH',
          responseCode: 535,
        });
      },
      async verify() {
        throw Object.assign(new Error('secret server response'), { code: 'EAUTH' });
      },
    });
    await expect(auth.send(message, 'job')).rejects.toEqual(
      new DeliveryError('EMAIL_GMAIL_AUTH_FAILED', false),
    );
    await expect(auth.verify()).rejects.toThrow('EMAIL_GMAIL_AUTH_FAILED');
    const temporary = new GmailProvider(
      user,
      appPassword,
      transport(async () => {
        throw Object.assign(new Error('quota details'), { responseCode: 451 });
      }),
    );
    await expect(temporary.send(message, 'job')).rejects.toEqual(
      new DeliveryError('EMAIL_SMTP_451', true),
    );
  });
  it('treats a connection loss as uncertain even when Nodemailer calls the command CONN', async () => {
    const provider = new GmailProvider(
      user,
      appPassword,
      transport(async () => {
        throw Object.assign(new Error('Connection closed after DATA'), {
          code: 'ECONNECTION',
          command: 'CONN',
        });
      }),
    );
    await expect(provider.send(message, 'job')).rejects.toEqual(
      new DeliveryError('EMAIL_SMTP_OUTCOME_UNKNOWN', false, true),
    );
  });
});

let db: Database, app: FastifyInstance, worker: EmailWorker, service: EmailService;
let behavior: GmailTransport['sendMail'];
let submissions: number,
  signupAddress = 1;
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
  service = new EmailService(
    new GmailProvider(
      user,
      appPassword,
      transport((input) => behavior(input)),
    ),
    key,
    `Orbit <${user}>`,
    'http://localhost:3000',
  );
  worker = new EmailWorker(db, service);
  app = await buildApp(db, { email: service });
}, 30000);
afterAll(async () => {
  await app.close();
  await db.close();
});
beforeEach(() => {
  submissions = 0;
  behavior = async (input) => {
    submissions++;
    return { messageId: input.messageId, accepted: input.to };
  };
});
async function signup() {
  const address = randomUUID() + '@smtp.test';
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    remoteAddress: `127.0.2.${signupAddress++}`,
    payload: {
      email: address,
      name: 'SMTP Person',
      workspace: 'Gmail Studio',
      password: 'gmail-test-password',
    },
  });
  expect(response.statusCode).toBe(201);
  const [job] = await db.query(
    "SELECT j.id FROM email_jobs j JOIN account_tokens t ON t.id=j.account_token_id JOIN accounts a ON a.id=t.account_id WHERE a.email=$1 AND j.kind='verify_email'",
    [address],
  );
  return { address, session: response.cookies[0]!.value, id: String(job!.id) };
}
async function state(id: string) {
  return (
    await db.query(
      'SELECT status,error_code,ciphertext,attempts,provider FROM email_jobs WHERE id=$1',
      [id],
    )
  )[0]!;
}
describe('SMTP delivery safety', () => {
  it('sends signup verification through Gmail and erases its encrypted payload', async () => {
    const person = await signup();
    await worker.tick();
    expect(submissions).toBe(1);
    expect(await state(person.id)).toMatchObject({
      status: 'sent',
      ciphertext: null,
      provider: 'gmail',
      attempts: 1,
    });
  });
  it('does not retry ambiguous SMTP delivery', async () => {
    const person = await signup();
    behavior = async () => {
      submissions++;
      throw Object.assign(new Error('socket lost'), { code: 'ECONNECTION', command: 'CONN' });
    };
    await worker.tick();
    await worker.tick();
    expect(submissions).toBe(1);
    expect(await state(person.id)).toMatchObject({
      status: 'outcome_unknown',
      error_code: 'EMAIL_SMTP_OUTCOME_UNKNOWN',
      ciphertext: null,
    });
  });
  it('does not resend a crashed or expired SMTP lease', async () => {
    const person = await signup();
    await db.query(
      "UPDATE email_jobs SET status='sending',attempts=1,lease_token=$1,lease_expires_at=now()-interval '1 second' WHERE id=$2",
      [randomUUID(), person.id],
    );
    await Promise.all([worker.tick(), new EmailWorker(db, service).tick()]);
    expect(submissions).toBe(0);
    expect(await state(person.id)).toMatchObject({
      status: 'outcome_unknown',
      attempts: 1,
      ciphertext: null,
    });
  });
  it('retries an explicit temporary rejection, but not a permanent authentication failure', async () => {
    const person = await signup();
    behavior = async (input) => {
      submissions++;
      if (submissions === 1) throw Object.assign(new Error('try later'), { responseCode: 451 });
      return { messageId: input.messageId, accepted: input.to };
    };
    await worker.tick();
    expect((await state(person.id)).status).toBe('queued');
    await db.query('UPDATE email_jobs SET available_at=now() WHERE id=$1', [person.id]);
    await worker.tick();
    expect(submissions).toBe(2);
    expect((await state(person.id)).status).toBe('sent');
    const blocked = await signup();
    behavior = async () => {
      throw Object.assign(new Error('bad password'), { code: 'EAUTH' });
    };
    await worker.tick();
    expect(await state(blocked.id)).toMatchObject({
      status: 'failed',
      error_code: 'EMAIL_GMAIL_AUTH_FAILED',
      ciphertext: null,
    });
  });
  it('never routes Gmail jobs through Resend when the active configuration changes', async () => {
    const person = await signup(),
      mailbox = new TestMailbox();
    await new EmailWorker(db, testEmail(mailbox)).tick();
    expect(mailbox.messages).toHaveLength(0);
    expect((await state(person.id)).status).toBe('queued');
    await worker.tick();
    expect((await state(person.id)).status).toBe('sent');
  });
  it('resends an uncertain invitation with a new token and a new Gmail delivery job', async () => {
    const owner = await signup();
    await verifyFixtureAccount(db, owner.address);
    const invited = await app.inject({
      method: 'POST',
      url: '/v1/invitations',
      headers: { cookie: `ao_session=${owner.session}` },
      payload: { email: 'invited@example.test' },
    });
    expect(invited.statusCode).toBe(201);
    behavior = async () => {
      throw new Error('unknown outcome');
    };
    await worker.tick();
    const id = invited.json().id;
    const list = (
      await app.inject({
        url: '/v1/invitations',
        headers: { cookie: `ao_session=${owner.session}` },
      })
    ).json();
    expect(list.find((row: { id: string }) => row.id === id).delivery_status).toBe(
      'outcome_unknown',
    );
    await db.query(
      "UPDATE email_jobs SET created_at=now()-interval '2 minutes' WHERE invitation_id=$1",
      [id],
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/invitations/${id}/resend`,
          headers: { cookie: `ao_session=${owner.session}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/invitations/preview',
          payload: { token: invited.json().token },
        })
      ).statusCode,
    ).toBe(404);
    behavior = async (input) => ({ messageId: input.messageId, accepted: input.to });
    await worker.tick();
    expect(
      await db.query(
        "SELECT id FROM email_jobs WHERE invitation_id=$1 AND status='sent' AND provider='gmail'",
        [id],
      ),
    ).toHaveLength(1);
  });
});
