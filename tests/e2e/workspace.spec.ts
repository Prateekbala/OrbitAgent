import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { testEmail } from '../../apps/api/test/email.js';
import { verifyFixtureInBrowser } from './account-helpers.js';
import { test, expect } from '@playwright/test';
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
test('account, persisted message, thread, task, knowledge and agent identity', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await proxyApi(page, origin);
  await page.goto('/sign-up');
  await expect(page.getByRole('button', { name: 'Create workspace', exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('orbit-auth-desktop.png'), fullPage: true });
  await page.getByLabel('Your name').fill('Alex Morgan');
  await page.getByLabel('Workspace name').fill('Fieldwork Studio');
  const address = `browser-${Date.now()}@example.test`;
  await page.getByLabel('Email address').fill(address);
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password-2026');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await verifyFixtureInBrowser(page, db, address);
  await expect(page.getByRole('heading', { name: 'Welcome to #engineering' })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Message #engineering' })
    .fill('Release checklist is ready for review.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.locator('.message').getByText('Release checklist is ready for review.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator('.message').getByText('Release checklist is ready for review.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reply in thread' }).click();
  await page.getByRole('textbox', { name: 'Reply to thread' }).fill('Verified the checklist.');
  await page.locator('.thread-panel').getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Verified the checklist.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close thread' }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Task title').fill('Review the release checklist');
  await page
    .getByLabel('Description', { exact: true })
    .fill('Confirm release checks before shipping.');
  await page.getByLabel('Assignee', { exact: true }).selectOption({ label: 'Alex Morgan' });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review the release checklist' })).toBeVisible();
  await page.getByLabel('Update Review the release checklist').selectOption('queued');
  await expect(page.locator('.task-row .state')).toHaveText('Queued');
  await expect(page.getByText('Loading tasks…', { exact: true })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Review the release checklist' })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('orbit-tasks-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'New page', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Release decisions');
  await page
    .getByLabel('Content', { exact: true })
    .fill('Every release requires a verified checklist and an accountable owner.');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: /Release decisions/ }).click();
  await expect(page.locator('.document-body')).toContainText('verified checklist');
  await page.getByRole('button', { name: /^Agents/ }).click();
  await page.getByRole('button', { name: 'Add agent', exact: true }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Atlas');
  await page
    .getByLabel('Role and instructions')
    .fill('Investigate release risks and cite evidence.');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your agent credential' })).toBeVisible();
  const originalKey = await page.locator('.credential').textContent();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('heading', { name: 'Atlas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rotate credential', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your agent credential' })).toBeVisible();
  await expect(page.locator('.credential')).not.toHaveText(originalKey!);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('button', { name: 'Resume agent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.screenshot({
    path: test.info().outputPath('agent-orchestration-workspace.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = page.getByRole('complementary', { name: 'Workspace navigation' });
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(navigation).toBeHidden();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('orbit-navigation-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await navigation.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(navigation).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await navigation.getByRole('button', { name: 'Conversations', exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Message #engineering' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('orbit-conversation-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});
