import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { database, migrate } from '@ao/database';
import { buildApp } from '../../apps/api/src/app.js';
import { MailpitProvider } from '../../apps/api/src/email/mailpit.js';
import { EmailService } from '../../apps/api/src/email/service.js';
import { EmailWorker } from '../../apps/api/src/email/worker.js';
import { LocalMailbox } from '../support/local-mailbox.js';

const db = await database(),
  mailbox = new LocalMailbox();
const provider = new MailpitProvider('test');
const email = new EmailService(
  provider,
  randomBytes(32).toString('base64'),
  'Orbit <development@orbit.test>',
  'http://localhost:3000',
);
const app = await buildApp(db, { email }),
  worker = new EmailWorker(db, email);
const address = randomUUID() + '@local.test',
  invitee = randomUUID() + '@local.test';
async function proof(to: string, subject: string, path: string) {
  await worker.tick();
  const message = await mailbox.read(to, subject);
  const token = message.Text.match(new RegExp('/' + path + '#([A-Za-z0-9_-]{43})'))?.[1];
  assert(token, 'Missing actionable link in captured email');
  return token;
}
try {
  await migrate(db);
  await provider.verify();
  await assert.rejects(buildApp(db, { email, production: true }), /production/);
  const signup = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      email: address,
      name: 'Local Test',
      workspace: 'Local Test Studio',
      password: 'local-original-password',
    },
  });
  assert.equal(signup.statusCode, 201);
  const headers = { cookie: `ao_session=${signup.cookies[0]!.value}` };
  assert.equal((await app.inject({ url: '/v1/bootstrap', headers })).statusCode, 403);
  const status = await app.inject({ url: '/v1/auth/status', headers });
  assert.equal(status.json().developmentInbox, 'http://localhost:8025');
  const verify = await proof(address, 'Verify your Orbit email', 'verify-email');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/verification/confirm',
        payload: { token: verify },
      })
    ).statusCode,
    200,
  );
  assert.equal((await app.inject({ url: '/v1/bootstrap', headers })).statusCode, 200);
  const invite = await app.inject({
    method: 'POST',
    url: '/v1/invitations',
    headers,
    payload: { email: invitee, role: 'member' },
  });
  assert.equal(invite.statusCode, 201);
  const invitation = await proof(invitee, 'Join Local Test Studio on Orbit', 'invite');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/invitations/preview',
        payload: { token: invitation },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/password/forgot',
        payload: { email: address },
      })
    ).statusCode,
    202,
  );
  const reset = await proof(address, 'Reset your Orbit password', 'reset-password');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: { token: reset, password: 'local-replacement-password' },
      })
    ).statusCode,
    200,
  );
  assert.equal((await app.inject({ url: '/v1/bootstrap', headers })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/signin',
        payload: { email: address, password: 'local-replacement-password' },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: { token: reset, password: 'another-local-password' },
      })
    ).statusCode,
    410,
  );
  const jobs = await db.query('SELECT status,ciphertext,provider,idempotent FROM email_jobs');
  assert.equal(jobs.length, 3);
  for (const job of jobs)
    assert.deepEqual(job, {
      status: 'sent',
      ciphertext: null,
      provider: 'mailpit',
      idempotent: false,
    });
  console.log(
    'Local SMTP capture, verification, invitation, password recovery, session revocation, proof replay rejection and production guard passed. No external email sent.',
  );
} finally {
  try {
    await mailbox.cleanup();
  } finally {
    await app.close();
    await db.close();
  }
}
