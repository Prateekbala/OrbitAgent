import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { testEmail } from '../../apps/api/test/email.js';
import { allowBrowserStreams, browserOrigin, proxyApi } from './api-proxy.js';

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
  test(`authentication stays readable and contained at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const route of ['/sign-in', '/sign-up']) {
      const signup = route === '/sign-up';
      await page.goto(route);
      await expect(
        page.getByRole('button', { name: signup ? 'Create workspace' : 'Sign in', exact: true }),
      ).toBeEnabled();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        signup ? 'Make room for great work.' : 'Back to your orbit.',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        await page
          .getByLabel('Email address', { exact: true })
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
      if (viewport.width === 1440) {
        const result = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        expect(result.violations).toEqual([]);
      }
      if ([1440, 1280, 390].includes(viewport.width)) {
        await page.screenshot({
          path: test.info().outputPath(`${signup ? 'signup' : 'signin'}-${viewport.width}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      }
    }
  });
}

test('password visibility, mode switching, API errors, and organization discovery work with the new forms', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/sign-in');
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('unknown-account-password');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByLabel('Email address', { exact: true }).fill('unknown-account@example.test');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await page.getByRole('link', { name: 'Create a new workspace', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
  await expect(password).toHaveAttribute('autocomplete', 'new-password');
  await page.getByRole('link', { name: 'Already have a workspace? Sign in', exact: true }).click();
  const sso = page.getByText('Continue with single sign-on', { exact: true });
  await sso.focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Organization email or ID', { exact: true }).fill('nobody@example.test');
  await page.getByRole('button', { name: 'Find single sign-on', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'No federated provider is configured for this email domain.',
  );
  await expect(
    page.getByRole('link', { name: 'Forgot your password?', exact: true }),
  ).toHaveAttribute('href', '/forgot-password');
  expect(errors).toEqual([]);
});

test('dark appearance and live reduced-motion preferences remain usable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('orbit-appearance', 'dark'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1 }).locator('..')).toHaveAttribute(
    'data-motion-entered',
    'true',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  for (const route of ['/sign-in', '/sign-up']) {
    await page.goto(route);
    await expect(
      page.getByRole('button', {
        name: route === '/sign-up' ? 'Create workspace' : 'Sign in',
        exact: true,
      }),
    ).toBeEnabled();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`${route === '/sign-up' ? 'signup' : 'signin'}-dark.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
});
