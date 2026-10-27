import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
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
test('creates a project, milestone and label, organizes tasks and filters each task view', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'New project', exact: true });
  await dialog.getByLabel('Project name', { exact: true }).fill('Browser launch');
  await dialog
    .getByLabel('Project description', { exact: true })
    .fill('Coordinate a complete launch.');
  await dialog.getByLabel('Project status', { exact: true }).selectOption('active');
  await dialog.getByLabel('Project target date', { exact: true }).fill('2030-01-31');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  const project = page.getByRole('region', { name: 'Project details', exact: true });
  await expect(project.getByRole('heading', { name: 'Browser launch', exact: true })).toBeVisible();
  await project.getByRole('button', { name: 'New milestone', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'New milestone', exact: true });
  await dialog.getByLabel('Milestone title', { exact: true }).fill('Public launch');
  await dialog.getByLabel('Milestone due date', { exact: true }).fill('2030-01-15');
  await dialog.getByRole('button', { name: 'Create milestone', exact: true }).click();
  await expect(project.getByRole('heading', { name: 'Public launch', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  await page.getByRole('button', { name: 'New label', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'New label', exact: true });
  await dialog.getByLabel('Label name', { exact: true }).fill('Launch critical');
  await dialog.getByLabel('Label color', { exact: true }).selectOption('rose');
  await dialog.getByRole('button', { name: 'Create label', exact: true }).click();
  await expect(page.locator('.label-catalog-row')).toContainText('Launch critical');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Create a task', exact: true });
  await dialog.getByLabel('Task title', { exact: true }).fill('Ship launch checklist');
  await dialog.getByLabel('Task due date', { exact: true }).fill('2030-01-15');
  await dialog.getByRole('button', { name: 'Choose project', exact: true }).click();
  await dialog.getByRole('button', { name: /Browser launch/ }).click();
  await dialog
    .getByLabel('Task milestone', { exact: true })
    .selectOption({ label: 'Public launch · planned' });
  await dialog.getByRole('button', { name: 'Choose labels', exact: true }).click();
  await dialog.getByLabel('Label Launch critical', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const tasks = (await f.call(f.owner, 'GET', '/v1/tasks/list?q=Ship%20launch%20checklist')).json()
    .items;
  expect(tasks).toHaveLength(1);
  const task = tasks[0];
  expect(task).toMatchObject({
    project_name: 'Browser launch',
    milestone_title: 'Public launch',
    labels: [{ name: 'Launch critical' }],
  });
  await expect(
    page.getByRole('button', { name: 'Ship launch checklist', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Filter by project', exact: true }).click();
  await page.getByRole('button', { name: /Browser launch/ }).click();
  await page
    .getByLabel('Task milestone', { exact: true })
    .selectOption({ label: 'Public launch · planned' });
  await page.getByRole('button', { name: 'Filter by label', exact: true }).click();
  await page.getByRole('button', { name: 'Filter label Launch critical', exact: true }).click();
  await page.getByRole('button', { name: 'Apply task filters', exact: true }).click();
  await expect(page.locator('.task-organization-badges').first()).toContainText('Launch critical');
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  const card = page.locator(`[data-task-card-id="${task.id}"]`);
  await expect(card).toContainText('Browser launch / Public launch');
  await expect(card).toContainText('Launch critical');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByLabel('Calendar month', { exact: true }).fill('2030-01');
  await page.getByRole('button', { name: 'Filter by project', exact: true }).click();
  await page.getByRole('button', { name: /Browser launch/ }).click();
  await page.getByRole('button', { name: 'Ship launch checklist', exact: false }).click();
  await expect(
    page.getByRole('heading', { name: 'Ship launch checklist', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.task-organization')).toContainText('Browser launch / Public launch');
  await page.getByRole('button', { name: 'Edit task organization', exact: true }).click();
  await page.getByRole('button', { name: 'Remove label Launch critical', exact: true }).click();
  await page.getByRole('button', { name: 'Save task organization', exact: true }).click();
  await expect(page.locator('.task-organization .work-label')).toHaveCount(0);
  await page.getByRole('button', { name: '← All tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();

  await project.getByRole('button', { name: 'Edit project', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit project', exact: true });
  await dialog.getByLabel('Project description', { exact: true }).fill('Keep my conflicting draft');
  let projectRaced = false;
  await page.route(`**/api/v1/projects/${task.project_id}`, async (route) => {
    if (route.request().method() === 'PATCH' && !projectRaced) {
      projectRaced = true;
      await f.call(f.owner, 'PATCH', `/v1/projects/${task.project_id}`, {
        version: 1,
        description: 'Concurrent project update',
      });
    }
    await route.fallback();
  });
  await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed');
  await expect(dialog.getByRole('button', { name: 'Save project', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Project description', { exact: true })).toHaveValue(
    'Keep my conflicting draft',
  );
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await project.getByRole('button', { name: 'Edit milestone Public launch', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit milestone', exact: true });
  await dialog.getByLabel('Milestone status', { exact: true }).selectOption('completed');
  await dialog.getByRole('button', { name: 'Save milestone', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Close all milestone tasks');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
});
test('keeps stale task organization drafts and hides private projects when membership is removed', async ({
  page,
  context,
}) => {
  const group = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
    title: 'Private delivery',
    membershipIds: [f.mateBoot.me.id],
  });
  const conversationId = group.json().id;
  const created = await f.call(f.owner, 'POST', '/v1/projects', {
    name: 'Restricted program',
    conversationId,
    clientId: randomUUID(),
    ownerId: f.mateBoot.me.id,
  });
  expect(created.statusCode, created.body).toBe(201);
  const projectId = created.json().id;
  const id = await f.createTask('Versioned organization', {
    conversationId,
    projectId,
    assigneeId: f.mateBoot.me.id,
  });
  await f.connect(context, f.mate);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Versioned organization', exact: true }).click();
  await page.getByRole('button', { name: 'Edit task organization', exact: true }).click();
  let raced = false;
  await page.route(`**/api/v1/tasks/${id}`, async (route) => {
    if (route.request().method() === 'PATCH' && !raced) {
      raced = true;
      await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, {
        version: 1,
        title: 'Concurrent organization change',
      });
    }
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Save task organization', exact: true }).click();
  await expect(page.locator('.task-organization').getByRole('alert')).toContainText('changed');
  await expect(
    page.getByRole('button', { name: 'Save task organization', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel organization edit', exact: true }).click();
  await page.getByRole('button', { name: '← All tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Restricted program', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Restricted program', exact: true }),
  ).toBeVisible();
  await f.call(f.owner, 'PATCH', `/v1/conversations/${conversationId}`, {
    version: 1,
    member: { membershipId: f.mateBoot.me.id, action: 'remove' },
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Restricted program', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Edit project', exact: true })).toHaveCount(0);
});
test('reviews bulk placement and preserves archived labels on assigned tasks', async ({
  page,
  context,
}) => {
  const p = await f.call(f.owner, 'POST', '/v1/projects', {
    clientId: randomUUID(),
    name: 'Bulk launch program',
  });
  const projectId = p.json().id;
  const l = await f.call(f.owner, 'POST', '/v1/labels', {
    clientId: randomUUID(),
    name: 'Bulk launch label',
    color: 'blue',
  });
  const labelId = l.json().id;
  const a = await f.createTask('Organize Alpha'),
    b = await f.createTask('Organize Beta');
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByLabel('Select Organize Alpha', { exact: true }).check();
  await page.getByLabel('Select Organize Beta', { exact: true }).check();
  await page.getByRole('button', { name: 'Review bulk action', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Review bulk task action', exact: true });
  await dialog.getByLabel('Bulk action', { exact: true }).selectOption('organization');
  await dialog.getByRole('button', { name: 'Choose project', exact: true }).click();
  await dialog.getByRole('button', { name: /Bulk launch program/ }).click();
  await dialog.getByRole('button', { name: 'Choose labels', exact: true }).click();
  await dialog.getByLabel('Label Bulk launch label', { exact: true }).check();
  await dialog.getByLabel('I reviewed the selected tasks and changes', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Apply to 2 tasks', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  for (const id of [a, b])
    expect((await f.call(f.owner, 'GET', `/v1/tasks/${id}`)).json().task).toMatchObject({
      project_id: projectId,
      labels: [{ id: labelId }],
      version: 2,
    });
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  await page.getByRole('button', { name: 'Edit label Bulk launch label', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit label', exact: true });
  await dialog.getByLabel('Archive label', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save label', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('Label archive filter', { exact: true }).selectOption('true');
  await expect(page.locator('.label-catalog-row')).toContainText('Bulk launch label');
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  await expect(page.locator(`[data-task-card-id="${a}"]`)).toContainText(
    'Bulk launch label · Archived',
  );
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Bulk launch program', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Project details', exact: true })).toContainText(
    '0/2 completed',
  );
  await page.screenshot({ path: test.info().outputPath('orbit-projects.png'), fullPage: true });
});
