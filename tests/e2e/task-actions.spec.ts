import { test, expect } from '@playwright/test';
import { taskBrowserFixture } from './task-browser-fixture.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeAll(async () => {
  f = await taskBrowserFixture();
});
test.afterAll(async () => {
  await f?.close();
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
});
test('reviews atomic bulk edits, preserves stale selections, and retries an uncertain committed request', async ({
  page,
  context,
}) => {
  const a = await f.createTask('Bulk browser Alpha'),
    b = await f.createTask('Bulk browser Beta');
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByLabel('Select Bulk browser Alpha', { exact: true }).check();
  await page.getByLabel('Select Bulk browser Beta', { exact: true }).check();
  await page.getByRole('button', { name: 'Review bulk action', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review bulk task action' });
  await dialog.getByLabel('Bulk priority', { exact: true }).selectOption('high');
  await dialog.getByLabel('I reviewed the selected tasks and changes', { exact: true }).check();
  expect(
    (
      await f.call(f.owner, 'PATCH', `/v1/tasks/${b}`, {
        version: 1,
        title: 'Bulk browser Beta updated',
      })
    ).statusCode,
  ).toBe(200);
  await dialog.getByRole('button', { name: 'Apply to 2 tasks', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed');
  expect((await f.call(f.owner, 'GET', `/v1/tasks/${a}`)).json().task.priority).toBe('normal');
  await dialog.getByRole('button', { name: 'Review current task versions', exact: true }).click();
  await expect(dialog.locator('.bulk-task-review')).toContainText('Bulk browser Beta updated');
  await dialog.getByLabel('I reviewed the selected tasks and changes', { exact: true }).check();
  let intercepted = false;
  await page.route('**/api/v1/tasks/bulk', async (route) => {
    if (!intercepted && route.request().method() === 'POST') {
      intercepted = true;
      const response = await f.call(
        f.owner,
        'POST',
        '/v1/tasks/bulk',
        route.request().postDataJSON(),
      );
      expect(response.statusCode, response.body).toBe(200);
      await route.abort('failed');
    } else await route.fallback();
  });
  await dialog.getByRole('button', { name: 'Apply to 2 tasks', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('I reviewed the selected tasks and changes', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Apply to 2 tasks', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Selected task actions' })).toHaveCount(0);
  expect((await f.call(f.owner, 'GET', `/v1/tasks/${a}`)).json().task).toMatchObject({
    priority: 'high',
    version: 2,
  });
  expect((await f.call(f.owner, 'GET', `/v1/tasks/${b}`)).json().task).toMatchObject({
    priority: 'high',
    version: 3,
  });
});
test('moves Kanban cards by drag and keyboard control and requires completion evidence', async ({
  page,
  context,
}) => {
  const id = await f.createTask('Kanban shipment', {
    description: 'Verify the release before completing',
    assigneeId: f.ownerBoot.me.id,
    dueDate: '2034-05-10',
  });
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  const card = page.locator(`[data-task-card-id="${id}"]`),
    queued = page.getByRole('region', { name: 'Queued column', exact: true });
  await expect(card).toBeVisible();
  await card.dragTo(queued);
  await expect(queued.locator(`[data-task-card-id="${id}"]`)).toBeVisible();
  await card.getByLabel('Move Kanban shipment', { exact: true }).selectOption('active');
  await expect(
    page
      .getByRole('region', { name: 'In progress column', exact: true })
      .locator(`[data-task-card-id="${id}"]`),
  ).toBeVisible();
  await card.getByLabel('Move Kanban shipment', { exact: true }).selectOption('awaiting_review');
  await expect(
    page
      .getByRole('region', { name: 'In review column', exact: true })
      .locator(`[data-task-card-id="${id}"]`),
  ).toBeVisible();
  await card.getByLabel('Move Kanban shipment', { exact: true }).selectOption('completed');
  const dialog = page.getByRole('dialog', { name: 'Verify task completion' });
  await expect(dialog.getByRole('button', { name: 'Complete task', exact: true })).toBeDisabled();
  await dialog
    .getByLabel('Verification evidence', { exact: true })
    .fill('Release checks and deployment verified');
  await dialog.getByRole('button', { name: 'Complete task', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Completed column', exact: true })
      .locator(`[data-task-card-id="${id}"]`),
  ).toBeVisible();
  await card.getByRole('button', { name: 'Kanban shipment', exact: true }).click();
  await expect(page.locator('.task-detail-heading .state')).toHaveText('Completed');
  await page.getByRole('button', { name: 'Load state history', exact: true }).click();
  await expect(page.locator('.task-history-entry').first()).toContainText(
    'Release checks and deployment verified',
  );
  await page.getByRole('button', { name: '← All tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
test('paginates Kanban columns, filters their cards, and enforces prerequisite gates', async ({
  page,
  context,
}) => {
  for (let n = 0; n < 24; n++)
    await f.createTask(`Board backlog ${n}`, { assigneeId: f.mateBoot.me.id });
  const dependency = await f.createTask('Board prerequisite'),
    blocked = await f.createTask('Board dependent');
  await f.call(f.owner, 'PUT', `/v1/tasks/${blocked}/dependencies`, {
    version: 1,
    dependsOnId: dependency,
  });
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  await page.getByLabel('Find tasks', { exact: true }).fill('Board backlog');
  await page.getByRole('button', { name: 'Apply task filters', exact: true }).click();
  const proposed = page.getByRole('region', { name: 'Proposed column', exact: true });
  await expect(proposed.locator('.kanban-card')).toHaveCount(20);
  await proposed.getByRole('button', { name: 'Load more proposed', exact: true }).click();
  await expect(proposed.locator('.kanban-card')).toHaveCount(24);
  await page.getByLabel('Task assignee filter', { exact: true }).selectOption(f.ownerBoot.me.id);
  await page.getByRole('button', { name: 'Apply task filters', exact: true }).click();
  await expect(page.locator('.kanban-card')).toHaveCount(0);
  await page.getByLabel('Task assignee filter', { exact: true }).selectOption('');
  await page.getByLabel('Find tasks', { exact: true }).fill('Board dependent');
  await page.getByRole('button', { name: 'Apply task filters', exact: true }).click();
  const card = page.locator(`[data-task-card-id="${blocked}"]`);
  await card.getByLabel('Move Board dependent', { exact: true }).selectOption('queued');
  await expect(
    page
      .getByRole('region', { name: 'Queued column', exact: true })
      .locator(`[data-task-card-id="${blocked}"]`),
  ).toBeVisible();
  await card.getByLabel('Move Board dependent', { exact: true }).selectOption('active');
  await expect(page.locator('.task-page').getByRole('alert')).toContainText('Finish prerequisites');
  expect((await f.call(f.owner, 'GET', `/v1/tasks/${blocked}`)).json().task.state).toBe('queued');
  await page.screenshot({ path: test.info().outputPath('orbit-kanban.png'), fullPage: true });
});
