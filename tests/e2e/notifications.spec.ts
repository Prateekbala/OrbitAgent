import { test, expect, type BrowserContext } from '@playwright/test';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../apps/api/src/app.js';
import { testEmail, verifyFixtureAccount } from '../../apps/api/test/email.js';
import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';
let db: Database,
  server: FastifyInstance,
  origin: string,
  owner: string,
  mate: string,
  mateId: string,
  channel: string;
test.beforeAll(async () => {
  db = await database();
  await migrate(db);
  server = await buildApp(db, { origin: browserOrigin, email: testEmail() });
  allowBrowserStreams(server);
  const signup = await server.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      name: 'Owner',
      email: 'owner@notifications-browser.test',
      password: 'browser-secure-password',
      workspace: 'Activity Studio',
    },
  });
  owner = signup.cookies[0]!.value;
  await verifyFixtureAccount(db, 'owner@notifications-browser.test');
  const invite = await server.inject({
    method: 'POST',
    url: '/v1/invitations',
    headers: { cookie: `ao_session=${owner}` },
    payload: { email: 'mate@notifications-browser.test', role: 'member' },
  });
  const accepted = await server.inject({
    method: 'POST',
    url: '/v1/invitations/accept',
    payload: { token: invite.json().token, name: 'Teammate', password: 'browser-secure-password' },
  });
  mate = accepted.cookies[0]!.value;
  await verifyFixtureAccount(db, 'mate@notifications-browser.test');
  mateId = String((await db.query("SELECT id FROM memberships WHERE name='Teammate'"))[0]!.id);
  channel = String((await db.query("SELECT id FROM conversations WHERE name='general'"))[0]!.id);
  origin = (await server.listen({ host: '127.0.0.1', port: 0 })).replace('127.0.0.1', 'localhost');
});
test.afterAll(async () => {
  await server.close();
  await db.close();
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
async function send(body: string, conversation = channel) {
  const response = await server.inject({
    method: 'POST',
    url: `/v1/conversations/${conversation}/messages`,
    headers: { cookie: `ao_session=${owner}` },
    payload: { body, clientId: randomUUID() },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}
test('delivers private notifications live, opens old context, and saves read state and preferences', async ({
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
    await reader.getByRole('button', { name: /^Notifications/ }).click();
    await writer.getByRole('button', { name: /^general/ }).click();
    await writer
      .locator('.conversation .composer')
      .getByRole('button', { name: 'Mention a teammate', exact: true })
      .click();
    await writer
      .getByRole('group', { name: 'Mention a teammate' })
      .getByRole('button', { name: 'Teammate', exact: true })
      .click();
    const draft = writer.getByRole('textbox', { name: 'Message #general', exact: true });
    await draft.press('End');
    await draft.pressSequentially('please review the brief');
    await writer
      .locator('.conversation .composer')
      .getByRole('button', { name: 'Send message' })
      .click();
    await expect(reader.getByText('Mentioned you', { exact: true })).toBeVisible();
    await expect(
      reader.getByRole('button', { name: /^Notifications/ }).getByLabel('1 unread notifications'),
    ).toBeVisible();
    const message = String(
      (await db.query("SELECT id FROM messages WHERE body LIKE '%please review the brief%'"))[0]!
        .id,
    );
    for (let index = 0; index < 105; index++) await send(`Later discussion ${index}`);
    await reader
      .locator(`[data-notification-id]`)
      .filter({ hasText: 'please review the brief' })
      .getByRole('button', { name: /Mentioned you/ })
      .click();
    await expect(reader.locator(`[data-message-id="${message}"]`)).toBeVisible();
    await expect(
      reader.getByRole('button', { name: 'Back to latest conversation', exact: true }),
    ).toBeVisible();
    await reader.getByRole('button', { name: /^Notifications/ }).click();
    await expect(
      reader.getByRole('button', { name: 'Mark notification unread', exact: true }),
    ).toBeVisible();
    await reader.getByRole('button', { name: 'Mark notification unread', exact: true }).click();
    await expect(reader.getByLabel('1 unread notifications')).toBeVisible();
    await reader.getByRole('button', { name: 'Mark all read', exact: true }).click();
    await expect(reader.getByLabel('1 unread notifications')).toHaveCount(0);
    await reader.getByRole('button', { name: 'Notification settings', exact: true }).click();
    const settings = reader.getByRole('dialog', { name: 'Notification settings' });
    await settings.getByRole('checkbox', { name: 'Mentions', exact: true }).uncheck();
    await expect(
      settings.getByRole('checkbox', { name: 'Mentions', exact: true }),
    ).not.toBeChecked();
    await settings.getByRole('button', { name: 'Close dialog' }).click();
    await send('@Teammate another mention, currently disabled');
    await expect
      .poll(
        async () =>
          (
            await db.query(
              'SELECT count(*)::int count FROM notifications WHERE recipient_id=$1 AND read_at IS NULL',
              [mateId],
            )
          )[0]!.count,
      )
      .toBe(0);
    await reader.reload();
    await reader.getByRole('button', { name: /^Notifications/ }).click();
    await reader.getByRole('button', { name: 'Notification settings', exact: true }).click();
    await expect(reader.getByRole('checkbox', { name: 'Mentions', exact: true })).not.toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});
test('shows expiring typing by timeline/thread and shares away/invisible presence across users', async ({
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
    await writer.getByRole('button', { name: /^general/ }).click();
    await reader.getByRole('button', { name: /^general/ }).click();
    await writer.bringToFront();
    await expect(reader.getByRole('img', { name: 'Owner is online', exact: true })).toBeVisible();
    const draft = writer.getByRole('textbox', { name: 'Message #general', exact: true });
    await draft.pressSequentially('A live draft', { delay: 200 });
    await expect(reader.locator('.conversation>.typing-indicator')).toHaveText(/Owner is typing/);
    await draft.fill('');
    await expect(reader.locator('.conversation>.typing-indicator')).toHaveText('');
    const root = await send('A thread for scoped typing');
    await reader
      .locator(`[data-message-id="${root}"]`)
      .getByRole('button', { name: /Reply/ })
      .click();
    await writer
      .locator(`[data-message-id="${root}"]`)
      .getByRole('button', { name: /Reply/ })
      .click();
    await writer.bringToFront();
    const reply = writer.getByRole('textbox', { name: 'Reply to thread', exact: true });
    await reply.pressSequentially('A scoped reply draft', { delay: 200 });
    await expect(reader.locator('.thread-panel>.typing-indicator')).toHaveText(/Owner is typing/);
    await expect(reader.locator('.conversation>.typing-indicator')).toHaveText('');
    await expect(reader.locator('.thread-panel>.typing-indicator')).toHaveText('', {
      timeout: 10000,
    });
    await reader.getByRole('button', { name: 'Close thread', exact: true }).click();
    await writer.getByRole('combobox', { name: 'My presence', exact: true }).selectOption('away');
    await expect(reader.getByRole('img', { name: 'Owner is away', exact: true })).toBeVisible();
    await writer
      .getByRole('combobox', { name: 'My presence', exact: true })
      .selectOption('invisible');
    await expect(reader.getByRole('img', { name: 'Owner is offline', exact: true })).toBeVisible();
    await writer.reload();
    await expect(writer.getByRole('combobox', { name: 'My presence', exact: true })).toHaveValue(
      'invisible',
    );
    await writer
      .getByRole('combobox', { name: 'My presence', exact: true })
      .selectOption('automatic');
    await writer.bringToFront();
    await expect(reader.getByRole('img', { name: 'Owner is online', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await reader.screenshot({ path: test.info().outputPath('orbit-activity.png'), fullPage: true });
  } finally {
    await a.close();
    await b.close();
  }
});
