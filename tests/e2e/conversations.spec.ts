import { test, expect, type BrowserContext } from '@playwright/test';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/api/src/app.js';
import { LocalFileStore } from '../../apps/api/src/files/storage.js';
import { DevelopmentScanner } from '../../apps/api/src/files/scanner.js';
import { testEmail, verifyFixtureAccount } from '../../apps/api/test/email.js';
import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';
let db: Database,
  server: FastifyInstance,
  directory: string,
  origin: string,
  owner: string,
  mate: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbit-browser-files-'));
  db = await database();
  await migrate(db);
  server = await buildApp(db, {
    origin: browserOrigin,
    email: testEmail(),
    files: {
      store: new LocalFileStore(join(directory, 'files')),
      scanner: new DevelopmentScanner(),
      stagingDirectory: join(directory, 'staging'),
    },
  });
  allowBrowserStreams(server);
  const signup = await server.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      name: 'Owner',
      email: 'owner@conversations-browser.test',
      password: 'browser-secure-password',
      workspace: 'Private Studio',
    },
  });
  owner = signup.cookies[0]!.value;
  await verifyFixtureAccount(db, 'owner@conversations-browser.test');
  const invite = await server.inject({
    method: 'POST',
    url: '/v1/invitations',
    headers: { cookie: `ao_session=${owner}` },
    payload: { email: 'mate@conversations-browser.test', role: 'member' },
  });
  const accepted = await server.inject({
    method: 'POST',
    url: '/v1/invitations/accept',
    payload: { token: invite.json().token, name: 'Teammate', password: 'browser-secure-password' },
  });
  mate = accepted.cookies[0]!.value;
  await verifyFixtureAccount(db, 'mate@conversations-browser.test');
  origin = (await server.listen({ port: 0, host: '127.0.0.1' })).replace('127.0.0.1', 'localhost');
});
test.afterAll(async () => {
  await server.close();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});
async function connect(context: BrowserContext, session: string) {
  await context.addCookies([
    {
      name: 'ao_session',
      value: session,
      url: 'http://localhost:3000',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await proxyApi(context, origin);
}
test('starts a private DM, shares and downloads files live, manages a group, and revokes participant access', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const a = await browser.newContext(),
    b = await browser.newContext();
  const errors: string[] = [];
  try {
    await connect(a, owner);
    await connect(b, mate);
    const writer = await a.newPage(),
      reader = await b.newPage();
    writer.on('pageerror', (error) => errors.push(error.message));
    reader.on('pageerror', (error) => errors.push(error.message));
    await writer.goto('/app');
    await reader.goto('/app');
    await writer.getByRole('button', { name: 'New conversation', exact: true }).click();
    const dialog = writer.getByRole('dialog', { name: 'New conversation' });
    await dialog.getByRole('radio', { name: 'Teammate', exact: true }).check();
    await dialog.getByRole('button', { name: 'Start conversation' }).click();
    await expect(
      writer.getByRole('heading', { name: 'Teammate', exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      reader
        .getByRole('navigation', { name: 'Direct and group messages' })
        .getByRole('button', { name: /^Owner/ }),
    ).toBeVisible();
    await reader
      .getByRole('navigation', { name: 'Direct and group messages' })
      .getByRole('button', { name: /^Owner/ })
      .click();
    const bytes = Buffer.from('A private file shared directly.');
    await writer
      .getByLabel('Choose files', { exact: true })
      .setInputFiles({ name: 'decision.txt', mimeType: 'text/plain', buffer: bytes });
    await expect(writer.getByText('Ready to send', { exact: true })).toBeVisible();
    await writer
      .locator('.conversation .composer')
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const link = reader.locator('.messages').getByRole('link', { name: /decision.txt/ });
    await expect(link).toBeVisible();
    const downloadEvent = reader.waitForEvent('download');
    await link.click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('decision.txt');
    expect(await readFile((await download.path())!)).toEqual(bytes);
    const file = (await db.query("SELECT id FROM files WHERE name='decision.txt'"))[0]!.id;
    expect((await server.inject({ url: `/v1/files/${file}/content` })).statusCode).toBe(401);
    await writer.getByRole('button', { name: 'New conversation', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Private group', exact: true }).check();
    await dialog.getByLabel('Group name', { exact: true }).fill('Design circle');
    await dialog.getByRole('checkbox', { name: 'Teammate', exact: true }).check();
    await dialog.getByRole('button', { name: 'Start conversation' }).click();
    await expect(
      writer.getByRole('heading', { name: 'Design circle', exact: true, level: 1 }),
    ).toBeVisible();
    const groupButton = reader
      .getByRole('navigation', { name: 'Direct and group messages' })
      .getByRole('button', { name: /^Design circle/ });
    await expect(groupButton).toBeVisible();
    await groupButton.click();
    await writer
      .getByRole('textbox', { name: 'Message Design circle', exact: true })
      .fill('Only the circle sees this');
    await writer
      .locator('.conversation .composer')
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      reader.locator('.messages').getByText('Only the circle sees this', { exact: true }),
    ).toBeVisible();
    await writer.getByRole('button', { name: 'View participants', exact: true }).click();
    const details = writer.getByRole('dialog', { name: 'Group details' });
    await details.getByLabel('Group name', { exact: true }).fill('Design decisions');
    await details.getByRole('button', { name: 'Save group name', exact: true }).click();
    await expect(
      reader.getByRole('heading', { name: 'Design decisions', exact: true, level: 1 }),
    ).toBeVisible();
    const removal = writer.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes('/conversations/') &&
        response.request().postDataJSON()?.member?.action === 'remove',
    );
    await details.getByRole('button', { name: 'Remove Teammate from group', exact: true }).click();
    const removed = await removal;
    expect(removed.status(), await removed.text()).toBe(200);
    await expect(
      reader.getByRole('heading', { name: 'Design decisions', exact: true }),
    ).toHaveCount(0);
    await expect(
      reader.locator('.messages').getByText('Only the circle sees this', { exact: true }),
    ).toHaveCount(0);
    const group = (
      await db.query("SELECT id FROM conversations WHERE title='Design decisions'")
    )[0]!.id;
    expect(
      (
        await server.inject({
          url: `/v1/conversations/${group}/messages`,
          headers: { cookie: `ao_session=${mate}` },
        })
      ).statusCode,
    ).toBe(404);
    await details
      .getByRole('combobox', { name: 'Add participant' })
      .selectOption({ label: 'Teammate' });
    await details.getByRole('button', { name: 'Add participant', exact: true }).click();
    await expect(
      reader
        .getByRole('navigation', { name: 'Direct and group messages' })
        .getByRole('button', { name: /^Design decisions/ }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    await details.getByRole('button', { name: 'Close dialog' }).click();
    await writer.screenshot({
      path: test.info().outputPath('orbit-collaboration.png'),
      fullPage: true,
    });
  } finally {
    await a.close();
    await b.close();
  }
});
test('keeps failed upload drafts, retries safely, and removes queued attachments', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await connect(context, owner);
    const page = await context.newPage();
    await page.goto('/app');
    await page.getByRole('button', { name: /^general/ }).click();
    let fail = true;
    await page.route('**/api/v1/files/*/content', async (route) => {
      if (route.request().method() === 'PUT' && fail) {
        fail = false;
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Scanner is temporarily unavailable.' } }),
        });
      } else {
        const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        const response = await route.fetch({ url: origin + path });
        await route.fulfill({ response });
      }
    });
    await page.getByLabel('Choose files', { exact: true }).setInputFiles({
      name: 'retry.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Retry without losing the draft'),
    });
    await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message #general', exact: true })).toHaveValue(
      '',
    );
    await page.getByRole('button', { name: 'Retry upload', exact: true }).click();
    await expect(page.getByText('Ready to send', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove retry.txt', exact: true }).click();
    await expect(page.locator('.upload-list')).toHaveCount(0);
    await expect(
      page.locator('.conversation .composer').getByRole('button', { name: 'Send message' }),
    ).toBeDisabled();
  } finally {
    await context.close();
  }
});
