import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';
import { test, expect, type BrowserContext } from '@playwright/test';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { testEmail, verifyFixtureAccount } from '../../apps/api/test/email.js';
let db: Database,
  server: FastifyInstance,
  origin: string,
  owner: string,
  mate: string,
  channel: string;
test.beforeAll(async () => {
  db = await database();
  await migrate(db);
  server = await buildApp(db, { origin: browserOrigin, email: testEmail() });
  allowBrowserStreams(server);
  const response = await server.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      name: 'Owner',
      email: 'owner@live-browser.test',
      password: 'live-browser-password',
      workspace: 'Live Studio',
    },
  });
  owner = response.cookies[0]!.value;
  await verifyFixtureAccount(db, 'owner@live-browser.test');
  const invitation = await server.inject({
    method: 'POST',
    url: '/v1/invitations',
    headers: { cookie: `ao_session=${owner}` },
    payload: { email: 'mate@live-browser.test', role: 'member' },
  });
  const accepted = await server.inject({
    method: 'POST',
    url: '/v1/invitations/accept',
    payload: {
      token: invitation.json().token,
      name: 'Teammate',
      password: 'live-browser-password',
    },
  });
  mate = accepted.cookies[0]!.value;
  await verifyFixtureAccount(db, 'mate@live-browser.test');
  channel = (await db.query("SELECT id FROM conversations WHERE name='general'"))[0]!.id as string;
  origin = (await server.listen({ host: '127.0.0.1', port: 0 })).replace('127.0.0.1', 'localhost');
});
test.afterAll(async () => {
  await server.close();
  await db.close();
});
async function attach(context: BrowserContext, session: string) {
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
test('syncs two people live through edits, reactions, threads, receipts, unread badges, reconnect and deletion', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const a = await browser.newContext(),
    b = await browser.newContext();
  const errors: string[] = [];
  try {
    await attach(a, owner);
    await attach(b, mate);
    const writer = await a.newPage(),
      reader = await b.newPage();
    writer.on('pageerror', (error) => errors.push(error.message));
    reader.on('pageerror', (error) => errors.push(error.message));
    await writer.goto('/app');
    await reader.goto('/app');
    await writer.getByRole('button', { name: /^general/ }).click();
    await reader.getByRole('button', { name: /^general/ }).click();
    await expect(writer.getByText('Live updates connected')).toBeVisible();
    await expect(reader.getByText('Live updates connected')).toBeVisible();
    const draft = writer.getByRole('textbox', { name: 'Message #general', exact: true });
    await draft.fill('A live decision');
    await writer
      .locator('.conversation .composer')
      .getByRole('button', { name: 'Send message' })
      .click();
    await expect
      .poll(
        async () => (await db.query("SELECT id FROM messages WHERE body='A live decision'")).length,
      )
      .toBe(1);
    const root = (await db.query("SELECT id FROM messages WHERE body='A live decision'"))[0]!
      .id as string;
    const writerRow = writer.locator(`.messages [data-message-id="${root}"]`),
      readerRow = reader.locator(`.messages [data-message-id="${root}"]`);
    await expect(readerRow.getByText('A live decision', { exact: true })).toBeVisible();
    await reader.bringToFront();
    await expect(writerRow.getByText('Seen by Teammate', { exact: true })).toBeVisible();
    await writerRow.getByRole('button', { name: 'Edit message', exact: true }).click();
    await writerRow
      .getByRole('textbox', { name: 'Edit message text' })
      .fill('An edited live decision');
    await writerRow.getByRole('button', { name: 'Save changes' }).click();
    await expect(readerRow.getByText('An edited live decision', { exact: true })).toBeVisible();
    await expect(readerRow.getByText('edited', { exact: true })).toBeVisible();
    await readerRow.getByLabel('Add reaction', { exact: true }).click();
    await readerRow.getByRole('button', { name: 'React with 👍', exact: true }).click();
    await expect(writerRow.getByRole('button', { name: '👍 1', exact: true })).toBeVisible();
    await expect(readerRow.getByRole('button', { name: '👍 1', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await readerRow.getByRole('button', { name: '👍 1', exact: true }).click();
    await expect(writerRow.getByRole('button', { name: '👍 1', exact: true })).toHaveCount(0);
    await writerRow.getByRole('button', { name: 'Reply in thread', exact: true }).click();
    await writer
      .getByRole('textbox', { name: 'Reply to thread', exact: true })
      .fill('A live thread reply');
    await writer.locator('.thread-panel').getByRole('button', { name: 'Send message' }).click();
    await expect(readerRow.getByRole('button', { name: '1 reply', exact: true })).toBeVisible();
    const notYetRead = (
      await server.inject({
        url: `/v1/conversations/${channel}/messages?threadId=${root}`,
        headers: { cookie: `ao_session=${owner}` },
      })
    ).json();
    expect(notYetRead[0].read_count).toBe(0);
    await readerRow.getByRole('button', { name: '1 reply', exact: true }).click();
    await reader.bringToFront();
    await expect(
      reader.locator('.thread-replies').getByText('A live thread reply', { exact: true }),
    ).toBeVisible();
    await expect(
      writer.locator('.thread-replies').getByText('Seen by Teammate', { exact: true }),
    ).toBeVisible();
    await reader.getByRole('button', { name: 'Close thread', exact: true }).click();
    await reader.getByRole('button', { name: 'Tasks', exact: true }).click();
    await draft.fill('Unread while viewing tasks');
    await writer
      .locator('.conversation .composer')
      .getByRole('button', { name: 'Send message' })
      .click();
    await expect(
      reader.getByRole('button', { name: /^general/ }).getByLabel('1 unread messages'),
    ).toBeVisible();
    await reader.getByRole('button', { name: /^general/ }).click();
    await reader.bringToFront();
    await expect(reader.getByText('Unread while viewing tasks', { exact: true })).toBeVisible();
    await expect(
      reader.getByRole('button', { name: /^general/ }).locator('.unread-badge'),
    ).toHaveCount(0);
    await b.setOffline(true);
    await draft.fill('Delivered after reconnect');
    await writer
      .locator('.conversation .composer')
      .getByRole('button', { name: 'Send message' })
      .click();
    await b.setOffline(false);
    await expect(reader.getByText('Delivered after reconnect', { exact: true })).toBeVisible();
    await writerRow.getByRole('button', { name: 'Delete message', exact: true }).click();
    const dialog = writer.getByRole('dialog', { name: 'Delete message?' });
    const changed = await server.inject({
      method: 'PATCH',
      url: `/v1/messages/${root}`,
      headers: { cookie: `ao_session=${owner}` },
      payload: { body: 'Changed on another device', version: 2 },
    });
    expect(changed.statusCode).toBe(200);
    await expect(dialog.getByRole('alert')).toContainText('This message changed');
    await expect(
      dialog.getByRole('button', { name: 'Delete message', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await writerRow.getByRole('button', { name: 'Delete message', exact: true }).click();
    await writer
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete message', exact: true })
      .click();
    await expect(readerRow.getByText('Message deleted', { exact: true })).toBeVisible();
    await expect(readerRow.getByText('Changed on another device', { exact: true })).toHaveCount(0);
    await readerRow.getByRole('button', { name: '1 reply', exact: true }).click();
    await expect(
      reader.locator('.thread-replies').getByText('A live thread reply', { exact: true }),
    ).toBeVisible();
    await reader.screenshot({ path: test.info().outputPath('live-messaging.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
  }
});

test('deduplicates an uncertain send and fences a delayed response after switching channels', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const context = await browser.newContext();
  let release: () => void = () => {};
  try {
    await attach(context, owner);
    let failedOnce = false,
      slowPosted = false;
    const attempts: string[] = [];
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await context.route('**/api/v1/conversations/*/messages', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      const input = route.request().postDataJSON() as { body: string; clientId: string };
      if (input.body === 'Retry the unchanged draft') {
        attempts.push(input.clientId);
        if (failedOnce) {
          await route.fallback();
          return;
        }
        failedOnce = true;
        const url = new URL(route.request().url());
        await route.fetch({ url: origin + url.pathname.replace(/^\/api/, '') });
        await route.abort('failed');
      } else if (input.body === 'A send completed after switching') {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: origin + url.pathname.replace(/^\/api/, '') });
        slowPosted = true;
        await delayed;
        await route.fulfill({ response });
      } else await route.fallback();
    });
    const page = await context.newPage();
    await page.goto('/app');
    await page.getByRole('button', { name: /^engineering/ }).click();
    const composer = page.getByRole('textbox', { name: 'Message #engineering', exact: true });
    await composer.fill('Retry the unchanged draft');
    await page
      .locator('.conversation .composer')
      .getByRole('button', { name: 'Send message' })
      .click();
    await expect(page.locator('.composer-wrap [role="status"]')).toContainText(
      'Queued on this device',
    );
    await expect(composer).toHaveValue('');
    await expect.poll(() => attempts.length, { timeout: 20000 }).toBe(2);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    expect(
      await db.query("SELECT id FROM messages WHERE body='Retry the unchanged draft'"),
    ).toHaveLength(1);
    await composer.fill('A send completed after switching');
    await page
      .locator('.conversation .composer')
      .getByRole('button', { name: 'Send message' })
      .click();
    await expect.poll(() => slowPosted).toBe(true);
    await page.getByRole('button', { name: /^ideas/ }).click();
    await expect(page.getByRole('heading', { name: 'ideas', exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('textbox', { name: 'Message #ideas', exact: true })).toHaveValue(
      '',
    );
    await expect(page.locator('.messages')).not.toContainText('A send completed after switching');
    await page.getByRole('button', { name: /^engineering/ }).click();
    await expect(
      page.locator('.messages').getByText('A send completed after switching', { exact: true }),
    ).toBeVisible();
  } finally {
    release();
    await context.close();
  }
});
