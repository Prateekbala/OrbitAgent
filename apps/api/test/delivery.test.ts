import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate, identityScope, scopedDatabase, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { testDatabase } from './database.js';
import { testEmail, TestMailbox, verifyFixtureAccount } from './email.js';
import { buildApp } from '../src/app.js';
import { EmailWorker } from '../src/email/worker.js';
import { DeliveryError, ResendProvider, type EmailMessage } from '../src/email/provider.js';
import { EmailService } from '../src/email/service.js';
import { createSession } from '../src/lib/sessions.js';
let db: Database, app: FastifyInstance, mailbox: TestMailbox, worker: EmailWorker;
const password = 'delivery-original-password';
const cookie = (session: string) => ({ cookie: `ao_session=${session}` });
async function signup() {
  const address = randomUUID() + '@delivery.test';
  const result = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    remoteAddress: '127.0.0.' + ++signupAddress,
    payload: { email: address, name: 'Delivery Person', workspace: 'Delivery Studio', password },
  });
  expect(result.statusCode).toBe(201);
  return { address, session: result.cookies[0]!.value };
}
let signupAddress = 1,
  requestAddress = 1;
async function request(address: string, kind = 'password/forgot') {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/' + kind,
    remoteAddress: '127.0.1.' + requestAddress++,
    payload: { email: address },
  });
}
const messageFor = (address: string, path: string) =>
  mailbox.messages.findLast(
    (item) => item.message.to[0] === address && item.message.text.includes(path),
  )!.message;
const secret = (message: EmailMessage) => message.text.match(/#([A-Za-z0-9_-]{43})/)![1]!;
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
  mailbox = new TestMailbox();
  const email = testEmail(mailbox);
  worker = new EmailWorker(db, email);
  app = await buildApp(db, { email });
}, 30000);
afterAll(async () => {
  await app.close();
  await db.close();
});
afterEach(async () => worker.tick());
describe('email and account flows', () => {
  it('gates an unverified session and sends a proof without storing its plaintext', async () => {
    const person = await signup();
    expect(
      (await app.inject({ url: '/v1/bootstrap', headers: cookie(person.session) })).json().error
        .code,
    ).toBe('EMAIL_NOT_VERIFIED');
    expect(
      (await app.inject({ url: '/v1/auth/status', headers: cookie(person.session) })).json()
        .verified,
    ).toBe(false);
    const [job] = await db.query(
      "SELECT * FROM email_jobs WHERE kind='verify_email' AND status='queued' ORDER BY created_at DESC LIMIT 1",
    );
    expect(String(job!.ciphertext)).not.toContain(person.address);
    await worker.tick();
    const message = messageFor(person.address, '/verify-email');
    expect(JSON.stringify(await db.query('SELECT * FROM account_tokens'))).not.toContain(
      secret(message),
    );
    expect(
      (await db.query('SELECT ciphertext,status FROM email_jobs WHERE id=$1', [job!.id]))[0],
    ).toEqual({ ciphertext: null, status: 'sent' });
    const confirm = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/verification/confirm',
        payload: { token: secret(message) },
      });
    expect((await confirm()).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/v1/bootstrap', headers: cookie(person.session) })).statusCode,
    ).toBe(200);
    expect((await confirm()).statusCode).toBe(410);
  });
  it('returns identical recovery responses and throttles each address durably', async () => {
    const person = await signup();
    const known = await request(person.address),
      unknown = await request('unknown@delivery.test');
    expect(known.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    await request(person.address);
    const rows = await db.query(
      "SELECT t.id FROM account_tokens t JOIN accounts a ON a.id=t.account_id WHERE a.email=$1 AND t.purpose='reset_password'",
      [person.address],
    );
    expect(rows).toHaveLength(1);
  });
  it('recovers an account, rejects replay/old credentials and revokes every session', async () => {
    const person = await signup();
    await verifyFixtureAccount(db, person.address);
    const other = await app.inject({
      method: 'POST',
      url: '/v1/auth/signin',
      payload: { email: person.address, password },
    });
    expect(other.statusCode).toBe(200);
    await request(person.address);
    await worker.tick();
    const token = secret(messageFor(person.address, '/reset-password'));
    const reset = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: { token, password: 'new-delivery-password' },
      });
    expect((await reset()).statusCode).toBe(200);
    for (const session of [person.session, other.cookies[0]!.value])
      expect(
        (await app.inject({ url: '/v1/bootstrap', headers: cookie(session) })).statusCode,
      ).toBe(401);
    expect((await reset()).statusCode).toBe(410);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/signin',
          payload: { email: person.address, password },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/signin',
          payload: { email: person.address, password: 'new-delivery-password' },
        })
      ).statusCode,
    ).toBe(200);
    const [account] = await db.query('SELECT id FROM accounts WHERE email=$1', [person.address]);
    const [membership] = await db.query(
      'SELECT id,workspace_id FROM memberships WHERE account_id=$1',
      [account!.id],
    );
    await expect(
      identityScope(
        () =>
          scopedDatabase(db).transaction((tx) =>
            createSession(tx, String(account!.id), String(membership!.id), 1),
          ),
        String(membership!.workspace_id),
      ),
    ).rejects.toThrow('current password');
  });
  it('queues invitation email, reports provider acceptance, rotates on resend and cancels revoked links', async () => {
    const owner = await signup();
    await verifyFixtureAccount(db, owner.address);
    const recipient = randomUUID() + '@invite.test';
    const invited = await app.inject({
      method: 'POST',
      url: '/v1/invitations',
      headers: cookie(owner.session),
      payload: { email: recipient },
    });
    expect(invited.statusCode).toBe(201);
    const id = invited.json().id;
    const resend = () =>
      app.inject({
        method: 'POST',
        url: `/v1/invitations/${id}/resend`,
        headers: cookie(owner.session),
      });
    expect((await resend()).statusCode).toBe(429);
    await worker.tick();
    expect(secret(messageFor(recipient, '/invite'))).toBe(invited.json().token);
    const listing = (
      await app.inject({ url: '/v1/invitations', headers: cookie(owner.session) })
    ).json();
    expect(listing.find((item: { id: string }) => item.id === id).delivery_status).toBe('sent');
    await db.query(
      "UPDATE email_jobs SET created_at=now()-interval '2 minutes' WHERE invitation_id=$1",
      [id],
    );
    expect((await resend()).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/invitations/preview',
          payload: { token: invited.json().token },
        })
      ).statusCode,
    ).toBe(404);
    await app.inject({
      method: 'POST',
      url: `/v1/invitations/${id}/revoke`,
      headers: cookie(owner.session),
    });
    await worker.tick();
    expect(mailbox.messages.filter((item) => item.message.to[0] === recipient)).toHaveLength(1);
    expect(
      (
        await db.query(
          'SELECT status,ciphertext FROM email_jobs WHERE invitation_id=$1 ORDER BY created_at DESC',
          [id],
        )
      ).some((row) => row.status === 'cancelled' && row.ciphertext === null),
    ).toBe(true);
  });
  it('fails closed when delivery is unconfigured without creating accounts or invitations', async () => {
    const unavailable = await buildApp(db);
    try {
      expect(
        (
          await unavailable.inject({
            method: 'POST',
            url: '/v1/auth/signup',
            payload: {
              email: 'disabled@delivery.test',
              name: 'Disabled',
              workspace: 'Disabled Studio',
              password,
            },
          })
        ).statusCode,
      ).toBe(503);
      expect(
        (
          await unavailable.inject({
            method: 'POST',
            url: '/v1/auth/password/forgot',
            payload: { email: 'disabled@delivery.test' },
          })
        ).statusCode,
      ).toBe(503);
      expect(
        await db.query("SELECT id FROM accounts WHERE email='disabled@delivery.test'"),
      ).toHaveLength(0);
    } finally {
      await unavailable.close();
    }
  });
  it('isolates encrypted payloads from tenant SQL', async () => {
    await expect(scopedDatabase(db).query('SELECT ciphertext FROM email_jobs')).rejects.toThrow(
      'permission denied',
    );
  });
});
describe('provider and delivery recovery', () => {
  it('uses the documented endpoint, bounded timeout and stable idempotency header', async () => {
    let sent: RequestInit | undefined;
    const provider = new ResendProvider('test-private-key', async (url, options) => {
      expect(url).toBe('https://api.resend.com/emails');
      sent = options;
      return Response.json({ id: 'provider-accepted' });
    });
    const message = {
      from: 'sender@example.test',
      to: ['recipient@example.test'],
      subject: 'A subject',
      text: 'Text',
      html: '<p>Text</p>',
    };
    expect(await provider.send(message, 'orbit-email/test')).toBe('provider-accepted');
    expect(new Headers(sent?.headers).get('idempotency-key')).toBe('orbit-email/test');
    expect(sent?.redirect).toBe('error');
    expect(sent?.signal).toBeTruthy();
    const rejected = new ResendProvider(
      'test-private-key',
      async () => new Response('sensitive provider details', { status: 400 }),
    );
    await expect(rejected.send(message, 'orbit-email/other')).rejects.toEqual(
      new DeliveryError('EMAIL_PROVIDER_400', false),
    );
  });
  it('retries uncertain sends with the same key and payload, then erases the payload', async () => {
    const person = await signup();
    await verifyFixtureAccount(db, person.address);
    await request(person.address);
    const [row] = await db.query(
      "SELECT j.id FROM email_jobs j JOIN account_tokens t ON t.id=j.account_token_id JOIN accounts a ON a.id=t.account_id WHERE a.email=$1 AND j.kind='reset_password'",
      [person.address],
    );
    const calls: Array<{ message: EmailMessage; key: string }> = [];
    const isolated = new EmailWorker(
      db,
      testEmail({
        id: 'resend',
        idempotent: true,
        async send(message, key) {
          calls.push({ message, key });
          if (calls.length === 1) throw new DeliveryError('EMAIL_TRANSPORT_UNCERTAIN', true);
          return 'accepted-after-retry';
        },
      }),
    );
    await isolated.tick();
    expect(
      (await db.query('SELECT status FROM email_jobs WHERE id=$1', [row!.id]))[0]?.status,
    ).toBe('queued');
    await db.query('UPDATE email_jobs SET available_at=now() WHERE id=$1', [row!.id]);
    await isolated.tick();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(
      (await db.query('SELECT ciphertext,status FROM email_jobs WHERE id=$1', [row!.id]))[0],
    ).toEqual({ ciphertext: null, status: 'sent' });
  });
  it('reclaims expired leases across workers and never replays after the idempotency deadline', async () => {
    const person = await signup();
    await verifyFixtureAccount(db, person.address);
    await request(person.address);
    const [row] = await db.query(
      "SELECT j.id FROM email_jobs j JOIN account_tokens t ON t.id=j.account_token_id JOIN accounts a ON a.id=t.account_id WHERE a.email=$1 AND j.kind='reset_password'",
      [person.address],
    );
    await db.query(
      "UPDATE email_jobs SET status='sending',lease_token=$1,lease_expires_at=now()-interval '1 second' WHERE id=$2",
      [randomUUID(), row!.id],
    );
    await Promise.all([worker.tick(), new EmailWorker(db, testEmail(mailbox)).tick()]);
    expect(mailbox.messages.filter((item) => item.message.to[0] === person.address)).toHaveLength(
      1,
    );
    const late = await signup();
    await db.query(
      "UPDATE email_jobs SET deadline=now()-interval '1 second' WHERE account_token_id IN (SELECT t.id FROM account_tokens t JOIN accounts a ON a.id=t.account_id WHERE a.email=$1)",
      [late.address],
    );
    await worker.tick();
    expect(mailbox.messages.some((item) => item.message.to[0] === late.address)).toBe(false);
  });
  it('validates encryption keys, trusted link origins and authenticated ciphertext', () => {
    expect(
      () => new EmailService(mailbox, 'invalid', 'from@example.test', 'http://localhost:3000'),
    ).toThrow('32-byte');
    expect(() => new EmailService(mailbox, undefined, undefined, 'http://evil.example')).toThrow(
      'trusted HTTPS',
    );
    expect(() => testEmail().decrypt(randomUUID(), 'bad.cipher.text')).toThrow();
  });
});
