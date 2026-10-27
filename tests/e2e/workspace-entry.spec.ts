import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { taskBrowserFixture } from './task-browser-fixture.js';
import { entryPath } from '../../apps/web/lib/auth-navigation.js';

let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async ({ page }) => {
  f = await taskBrowserFixture();
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await context.unrouteAll({ behavior: 'wait' });
  await page.unrouteAll({ behavior: 'wait' });
  await f.close();
});

test('sign-in and sign-up have stable routes, preserve message context, and finish entering before allowing more input', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await context.clearCookies();
  const email = (await f.call(f.owner, 'GET', '/v1/auth/status')).json().email;
  const channel = f.ownerBoot.channels[0]!.id;
  const message = (await f.send(f.owner, channel, 'Open this source after signing in.')).json().id;
  const search = `?workspace=${f.ownerBoot.workspace.id}&message=${message}`;
  expect(entryPath('/app', search + '&next=https://untrusted.example&token=private')).toBe(
    '/app' + search,
  );
  expect(entryPath('/app', '?workspace=invalid&next=//untrusted.example')).toBe('/app');
  await page.goto('/sign-in' + search);
  await page.getByRole('link', { name: 'Create a new workspace', exact: true }).click();
  await expect(page).toHaveURL('/sign-up' + search);
  await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/sign-in' + search);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('messaging-test-password');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/bootstrap', async (route) => {
    await pending;
    await route.fallback();
  });
  try {
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Opening your workspace.', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.locator('.workspace-title')).toHaveText(f.ownerBoot.workspace.name);
  await expect(
    page.locator('.message').getByText('Open this source after signing in.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL('/app' + search);
});

test('authenticated visits skip account forms and the welcome guide opens real work and persists dismissal', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/sign-up');
  await expect(page).toHaveURL(/\/app$/);
  const welcome = page.getByRole('region', { name: 'Getting started', exact: true });
  await expect(welcome).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .include('.workspace-welcome')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await welcome.getByRole('button', { name: 'Set up your workspace', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Open Create your first task', exact: true })
    .click();
  const create = page.getByRole('dialog', { name: 'Create a task', exact: true });
  await expect(create).toBeVisible();
  await create.getByLabel('Task title').fill('A clear first step');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A clear first step', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await welcome.getByRole('button', { name: 'Dismiss welcome', exact: true }).click();
  await expect(welcome).toHaveCount(0);
  await expect
    .poll(async () => (await f.call(f.owner, 'GET', '/v1/account/onboarding')).json().dismissed)
    .toBe(true);
  await page.reload();
  await expect(page.locator('.workspace-title')).toBeVisible();
  await expect(welcome).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('workspace-journey.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('the workspace picker searches accessible workspaces and clears old context when switching', async ({
  page,
  context,
}) => {
  const organization = (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0];
  const created = await f.call(f.owner, 'POST', `/v1/organizations/${organization.id}/workspaces`, {
    name: 'Second workspace',
    region: 'global',
  });
  expect(created.statusCode).toBe(201);
  await f.connect(context);
  await page.goto('/app');
  await page
    .getByRole('button', { name: `Switch workspace: ${f.ownerBoot.workspace.name}`, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Your workspaces', exact: true });
  await expect(
    dialog.getByRole('button', { name: 'Open Second workspace', exact: true }),
  ).toBeEnabled();
  expect(
    (
      await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await dialog.getByLabel('Find a workspace', { exact: true }).fill('missing');
  await expect(dialog.getByRole('status')).toHaveText('No workspaces match your search.');
  await dialog.getByLabel('Find a workspace', { exact: true }).fill('second');
  await dialog.getByRole('button', { name: 'Open Second workspace', exact: true }).click();
  await expect(page.locator('.workspace-title')).toHaveText('Second workspace');
  await expect(page).toHaveURL(/\/app$/);
  await page
    .getByRole('button', { name: 'Switch workspace: Second workspace', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Open Second workspace', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Switch workspace: Second workspace', exact: true }),
  ).toBeFocused();
});

test('workspace entry failures can be retried and theme choice survives account navigation', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.addInitScript(() => localStorage.setItem('orbit-appearance', 'dark'));
  let failed = false;
  await page.route('**/api/v1/bootstrap', async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Connection interrupted. Try again.' } }),
      });
    } else await route.fallback();
  });
  await page.goto('/app');
  await expect(
    page.getByRole('heading', { name: 'A small interruption.', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.workspace-title')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({
    path: test.info().outputPath('workspace-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.goto('/sign-in');
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator('.workspace-title')).toBeVisible();
});

test('verification, organization requirements, and session expiry replace each other instead of trapping the user', async ({
  page,
  context,
}) => {
  await f.connect(context);
  let phase = 0;
  await page.route('**/api/v1/bootstrap', async (route) => {
    const error =
      phase === 0
        ? { status: 403, code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email first.' }
        : phase === 1
          ? {
              status: 403,
              code: 'MFA_ENROLLMENT_REQUIRED',
              message: 'Set up two-factor authentication to continue.',
            }
          : { status: 401, code: 'UNAUTHENTICATED', message: 'Sign in again.' };
    await route.fulfill({
      status: error.status,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: error.code, message: error.message } }),
    });
  });
  await page.goto('/app');
  await expect(
    page.getByRole('heading', { name: 'Verify your email.', exact: true }),
  ).toBeVisible();
  phase = 1;
  await page.getByRole('button', { name: 'I’ve verified my email', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Account and security', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verify your email.', exact: true })).toHaveCount(
    0,
  );
  phase = 2;
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Back to your orbit.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Account and security', exact: true })).toHaveCount(
    0,
  );
});
