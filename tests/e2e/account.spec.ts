import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';
import { randomUUID } from 'node:crypto';
import { MailpitProvider } from '../../apps/api/src/email/mailpit.js';
import { LocalMailbox } from '../support/local-mailbox.js';
import { test, expect } from '@playwright/test';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { EmailWorker } from '../../apps/api/src/email/worker.js';
import { EmailService } from '../../apps/api/src/email/service.js';
import { GmailProvider } from '../../apps/api/src/email/gmail.js';
import { TestMailbox } from '../../apps/api/test/email.js';
const localInbox = process.env.MAILPIT_E2E === '1' ? new LocalMailbox() : null;
const address = randomUUID() + '@browser.test';
let db: Database,
  server: FastifyInstance,
  origin: string,
  worker: EmailWorker,
  mailbox: TestMailbox;
test.beforeAll(async () => {
  db = await database();
  await migrate(db);
  mailbox = new TestMailbox();
  const sender = 'browser-sender@gmail.com';
  const provider = new GmailProvider(sender, 'abcdefghijklmnop', {
    async verify() {
      return true;
    },
    async sendMail(input) {
      await mailbox.send(
        {
          from: `Orbit <${sender}>`,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
        },
        input.messageId,
      );
      return { messageId: input.messageId, accepted: input.to };
    },
  });
  const email = new EmailService(
    localInbox ? new MailpitProvider('test') : provider,
    Buffer.alloc(32, 7).toString('base64'),
    `Orbit <${sender}>`,
    browserOrigin,
  );
  server = await buildApp(db, { origin: browserOrigin, email });
  worker = new EmailWorker(db, email);
  allowBrowserStreams(server);
  origin = await server.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => {
  await server.close();
  await db.close();
  await localInbox?.cleanup();
});
test('verifies email, recovers a password, signs in again and rejects a reused recovery link', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await proxyApi(context, origin);
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('Verified Person');
  await page.getByLabel('Workspace name').fill('Verified Studio');
  await page.getByLabel('Email address').fill(address);
  await page.getByLabel('Password', { exact: true }).fill('original-browser-password');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Verify your email.', exact: true }),
  ).toBeVisible();
  if (localInbox)
    await expect(page.getByRole('link', { name: 'Open development inbox' })).toHaveAttribute(
      'href',
      'http://localhost:8025',
    );
  await worker.tick();
  const verificationText = localInbox
    ? (await localInbox.read(address, 'Verify your Orbit email')).Text
    : mailbox.messages.find((item) => item.message.to[0] === address)!.message.text;
  const link = verificationText.match(/http:\/\/localhost:\d+\/verify-email#[A-Za-z0-9_-]{43}/)![0];
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('button', { name: 'Verify email address', exact: true }),
  ).toBeEnabled();
  expect(page.url()).not.toContain('#');
  await page.getByRole('button', { name: 'Verify email address', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email verified.', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.locator('.workspace-title')).toHaveText('Verified Studio');
  const oldSession = (await context.cookies()).find(
    (cookie) => cookie.name === 'ao_session',
  )!.value;
  await page.goto('/forgot-password');
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: 'Send recovery email', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox.', exact: true })).toBeVisible();
  await worker.tick();
  const recoveryText = localInbox
    ? (await localInbox.read(address, 'Reset your Orbit password')).Text
    : mailbox.messages.find((item) => item.message.text.includes('/reset-password#'))!.message.text;
  const resetLink = recoveryText.match(
    /http:\/\/localhost:\d+\/reset-password#[A-Za-z0-9_-]{43}/,
  )![0];
  await page.goto(resetLink, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('New password', { exact: true }).fill('new-browser-password');
  await page.getByLabel('Confirm password', { exact: true }).fill('new-browser-password');
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Password updated.', exact: true })).toBeVisible();
  expect(
    (
      await page.request.get(origin + '/v1/bootstrap', {
        headers: { cookie: `ao_session=${oldSession}` },
      })
    ).status(),
  ).toBe(401);
  await page.getByRole('link', { name: 'Go to sign in', exact: true }).click();
  await page.getByLabel('Email address').fill(address);
  await page.getByLabel('Password', { exact: true }).fill('new-browser-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.workspace-title')).toHaveText('Verified Studio');
  await page.goto(resetLink, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('New password', { exact: true }).fill('another-browser-password');
  await page.getByLabel('Confirm password', { exact: true }).fill('another-browser-password');
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('already used');
  await page.screenshot({ path: test.info().outputPath('account-recovery.png'), fullPage: true });
  expect(errors).toEqual([]);
});
