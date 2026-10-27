import { test, expect, type Page } from '@playwright/test';
import { taskBrowserFixture } from './task-browser-fixture.js';
import { RetrievalWorker } from '../../apps/api/src/retrieval/worker.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async () => {
  f = await taskBrowserFixture(undefined, {
    connectors: {
      async read() {
        return {
          title: 'Imported engineering issue',
          body: 'ConnectorBrowserEvidence is approved.',
        };
      },
    },
  });
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
  await f?.close();
});
async function search(page: Page, query: string) {
  await page.getByLabel('Search messages', { exact: true }).fill(query);
  await page.getByLabel('Search messages', { exact: true }).press('Enter');
  await page.getByLabel('Evidence query', { exact: true }).fill(query);
  await page.getByRole('button', { name: 'Find evidence', exact: true }).click();
}
test('retrieves cited task evidence, inspects its source and retains inspectable private memory', async ({
  page,
  context,
}) => {
  await f.call(f.owner, 'POST', '/v1/agents', {
    name: 'Evidence agent',
    role: 'Use cited evidence carefully.',
  });
  await f.createTask('Browser task evidence', {
    description: 'TaskBrowserEvidence confirms the rollout.',
  });
  await new RetrievalWorker(f.db).tick();
  await f.connect(context);
  await page.goto('/app');
  await search(page, 'TaskBrowserEvidence');
  await expect(page.getByText(/TaskBrowserEvidence confirms the rollout\./).first()).toBeVisible();
  await page.getByRole('button', { name: 'Inspect evidence', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Source evidence' })).toContainText(
    'TaskBrowserEvidence',
  );
  await page.getByRole('button', { name: 'Close evidence' }).click();
  await page.getByRole('button', { name: 'Retain as agent memory' }).click();
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Retain cited memory' }) });
  await form.getByLabel('Title', { exact: true }).fill('Retained browser evidence');
  await form.getByRole('button', { name: 'Save memory', exact: true }).click();
  await expect
    .poll(async () =>
      Number((await f.db.query('SELECT count(*) count FROM agent_memories'))[0]!.count),
    )
    .toBe(1);
  await page.getByRole('button', { name: /^Agents/ }).click();
  await page.getByText('Inspectable agent memory', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Retained browser evidence' })).toBeVisible();
  await page.getByRole('button', { name: 'Correct', exact: true }).click();
  const correction = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Correct memory' }) });
  await correction.getByLabel('Memory', { exact: true }).fill('Corrected browser evidence.');
  await correction.getByLabel('Reason', { exact: true }).fill('Confirmed source interpretation.');
  await correction.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Corrected browser evidence.', { exact: true })).toBeVisible();
  const deletion = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' && response.url().includes('/api/v1/memory/'),
  );
  await page.getByRole('button', { name: 'Delete memory and history' }).click();
  expect((await deletion).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Retained browser evidence' })).toHaveCount(0);
  expect(Number((await f.db.query('SELECT count(*) count FROM agent_memories'))[0]!.count)).toBe(0);
});
test('creates an owned connection through settings and imports searchable attributed content', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  await page.getByText('Connections and connector catalog', { exact: true }).click();
  const panel = page
    .locator('details')
    .filter({ has: page.getByText('Connections and connector catalog', { exact: true }) });
  await panel.getByLabel('Connector provider').selectOption('github');
  await panel.getByLabel('Name', { exact: true }).fill('Browser GitHub');
  await panel.getByLabel('Provider access token', { exact: true }).fill('synthetic-provider-token');
  await panel.getByRole('button', { name: 'Add connection', exact: true }).click();
  await panel.getByRole('button', { name: 'Manage connection', exact: true }).click();
  await panel.getByLabel('Resource ID', { exact: true }).fill('acme/orbit/7');
  await panel.getByRole('button', { name: 'Import resource', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Resource imported and queued for indexing.');
  await new RetrievalWorker(f.db).tick();
  await search(page, 'ConnectorBrowserEvidence');
  await expect(
    page.getByRole('heading', { name: 'Imported engineering issue', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Inspect evidence', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Source evidence' })).toContainText(
    'ConnectorBrowserEvidence',
  );
});
