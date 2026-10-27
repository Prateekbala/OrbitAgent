import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { migrate } from '@ao/database';
import { buildApp } from '../src/app.js';
import { EmailWorker } from '../src/email/worker.js';
import { testDatabase } from './database.js';
import { testEmail, TestMailbox } from './email.js';

it('repairs existing identity-role permissions without bypassing email verification or erasure fencing', async () => {
  const db = await testDatabase();
  const mailbox = new TestMailbox(),
    email = testEmail(mailbox);
  await migrate(db);
  const app = await buildApp(db, { email });
  try {
    await db.query('REVOKE EXECUTE ON FUNCTION public.organization_live(uuid) FROM ao_identity');
    await db.query('DELETE FROM schema_migrations WHERE version=77');
    const address = randomUUID() + '@upgrade.test';
    const input = {
      name: 'Upgrade owner',
      workspace: 'Upgrade studio',
      email: address,
      password: 'upgrade-test-password',
    };
    const signup = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: input });
    expect(signup.statusCode, signup.body).toBe(201);
    const cookie = { cookie: `ao_session=${signup.cookies[0]!.value}` };
    const signin = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/signin',
        payload: { email: address, password: input.password },
      });
    const blocked = await signin();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('PERMISSION_DENIED');

    await migrate(db);
    await migrate(db);
    expect(
      (
        await db.query(
          "SELECT has_function_privilege('ao_identity','public.organization_live(uuid)','EXECUTE') allowed",
        )
      )[0]!.allowed,
    ).toBe(true);
    expect((await signin()).statusCode).toBe(200);
    const unverified = await app.inject({ url: '/v1/bootstrap', headers: cookie });
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json().error.code).toBe('EMAIL_NOT_VERIFIED');

    await new EmailWorker(db, email).tick();
    const token = mailbox.messages
      .find((item) => item.message.to.includes(address))
      ?.message.text.match(/\/verify-email#([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();
    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verification/confirm',
      payload: { token },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const boot = await app.inject({ url: '/v1/bootstrap', headers: cookie });
    expect(boot.statusCode, boot.body).toBe(200);
    expect(boot.json().workspace.name).toBe(input.workspace);

    const duplicate = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: input });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('EMAIL_IN_USE');
    expect(duplicate.json().error.message).toContain('Sign in or reset your password');

    const erased = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${(await db.query('SELECT organization_id FROM workspaces WHERE id=$1', [boot.json().workspace.id]))[0]!.organization_id}/erasure`,
      headers: cookie,
      payload: {
        requestKey: randomUUID(),
        confirmation: input.workspace,
        password: input.password,
        reason: 'Synthetic upgrade regression test',
      },
    });
    expect(erased.statusCode, erased.body).toBe(200);
    const fenced = await app.inject({ url: '/v1/bootstrap', headers: cookie });
    expect(fenced.statusCode).toBe(401);
  } finally {
    await app.close();
    await db.close();
  }
});
