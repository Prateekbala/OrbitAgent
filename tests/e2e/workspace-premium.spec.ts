import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { taskBrowserFixture } from './task-browser-fixture.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async ({ page, context }) => {
  f = await taskBrowserFixture();
  await f.connect(context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
  await f.close();
});

test('quick navigation supports shortcuts, filtering, arrow keys, and real workspace destinations', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/app');
  await expect(page.locator('.workspace-title')).toBeVisible();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Go anywhere in your workspace', exact: true });
  const search = dialog.getByLabel('Find a workspace destination', { exact: true });
  await expect(search).toBeFocused();
  await search.fill('no-matching-destination');
  await expect(dialog.getByRole('status')).toContainText('No destinations match');
  await search.fill('knowledge');
  expect(
    (
      await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await search.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Workspace knowledge', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open quick navigation', exact: true }).click();
  await search.fill(f.ownerBoot.channels[0]!.name);
  await search.press('ArrowDown');
  await expect(
    dialog.getByRole('button', { name: f.ownerBoot.channels[0]!.name, exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.content-header h1')).toHaveText(f.ownerBoot.channels[0]!.name);
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('scene transitions settle cleanly and live reduced motion disables animation and smooth scrolling', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/app');
  await page
    .getByRole('navigation', { name: 'Workspace views', exact: true })
    .getByRole('button', { name: 'Tasks', exact: true })
    .click();
  const content = page.locator('.content-body');
  await expect(content).toHaveAttribute('data-scene-entered', 'tasks');
  await expect(content).toHaveCSS('transform', 'none');
  await expect(content).toHaveCSS('opacity', '1');
  await expect(page.locator('.task-page')).toHaveCSS('scroll-behavior', 'smooth');
  await page
    .getByRole('navigation', { name: 'Workspace views', exact: true })
    .getByRole('button', { name: 'Knowledge', exact: true })
    .click();
  await expect(content).toHaveAttribute('data-scene-entered', 'knowledge');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(content).toHaveCSS('transform', 'none');
  await expect(content).toHaveCSS('opacity', '1');
  await expect(page.locator('.knowledge-page')).toHaveCSS('scroll-behavior', 'auto');
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await expect(content).toHaveCSS('transform', 'none');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  await expect(page.locator('.workspace-settings')).toHaveCSS('scroll-behavior', 'auto');
});

test('settings navigation and return-to-top use the actual scroll container without hiding keyboard focus', async ({
  page,
}) => {
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  const settings = page.locator('.workspace-settings');
  await expect(
    page.getByRole('region', { name: 'Account and security', exact: true }),
  ).toBeVisible();
  await page.getByRole('radio', { name: 'Connections', exact: true }).click();
  await expect.poll(() => settings.evaluate((element) => element.scrollTop)).toBeGreaterThan(360);
  const back = page.getByRole('button', { name: 'Back to section top', exact: true });
  await expect(back).toBeVisible();
  await back.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => settings.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(back).toBeFocused();
  await expect(back).toBeVisible();
  await page.getByRole('radio', { name: 'Overview', exact: true }).focus();
  await expect(back).toBeHidden();
});

test('black and green workspace sections and quick navigation fit a phone', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('orbit-appearance', 'dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app');
  await page.getByRole('button', { name: 'Open quick navigation', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Go anywhere in your workspace', exact: true });
  await dialog.getByLabel('Find a workspace destination', { exact: true }).fill('tasks');
  await dialog.getByRole('button', { name: 'Tasks & projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workspace tasks', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('premium-tasks-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Open quick navigation', exact: true }).click();
  await page.screenshot({
    path: test.info().outputPath('premium-command-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Open quick navigation', exact: true }),
  ).toBeFocused();
});
