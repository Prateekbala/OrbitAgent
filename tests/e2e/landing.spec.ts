import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { testEmail } from '../../apps/api/test/email.js';
import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';

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
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await proxyApi(page, origin);
});
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
});

test('public landing renders without workspace requests, supports feature navigation, and opens real signup', async ({
  page,
}) => {
  const errors: string[] = [],
    apiRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/')) apiRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'AI that connects your team to the work that matters',
  );
  await expect(page.locator('video')).not.toHaveAttribute('src');
  expect(apiRequests).toEqual([]);
  expect(
    await page
      .locator('main')
      .evaluate((element) => getComputedStyle(element).getPropertyValue('--landing-coral').trim()),
  ).toBe('#fc4718');
  await expect(page.locator('video')).toHaveCSS('filter', 'none');
  await page.screenshot({
    path: test.info().outputPath('landing-desktop.png'),
    animations: 'disabled',
  });
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  await nav.getByRole('link', { name: 'Features', exact: true }).click();
  const featureNav = page.getByRole('navigation', { name: 'Explore Orbit features', exact: true });
  const agentLink = featureNav.getByRole('link', { name: '1.1 Agent execution', exact: true });
  await agentLink.click();
  await expect(agentLink).toHaveAttribute('aria-current', 'location');
  await expect(page.getByRole('heading', { name: 'Good work. With a clear trail.' })).toBeVisible();
  await agentLink.press('Tab');
  await expect(
    featureNav.getByRole('link', { name: '1.2 Inspectable knowledge', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#feature-knowledge$/);
  await expect(
    page.getByRole('heading', { name: 'The launch follows the final design review.' }),
  ).toBeVisible();
  await featureNav.getByRole('link', { name: '1.0 Shared conversations', exact: true }).click();
  await page
    .locator('#feature-conversations')
    .screenshot({ path: test.info().outputPath('landing-features.png'), animations: 'disabled' });
  expect(apiRequests).toEqual([]);
  await page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  await expect(page.getByRole('button', { name: 'Create workspace', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('phone layout has no horizontal overflow, supports the menu and reduced-motion preview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('landing-mobile.png'),
    animations: 'disabled',
  });
  const menu = page.getByRole('button', { name: 'Open menu', exact: true });
  await menu.click();
  await page
    .getByRole('navigation', { name: 'Mobile navigation', exact: true })
    .getByRole('link', { name: 'Integrations', exact: true })
    .click();
  await expect(page).toHaveURL(/#integrations$/);
  await expect(
    page.getByRole('navigation', { name: 'Mobile navigation', exact: true }),
  ).toHaveCount(0);
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});

test('old message permalinks preserve their audience and message parameters', async ({ page }) => {
  const workspace = '00000000-0000-4000-8000-000000000001';
  const message = '00000000-0000-4000-8000-000000000002';
  await page.goto(`/?workspace=${workspace}&message=${message}`);
  const url = new URL(page.url());
  expect(url.pathname).toBe('/app');
  expect(url.searchParams.get('workspace')).toBe(workspace);
  expect(url.searchParams.get('message')).toBe(message);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('smooth navigation and motion preserve the original landscape and respect live preferences', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const video = page.locator('video');
  await expect(video).toHaveAttribute('poster', '/landing/landscape.png');
  await expect(video).toHaveAttribute('src', '/landing/landscape.mp4');
  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'smooth');
  await expect(page.getByRole('heading', { level: 1 }).locator('..')).toHaveAttribute(
    'data-motion-entered',
    'true',
  );

  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('link', { name: 'Product', exact: true })
    .click();
  await expect(page).toHaveURL(/#product$/);
  await expect
    .poll(() =>
      page
        .locator('#product')
        .evaluate((element) => Math.abs(element.getBoundingClientRect().top - 24)),
    )
    .toBeLessThan(3);

  const context = page.getByLabel('Illustrative connected project context', { exact: true });
  await context.scrollIntoViewIfNeeded();
  await expect(context).toHaveAttribute('data-motion-entered', 'true');
  await expect
    .poll(() =>
      context.evaluate((element) => {
        const preview = element.firstElementChild!.getBoundingClientRect();
        const frame = element.getBoundingClientRect();
        return Math.max(0, frame.left - preview.left) + Math.max(0, preview.right - frame.right);
      }),
    )
    .toBeLessThan(2);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto');
  await expect(video).toHaveJSProperty('paused', true);
  await expect(video).toHaveCSS('transform', 'none');
});

test('the original hero and signup links remain available without JavaScript', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'AI that connects your team to the work that matters',
    );
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true }),
    ).toHaveAttribute('href', '/sign-up');
    await expect(page.locator('video')).not.toHaveAttribute('src');
  } finally {
    await context.close();
  }
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`reference layout fills the first screen and stays contained at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    const hero = page.locator('main > section').first();
    const bounds = await hero.boundingBox();
    expect(bounds!.y + bounds!.height).toBeGreaterThanOrEqual(viewport.height - 1);
    if (viewport.width >= 1200 || viewport.width === 390) {
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    const titleSize = await page
      .getByRole('heading', { level: 1 })
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(titleSize).toBeGreaterThanOrEqual(viewport.width > 760 ? 48 : 36);
    if (viewport.width >= 1200 && viewport.height > 820)
      expect(titleSize).toBeGreaterThanOrEqual(64);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const next = page.locator('#connected-context');
    await next.scrollIntoViewIfNeeded();
    await expect(next.getByRole('heading', { level: 2 })).toBeVisible();
    const contained = await page
      .getByLabel('Illustrative connected project context', { exact: true })
      .evaluate((el) =>
        [...el.children].every((child) => {
          const r = child.getBoundingClientRect();
          return r.left >= -1 && r.right <= innerWidth + 1;
        }),
      );
    expect(contained).toBe(true);
    for (const section of ['#features', '#integrations', '#pricing']) {
      await page.locator(section).scrollIntoViewIfNeeded();
      expect(
        await page.locator(section).evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= -1 && bounds.right <= innerWidth + 1;
        }),
      ).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath('layout.png'), animations: 'disabled' });
  });
}

test('connection discovery and pricing controls work without connecting providers or starting checkout', async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/')) apiRequests.push(request.url());
  });
  await page.goto('/');
  const integrations = page.locator('#integrations');
  await integrations.scrollIntoViewIfNeeded();
  const categories = integrations.getByRole('group', { name: 'Connection categories' });
  await categories.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(integrations.getByRole('status')).toHaveText('3 connections to explore');
  await expect(
    integrations.getByRole('link', { name: 'Explore Notion connection' }),
  ).toHaveAttribute('href', '/app');
  await integrations.getByLabel('Find a connection', { exact: true }).fill('GitHub');
  await expect(integrations.getByText('No matching connections.', { exact: true })).toBeVisible();
  await integrations.getByRole('button', { name: 'Clear filters' }).click();
  await expect(integrations.getByRole('status')).toHaveText('8 connections to explore');
  await integrations.getByLabel('Find a connection', { exact: true }).fill('GITHUB');
  await expect(integrations.getByRole('status')).toHaveText('1 connection to explore');
  await expect(integrations.getByRole('link', { name: 'Explore GitHub connection' })).toBeVisible();
  await integrations.getByLabel('Find a connection', { exact: true }).fill('');
  await integrations.screenshot({
    path: test.info().outputPath('integrations-desktop.png'),
    animations: 'disabled',
  });

  const pricing = page.locator('#pricing');
  await pricing.scrollIntoViewIfNeeded();
  const team = pricing.getByRole('article', { name: 'Team', exact: true });
  await expect(pricing.getByRole('radio', { name: /Yearly/ })).toBeChecked();
  await expect(team.getByText('$16', { exact: true })).toBeVisible();
  await expect(team.getByText('$192 per person, billed yearly.', { exact: true })).toBeVisible();
  await pricing.getByRole('radio', { name: 'Monthly', exact: true }).check();
  await expect(team.getByText('$20', { exact: true })).toBeVisible();
  await expect(team.getByText('$20 per person, billed monthly.', { exact: true })).toBeVisible();
  await pricing.getByRole('radio', { name: 'Monthly', exact: true }).press('ArrowRight');
  await expect(pricing.getByRole('radio', { name: /Yearly/ })).toBeChecked();
  await pricing.getByText('Who counts as a paid seat?', { exact: true }).click();
  await expect(pricing.getByText(/An active human member counts once/)).toBeVisible();
  await pricing.getByText('Who counts as a paid seat?', { exact: true }).press('Enter');
  await expect(pricing.getByText(/An active human member counts once/)).not.toBeVisible();
  await expect(pricing.getByRole('link', { name: 'Get started with Team' })).toHaveAttribute(
    'href',
    '/sign-up',
  );
  const accessibility = await new AxeBuilder({ page })
    .include('#integrations')
    .include('#pricing')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await pricing.getByRole('heading', { level: 2 }).click();
  await pricing.screenshot({
    path: test.info().outputPath('pricing-desktop.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await pricing.screenshot({
    path: test.info().outputPath('pricing-mobile.png'),
    animations: 'disabled',
  });
  await integrations.screenshot({
    path: test.info().outputPath('integrations-mobile.png'),
    animations: 'disabled',
  });
  expect(apiRequests).toEqual([]);
});
