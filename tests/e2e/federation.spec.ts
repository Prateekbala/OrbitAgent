import { test, expect } from '@playwright/test';
import { taskBrowserFixture } from './task-browser-fixture.js';
import { browserOrigin } from './api-proxy.js';
import { oidcFixture } from '../../apps/api/test/federation-fixture.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>, idp: Awaited<ReturnType<typeof oidcFixture>>;
test.beforeAll(async () => {
  idp = await oidcFixture(browserOrigin);
  f = await taskBrowserFixture(undefined, {
    federation: { allowedHosts: ['127.0.0.1'], allowLoopback: true },
  });
  idp.setBrowserUser((await f.call(f.owner, 'GET', '/v1/account')).json().email);
});
test.afterAll(async () => {
  await f?.close();
  await idp?.close();
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
});
test('configures and links an OIDC provider, enforces organization SSO, and signs in through the browser redirect flow', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  const organization = page.getByRole('region', { name: 'Organization management' }),
    org = (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0];
  await organization
    .locator('summary')
    .filter({ hasText: /^Configure identity provider$/ })
    .click();
  await organization.getByLabel('Provider name', { exact: true }).fill('Local browser IdP');
  await organization.getByLabel('OIDC issuer URL', { exact: true }).fill(idp.origin);
  await organization.getByLabel('Client ID', { exact: true }).fill('orbit-client');
  await organization.getByLabel('Client secret', { exact: true }).fill('test-client-secret');
  await organization.getByRole('button', { name: 'Save identity provider', exact: true }).click();
  await expect(
    organization.locator('.team-row').filter({ hasText: 'Local browser IdP' }),
  ).toBeVisible();
  await organization.getByRole('link', { name: 'Link & sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Authorize Orbit', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Settings & activity', exact: true }),
  ).toBeVisible();
  const cookie = (await context.cookies()).find((c) => c.name === 'ao_session')!.value;
  expect((await f.call(cookie, 'GET', '/v1/account/identities')).json()).toHaveLength(1);
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  await organization.getByLabel('Require enterprise single sign-on').check();
  await organization
    .getByRole('button', { name: 'Save organization policies', exact: true })
    .click();
  await expect(organization.getByRole('status')).toHaveText('Organization policies updated.');
  expect((await f.call(f.owner, 'GET', '/v1/bootstrap')).json().error.code).toBe('SSO_REQUIRED');
  await page
    .getByRole('region', { name: 'Account and security' })
    .getByRole('button', { name: 'Sign out', exact: true })
    .click();
  await page.getByText('Continue with single sign-on', { exact: true }).click();
  await page.getByLabel('Organization email or ID').fill(org.id);
  await page.getByRole('button', { name: 'Find single sign-on', exact: true }).click();
  await page.getByRole('link', { name: 'Continue with Local browser IdP', exact: true }).click();
  await page.getByRole('button', { name: 'Authorize Orbit', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Settings & activity', exact: true }),
  ).toBeVisible();
  expect(
    (await f.boot((await context.cookies()).find((c) => c.name === 'ao_session')!.value)).me.id,
  ).toBe(f.ownerBoot.me.id);
});
