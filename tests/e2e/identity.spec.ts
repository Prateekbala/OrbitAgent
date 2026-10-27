import { test, expect } from '@playwright/test';
import { generate } from 'otplib';
import { taskBrowserFixture } from './task-browser-fixture.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async () => {
  f = await taskBrowserFixture();
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
  await f?.close();
});
test('edits the profile, creates an organization workspace, and manages provisioning and service credentials', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  const account = page.getByRole('region', { name: 'Account and security' }),
    organization = page.getByRole('region', { name: 'Organization management' });
  await account.getByLabel('Display name', { exact: true }).fill('Browser Identity Owner');
  await account.getByLabel('Time zone', { exact: true }).fill('Asia/Kolkata');
  await account.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(account.getByRole('status')).toHaveText('Profile updated.');
  expect((await f.boot(f.owner)).me.name).toBe('Browser Identity Owner');
  await organization
    .locator('summary')
    .filter({ hasText: /^Create workspace$/ })
    .click();
  await organization
    .getByLabel('Workspace name', { exact: true })
    .fill('Browser organization workspace');
  await organization.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(
    organization.locator('.team-row').filter({ hasText: 'Browser organization workspace' }),
  ).toBeVisible();
  const scim = organization
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'SCIM provisioning', exact: true }) });
  await scim.getByLabel('Token label').fill('Browser provisioning');
  await scim.getByRole('button', { name: 'Create provisioning token', exact: true }).click();
  await expect(scim.getByLabel('One-time provisioning token')).toHaveValue(/[A-Za-z0-9_-]{43}/);
  await scim.getByRole('button', { name: 'I saved this token', exact: true }).click();
  await scim.getByRole('button', { name: 'Revoke token', exact: true }).click();
  await expect(scim.locator('.team-row')).toContainText('Revoked');
  await page
    .locator('summary')
    .filter({ hasText: /^Create service account$/ })
    .click();
  await page.getByLabel('Service account name').fill('Browser reporting service');
  await page.getByLabel('messages.read', { exact: true }).check();
  await page
    .getByRole('group', { name: 'Shared conversations' })
    .getByLabel(f.ownerBoot.channels[0]!.name, { exact: true })
    .check();
  await page.getByRole('button', { name: 'Create service account', exact: true }).click();
  await expect(page.getByLabel('Service account token')).toHaveValue(/[A-Za-z0-9_-]{43}/);
  await page.getByRole('button', { name: 'I saved the credential', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke service account', exact: true }).click();
  await expect(
    page.locator('.team-row').filter({ hasText: 'Browser reporting service' }),
  ).toContainText('Revoked');
  await page.screenshot({
    path: test.info().outputPath('organization-settings.png'),
    fullPage: true,
  });
});
test('enrolls MFA, rotates the current session, signs in with a recovery code, and lists the authenticated device', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  const account = page.getByRole('region', { name: 'Account and security' }),
    mfa = account.locator('article').filter({
      has: page.getByRole('heading', { name: 'Two-factor authentication', exact: true }),
    });
  await mfa.getByLabel('Current password', { exact: true }).fill('messaging-test-password');
  await mfa.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  const secret = await mfa.getByLabel('Authenticator setup key').inputValue();
  await mfa.getByLabel('Six-digit code').fill(await generate({ secret }));
  await mfa.getByRole('button', { name: 'Enable two-factor authentication', exact: true }).click();
  const codes = (await account.getByLabel('Recovery codes', { exact: true }).inputValue()).split(
    '\n',
  );
  expect(codes).toHaveLength(10);
  expect((await f.call(f.owner, 'GET', '/v1/bootstrap')).statusCode).toBe(401);
  const cookie = (await context.cookies()).find((c) => c.name === 'ao_session')!.value;
  expect(cookie).not.toBe(f.owner);
  const profile = (await f.call(cookie, 'GET', '/v1/account')).json();
  await account.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/sign-in/);
  await page.getByLabel('Email address', { exact: true }).fill(profile.email);
  await page.getByLabel('Password', { exact: true }).fill('messaging-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(codes[0]!);
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Settings & activity', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Devices & sessions', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.team-row').filter({ hasText: 'This session' })).toContainText(
    'password + MFA',
  );
});
test('changes workspace access through the guest and permission editor and offboards the member', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page.getByRole('button', { name: 'Manage Teammate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage Teammate', exact: true });
  await dialog.getByText('Guest access & granular permissions', { exact: true }).click();
  await dialog.getByLabel('Account access', { exact: true }).selectOption('guest');
  await dialog
    .getByRole('group', { name: 'Share conversations' })
    .getByLabel(f.ownerBoot.channels[0]!.name, { exact: true })
    .check();
  await dialog.getByRole('button', { name: 'Save access policy', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await f.call(f.mate, 'GET', '/v1/bootstrap')).statusCode).toBe(401);
  await page.getByRole('button', { name: 'Manage Teammate', exact: true }).click();
  await dialog.getByText('Complete offboarding', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Offboard workspace member', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.team-row').filter({ hasText: 'Teammate' }).first()).toContainText(
    'suspended',
  );
});
