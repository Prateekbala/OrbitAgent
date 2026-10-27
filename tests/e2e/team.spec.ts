import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';
import { testEmail, verifyFixtureAccount } from '../../apps/api/test/email.js';
import { verifyFixtureInBrowser } from './account-helpers.js';
import { test, expect, type BrowserContext } from '@playwright/test';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';

let db: Database, server: FastifyInstance, origin: string;
test.beforeAll(async () => {
  db = await database();
  await migrate(db);
  server = await buildApp(db, { origin: browserOrigin, email: testEmail() });
  allowBrowserStreams(server);
  origin = await server.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => {
  await server.close();
  await db.close();
});
test.afterEach(async ({ context, page }) => {
  await page.goto('about:blank');
  await context.unrouteAll({ behavior: 'wait' });
});
async function connect(context: BrowserContext) {
  await proxyApi(context, origin);
}
test('invites a teammate, changes their role, suspends and restores their access', async ({
  page,
  context,
  browser,
}) => {
  await connect(context);
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('Team Owner');
  await page.getByLabel('Workspace name').fill('Invitation Studio');
  await page.getByLabel('Email address').fill('owner@browser.test');
  await page.getByLabel('Password', { exact: true }).fill('owner-browser-test-password');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await verifyFixtureInBrowser(page, db, 'owner@browser.test');
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page.getByRole('button', { name: 'Invite teammate', exact: true }).click();
  await page.getByLabel('Email address').fill('teammate@browser.test');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const link = await page.getByLabel('Private invitation link').inputValue();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  const guestContext = await browser.newContext();
  await connect(guestContext);
  const guest = await guestContext.newPage();
  try {
    await guest.goto(link, { waitUntil: 'domcontentloaded' });
    await expect(
      guest.getByRole('heading', { name: 'Join Invitation Studio', exact: true }),
    ).toBeVisible();
    expect(guest.url()).not.toContain('#');
    await guest.getByLabel('Your name').fill('Invited Teammate');
    await guest.getByLabel('Create a password').fill('teammate-browser-password');
    await guest.getByRole('button', { name: 'Join workspace', exact: true }).click();
    await verifyFixtureInBrowser(guest, db, 'teammate@browser.test');
    await expect(guest.getByRole('button', { name: 'Team', exact: true })).toBeVisible();
    const session = (await guestContext.cookies()).find(
      (cookie) => cookie.name === 'ao_session',
    )!.value;
    const checkSession = () =>
      guest.request.get(origin + '/v1/bootstrap', { headers: { cookie: `ao_session=${session}` } });
    expect((await checkSession()).status()).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await page.getByRole('button', { name: 'Manage Invited Teammate', exact: true }).click();
    await page.getByLabel('Role', { exact: true }).selectOption('admin');
    await page.getByRole('button', { name: 'Save member changes', exact: true }).click();
    await expect(page.locator('.team-row').filter({ hasText: 'Invited Teammate' })).toContainText(
      'admin',
    );
    await page.getByRole('button', { name: 'Manage Invited Teammate', exact: true }).click();
    await page.getByLabel('Access', { exact: true }).selectOption('suspended');
    await page.getByRole('button', { name: 'Save member changes', exact: true }).click();
    await expect(page.locator('.team-row').filter({ hasText: 'Invited Teammate' })).toContainText(
      'suspended',
    );
    const revoked = await checkSession();
    expect(revoked.status()).toBe(401);
    await page.getByRole('button', { name: 'Manage Invited Teammate', exact: true }).click();
    await page.getByLabel('Access', { exact: true }).selectOption('active');
    await page.getByRole('button', { name: 'Save member changes', exact: true }).click();
    await expect(page.locator('.team-row').filter({ hasText: 'Invited Teammate' })).toContainText(
      'active',
    );
    expect((await checkSession()).status()).toBe(401);
    await page.screenshot({ path: test.info().outputPath('team.png'), fullPage: true });
  } finally {
    await guestContext.close();
  }
});

test('an existing account signs in from an invitation and switches between its workspaces', async ({
  page,
  context,
}) => {
  const signup = async (email: string, workspace: string) => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, workspace, name: workspace, password: 'existing-browser-password' },
    });
    expect(response.statusCode).toBe(201);
    await verifyFixtureAccount(db, email);
    return response.cookies[0]!.value;
  };
  const owner = await signup('existing-owner@browser.test', 'Second Team');
  await signup('existing-person@browser.test', 'Previous Studio');
  const invitation = await server.inject({
    method: 'POST',
    url: '/v1/invitations',
    headers: { cookie: `ao_session=${owner}` },
    payload: { email: 'existing-person@browser.test' },
  });
  expect(invitation.statusCode).toBe(201);
  await connect(context);
  await page.goto(`/invite#${invitation.json().token}`);
  await page.getByRole('button', { name: 'Already have an account? Sign in', exact: true }).click();
  await page.getByLabel('Email address').fill('existing-person@browser.test');
  await page.getByLabel('Password', { exact: true }).fill('existing-browser-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Join workspace', exact: true }).click();
  await expect(page.locator('.workspace-title')).toHaveText('Second Team');
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page
    .getByLabel('Current workspace', { exact: true })
    .selectOption({ label: 'Previous Studio · owner' });
  await expect(page.locator('.workspace-title')).toHaveText('Previous Studio');
});
