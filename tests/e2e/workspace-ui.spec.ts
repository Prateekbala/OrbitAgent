import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { taskBrowserFixture } from './task-browser-fixture.js';

let fixture: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeAll(async () => {
  fixture = await taskBrowserFixture();
  await fixture.createTask('Review the launch plan', {
    description: 'Confirm scope and evidence.',
  });
  const knowledge = await fixture.call(fixture.owner, 'POST', '/v1/knowledge', {
    title: 'Working together',
    body: 'Keep decisions, sources, and next steps connected.',
  });
  expect(knowledge.statusCode, knowledge.body).toBe(201);
  const agent = await fixture.call(fixture.owner, 'POST', '/v1/agents', {
    name: 'Atlas',
    role: 'Review project evidence, identify dependencies, and report results with sources.',
    runtime: 'external',
  });
  expect(agent.statusCode, agent.body).toBe(201);
  const project = await fixture.call(fixture.owner, 'POST', '/v1/projects', {
    clientId: randomUUID(),
    name: 'Product launch',
    description: 'Coordinate the launch plan and release checklist.',
    status: 'active',
  });
  expect(project.statusCode, project.body).toBe(201);
});
test.afterAll(async () => fixture?.close());
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
});

async function expectWorkspaceTheme(page: Page) {
  await expect(page.locator('.workspace')).toHaveCSS('background-color', 'rgb(32, 43, 35)');
  await expect(page.locator('.main')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(247, 248, 244)');
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim().toLowerCase(),
    ),
  ).toBe('#263e30');
}

test('all workspace destinations share the sage theme, white surfaces and readable navigation', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await fixture.connect(context);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/app');
  const navigation = page.getByRole('navigation', { name: 'Workspace views', exact: true });
  for (const label of [
    'Notifications',
    'Your messages',
    'Discover channels',
    'Conversations',
    'Tasks',
    'Agents',
    'Knowledge',
    'Agent runs',
    'Automations',
    'Developer',
    'Migrations',
    'Shared channels',
    'Approvals',
    'Team',
  ]) {
    await navigation.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.content-header h1')).toHaveText(
      label === 'Conversations'
        ? fixture.ownerBoot.channels[0]!.name
        : label === 'Discover channels'
          ? 'Channel discovery'
          : label,
    );
    await expectWorkspaceTheme(page);
    if (label === 'Agents' || label === 'Knowledge') {
      expect(
        await page
          .locator('.page-content')
          .evaluate((element) =>
            Math.abs(
              element.getBoundingClientRect().width -
                element.parentElement!.getBoundingClientRect().width,
            ),
          ),
        label,
      ).toBeLessThanOrEqual(1);
    }
    if (label === 'Developer') {
      const permission = page
        .getByRole('group', { name: 'API permissions', exact: true })
        .getByLabel('messages.read', { exact: true });
      await expect(permission).toBeVisible();
      expect(
        await permission.evaluate(
          (element) => getComputedStyle(element.closest('label')!).flexDirection,
        ),
      ).toBe('row');
    }
    {
      await page.screenshot({
        path: test.info().outputPath(`orbit-${label.toLowerCase()}-desktop.png`),
        animations: 'disabled',
      });
    }
  }
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Devices & sessions', exact: true }),
  ).toBeVisible();
  await expectWorkspaceTheme(page);
  await page.screenshot({
    path: test.info().outputPath('orbit-settings-desktop.png'),
    animations: 'disabled',
  });
});

test('task views, mobile forms and dialogs retain keyboard and native form behavior', async ({
  page,
  context,
}) => {
  await fixture.connect(context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  const views = page.getByRole('group', { name: 'Task view', exact: true });
  await expect(views.getByRole('button', { name: 'List', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await views.getByRole('button', { name: 'Kanban', exact: true }).click();
  await expect(views.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('region', { name: 'Proposed column', exact: true })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('orbit-kanban-desktop.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole('button', { name: 'New task', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Create a task', exact: true });
  await expect(dialog).toBeVisible();
  const firstControl = dialog.getByRole('combobox', { name: 'Task audience', exact: true });
  await expect(firstControl).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(firstControl).toBeFocused();
  expect(await dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await expectWorkspaceTheme(page);
  await page.screenshot({
    path: test.info().outputPath('orbit-dialog-mobile.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('every workspace screen fits a phone viewport and keeps its navigation usable', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await fixture.connect(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/app');
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  const navigation = page.getByRole('complementary', { name: 'Workspace navigation', exact: true });
  for (const label of [
    'Notifications',
    'Your messages',
    'Discover channels',
    'Conversations',
    'Tasks',
    'Agents',
    'Knowledge',
    'Agent runs',
    'Automations',
    'Developer',
    'Migrations',
    'Shared channels',
    'Approvals',
    'Team',
  ]) {
    await menu.click();
    await expect(navigation).toBeVisible();
    await navigation.getByRole('button', { name: label, exact: true }).click();
    await expect(navigation).toBeHidden();
    await expect(page.locator('.content-header h1')).toHaveText(
      label === 'Conversations'
        ? fixture.ownerBoot.channels[0]!.name
        : label === 'Discover channels'
          ? 'Channel discovery'
          : label,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      label,
    ).toBe(true);
    if (label === 'Tasks') {
      const filters = page.getByRole('button', { name: 'Filters', exact: true });
      await expect(page.getByLabel('Find tasks', { exact: true })).toBeHidden();
      await filters.click();
      await expect(filters).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByLabel('Find tasks', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Apply task filters', exact: true }).click();
      await expect(filters).toHaveAttribute('aria-expanded', 'false');
      const title = page.locator('.task-row .task-title-button').first();
      await expect(title).toBeVisible();
      expect(
        await title.evaluate((element) => element.getBoundingClientRect().width),
      ).toBeGreaterThan(180);
      expect(
        await title.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeLessThan(60);
    }
    if (['Tasks', 'Knowledge', 'Agents', 'Developer', 'Team'].includes(label))
      await page.screenshot({
        path: test.info().outputPath(`orbit-${label.toLowerCase()}-mobile.png`),
        animations: 'disabled',
      });
  }
});
