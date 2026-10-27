import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { testEmail } from '../../apps/api/test/email.js';
import { allowBrowserStreams, browserOrigin, proxyApi } from './api-proxy.js';

let db: Database, server: FastifyInstance, origin: string;
const unissuedToken = 'a'.repeat(43);
const flows = [
  {
    path: '/forgot-password',
    title: 'Find your way back.',
    action: 'Send recovery email',
    token: false,
  },
  {
    path: '/reset-password',
    title: 'Choose a new password.',
    action: 'Update password',
    token: true,
  },
  {
    path: '/verify-email',
    title: 'Confirm your email.',
    action: 'Verify email address',
    token: true,
  },
  {
    path: '/change-email',
    title: 'Confirm your new email.',
    action: 'Confirm email change',
    token: true,
  },
] as const;

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
test.beforeEach(async ({ context, page }) => {
  await proxyApi(context, origin);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await context.unrouteAll({ behavior: 'wait' });
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1280, height: 720 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`account flows remain readable and contained at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const flow of flows) {
      await page.goto(flow.path + (flow.token ? `#${unissuedToken}` : ''));
      await expect(page.getByRole('button', { name: flow.action, exact: true })).toBeEnabled();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(flow.title);
      expect(new URL(page.url()).hash).toBe('');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.evaluate(() => document.fonts.ready);
      if (viewport.width === 1440) {
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
        ).toEqual([]);
      }
      if ([1440, 390].includes(viewport.width)) {
        await page.screenshot({
          path: test.info().outputPath(`${flow.path.slice(1)}-${viewport.width}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      }
    }
  });
}

test('missing proofs, mismatched passwords, and unavailable links show actionable errors', async ({
  page,
}) => {
  const main = page.getByRole('main');
  const submissions: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') submissions.push(new URL(request.url()).pathname);
  });
  for (const flow of flows.filter((flow) => flow.token)) {
    await page.goto(flow.path);
    await expect(main.getByRole('alert')).toContainText('Open the complete link');
    await expect(page.getByRole('button', { name: flow.action, exact: true })).toBeDisabled();
  }
  expect(submissions).toEqual([]);
  await page.goto(`/reset-password#${unissuedToken}`);
  await page.getByLabel('New password', { exact: true }).fill('new-browser-password');
  await page.getByLabel('Confirm password', { exact: true }).fill('different-browser-password');
  await page.getByRole('button', { name: 'Show passwords', exact: true }).click();
  await expect(page.getByLabel('Confirm password', { exact: true })).toHaveAttribute(
    'type',
    'text',
  );
  await page.getByRole('button', { name: 'Hide passwords', exact: true }).click();
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await expect(main.getByRole('alert')).toHaveText('The passwords do not match.');
  expect(submissions).toEqual([]);
  await page.getByLabel('Confirm password', { exact: true }).fill('new-browser-password');
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await expect(main.getByRole('alert')).toContainText('invalid, expired, or already used');
  await expect(
    page.getByRole('link', { name: 'Request a new recovery link', exact: true }),
  ).toHaveAttribute('href', '/forgot-password');
  await page.goto(`/verify-email#${unissuedToken}`);
  await page.getByRole('button', { name: 'Verify email address', exact: true }).click();
  await expect(main.getByRole('alert')).toContainText('invalid, expired, or already used');
  await expect(page.getByRole('link', { name: 'Back to sign in', exact: true })).toHaveAttribute(
    'href',
    '/sign-in',
  );
});

test('recovery confirmation stays generic, accessible, and keyboard focused', async ({ page }) => {
  await page.goto('/forgot-password');
  await page
    .getByLabel('Email address', { exact: true })
    .fill('unregistered-recovery@example.test');
  await page.getByRole('button', { name: 'Send recovery email', exact: true }).click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText('Check your inbox.');
  await expect(heading).toBeFocused();
  await expect(page.getByRole('status')).toContainText('If this address is eligible');
  await expect(page.getByRole('link', { name: 'Go to sign in', exact: true })).toHaveAttribute(
    'href',
    '/sign-in',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath('recovery-inbox.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('verification gate supports resend, retry, and switching accounts', async ({ page }) => {
  await page.goto('/sign-up');
  await page.getByLabel('Your name', { exact: true }).fill('Verification Reader');
  await page.getByLabel('Workspace name', { exact: true }).fill('Verification Studio');
  await page.getByLabel('Email address', { exact: true }).fill('verification-ui@example.test');
  await page.getByLabel('Password', { exact: true }).fill('verification-ui-password');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Verify your email.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toContainText('verification-ui@example.test');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Resend verification email', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('verification email will arrive shortly');
  await page.getByRole('button', { name: 'I’ve verified my email', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'has not been verified yet',
  );
  await page.screenshot({
    path: test.info().outputPath('verification-gate.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Use another account', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
});

test('account flows follow dark appearance and live reduced-motion preferences', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('orbit-appearance', 'dark'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { level: 1 }).locator('../..')).toHaveAttribute(
    'data-motion-entered',
    'true',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const flow of flows) {
    await page.goto(flow.path + (flow.token ? `#${unissuedToken}` : ''));
    await expect(page.getByRole('button', { name: flow.action, exact: true })).toBeEnabled();
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`${flow.path.slice(1)}-dark.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
});
