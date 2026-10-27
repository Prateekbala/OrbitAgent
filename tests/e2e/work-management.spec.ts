import { browserOrigin } from './api-proxy.js';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { taskBrowserFixture } from './task-browser-fixture.js';
import { WorkflowWorker } from '../../apps/api/src/workflows/worker.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async () => {
  f = await taskBrowserFixture();
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
  await f?.close();
});
test('collaborates on tasks, records human acceptance and artifacts, and preserves an uncertain artifact request', async ({
  page,
  context,
}) => {
  const channel = f.ownerBoot.channels[0]!.id,
    id = await f.createTask('Verified browser delivery', { conversationId: channel }),
    message = (await f.send(f.owner, channel, 'Approved release discussion')).json().id;
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Verified browser delivery', exact: true }).click();
  await page.getByRole('button', { name: 'Open task collaboration', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Task collaboration and verification' });
  await panel.getByRole('button', { name: 'Watch task', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop following task' })).toBeVisible();
  await panel.getByLabel('Task participant', { exact: true }).selectOption(f.mateBoot.me.id);
  await panel.getByLabel('Participation', { exact: true }).selectOption('collaborator');
  await panel.getByRole('button', { name: 'Add task participant', exact: true }).click();
  await expect(panel).toContainText('Teammate · collaborator');
  await panel
    .getByLabel('New acceptance criterion', { exact: true })
    .fill('The release is independently verified');
  await panel.getByRole('button', { name: 'Add acceptance criterion', exact: true }).click();
  await expect(panel).toContainText('Not verified · The release is independently verified');
  await panel
    .getByLabel('Evidence for The release is independently verified', { exact: true })
    .fill('Integration tests and release review passed');
  await panel.getByRole('button', { name: 'Record verification', exact: true }).click();
  await expect(panel).toContainText('Verified · The release is independently verified');
  let lost = false;
  await page.route(`**/api/v1/tasks/${id}/artifacts`, async (route) => {
    if (!lost && route.request().method() === 'POST') {
      lost = true;
      const r = await f.call(
        f.owner,
        'POST',
        `/v1/tasks/${id}/artifacts`,
        route.request().postDataJSON(),
      );
      expect(r.statusCode, r.body).toBe(200);
      await route.abort('failed');
    } else await route.fallback();
  });
  await panel.getByLabel('Artifact title', { exact: true }).fill('Release evidence');
  await panel.getByLabel('Artifact type', { exact: true }).selectOption('test_result');
  await panel
    .getByLabel('Artifact details', { exact: true })
    .fill('All required validation passed');
  await panel.getByRole('button', { name: 'Add structured artifact', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await panel.getByRole('button', { name: 'Add structured artifact', exact: true }).click();
  await expect(
    panel.locator('article.work-card > strong').filter({ hasText: 'Release evidence' }),
  ).toHaveCount(1);
  expect((await f.call(f.owner, 'GET', `/v1/tasks/${id}/artifacts`)).json().items).toHaveLength(1);
  await panel
    .getByLabel('Source message permalink', { exact: true })
    .fill(`${browserOrigin}/?workspace=${f.ownerBoot.workspace.id}&message=${message}`);
  await panel.getByRole('button', { name: 'Link source message', exact: true }).click();
  await expect(
    panel.getByRole('link', { name: 'Open source discussion', exact: true }),
  ).toBeVisible();
  await panel.getByLabel('Estimated effort', { exact: true }).fill('8');
  await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, {
    version: (await f.call(f.owner, 'GET', '/v1/tasks/' + id)).json().task.version,
    priority: 'high',
  });
  await expect(panel).toContainText('Your plan draft is preserved');
  await expect(panel.getByLabel('Estimated effort', { exact: true })).toHaveValue('8');
  await panel
    .getByRole('button', { name: 'I reviewed the task; keep my plan draft', exact: true })
    .click();
  await panel.getByRole('button', { name: 'Save task plan', exact: true }).click();
  await expect
    .poll(async () => (await f.call(f.owner, 'GET', '/v1/tasks/' + id)).json().task.estimate)
    .toBe(8);
});
test('authors and publishes a versioned workflow, waits for a human decision and completes its recorded steps', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await page.getByRole('button', { name: 'New work template', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New work template' });
  await editor.getByLabel('Template name', { exact: true }).fill('Browser release workflow');
  await editor.getByLabel('New task title', { exact: true }).fill('Prepare browser release');
  await editor.getByRole('button', { name: 'Add workflow step', exact: true }).click();
  await editor.getByLabel('Step action', { exact: true }).nth(1).selectOption('approval');
  await editor
    .getByLabel('Approval instructions', { exact: true })
    .fill('Review release readiness');
  await editor.getByRole('button', { name: 'Create template', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const card = page
    .locator('.work-card')
    .filter({ has: page.getByRole('heading', { name: 'Browser release workflow', exact: true }) });
  await card.getByRole('button', { name: 'Publish latest revision', exact: true }).click();
  await expect(card).toContainText('Published revision 1');
  await card.getByRole('button', { name: 'Run published template', exact: true }).click();
  const detail = page.getByRole('region', { name: 'Workflow run details' });
  await expect(detail).toContainText('queued');
  const worker = new WorkflowWorker(f.db),
    now = new Date();
  await worker.tick(now);
  await worker.tick(new Date(now.getTime() + 6000));
  await expect(
    detail.getByRole('button', { name: 'Record workflow decision', exact: true }),
  ).toBeVisible();
  await detail
    .getByLabel('Decision evidence', { exact: true })
    .fill('Release preparation independently reviewed');
  await detail.getByRole('button', { name: 'Record workflow decision', exact: true }).click();
  await worker.tick(new Date(now.getTime() + 12000));
  await expect(detail).toContainText('succeeded');
  expect(
    await f.db.query(
      "SELECT id FROM tasks WHERE workspace_id=$1 AND title='Prepare browser release'",
      [f.ownerBoot.workspace.id],
    ),
  ).toHaveLength(1);
});
test('reports project effort and a dated timeline and rolls projects into a portfolio', async ({
  page,
  context,
}) => {
  const date = new Date().toISOString().slice(0, 10),
    due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
    project = (
      await f.call(f.owner, 'POST', '/v1/projects', {
        clientId: randomUUID(),
        name: 'Browser delivery portfolio project',
      })
    ).json().id,
    id = await f.createTask('Timeline delivery item', { projectId: project, dueDate: due });
  await f.call(f.owner, 'PUT', `/v1/tasks/${id}/plan`, {
    version: 1,
    startDate: date,
    estimate: 13,
  });
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page
    .getByRole('button', { name: 'Browser delivery portfolio project', exact: true })
    .click();
  const report = page.getByRole('region', { name: 'Project reporting and timeline' });
  await expect(
    report.getByRole('listitem').filter({ hasText: 'Timeline delivery item' }),
  ).toBeVisible();
  await expect(report).toContainText('0/13');
  await page.getByRole('button', { name: 'Portfolios', exact: true }).click();
  await page.getByRole('button', { name: 'New portfolio', exact: true }).click();
  await page.getByLabel('Portfolio name', { exact: true }).fill('Product delivery');
  await page
    .getByRole('checkbox', { name: 'Browser delivery portfolio project', exact: true })
    .check();
  await page.getByRole('button', { name: 'Save portfolio', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Portfolio report' })).toContainText(
    'Browser delivery portfolio project',
  );
  await expect(page.getByRole('region', { name: 'Portfolio report' })).toContainText('13');
});
test('configures a business calendar, retains a failed edit, and creates and revokes a private subscription', async ({
  page,
  context,
}) => {
  const id = await f.createTask('Calendar browser task', {
    assigneeId: f.ownerBoot.me.id,
    dueDate: new Date().toISOString().slice(0, 10),
  });
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Calendar settings', exact: true }).click();
  await page.getByRole('button', { name: 'New business calendar', exact: true }).click();
  await page.getByLabel('Business calendar name', { exact: true }).fill('Company working days');
  await page.getByLabel('Business calendar time zone', { exact: true }).fill('Invalid/Zone');
  await page.getByRole('button', { name: 'Save business calendar', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Calendar connections and business days' }).getByRole('alert'),
  ).toBeVisible();
  await expect(page.getByLabel('Business calendar name', { exact: true })).toHaveValue(
    'Company working days',
  );
  await page.getByLabel('Business calendar time zone', { exact: true }).fill('UTC');
  await page.getByRole('button', { name: 'Save business calendar', exact: true }).click();
  await expect(
    page.locator('.work-card').filter({ hasText: 'Company working days' }),
  ).toContainText('Mon, Tue, Wed, Thu, Fri');
  await page
    .getByRole('button', { name: 'Create private calendar subscription', exact: true })
    .click();
  const url = await page.getByRole('textbox', { name: /Private subscription URL/ }).inputValue(),
    feed = new URL(url),
    response = await f.app.inject({ method: 'GET', url: '/v1/calendar/feed' + feed.search });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.body).toContain(id);
  await page.getByRole('button', { name: 'Revoke calendar subscription', exact: true }).click();
  expect(
    (await f.app.inject({ method: 'GET', url: '/v1/calendar/feed' + feed.search })).statusCode,
  ).toBe(404);
});
