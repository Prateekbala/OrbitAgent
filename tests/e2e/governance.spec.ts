import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { taskBrowserFixture } from './task-browser-fixture.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeAll(async () => {
  f = await taskBrowserFixture();
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await context.unrouteAll({ behavior: 'wait' });
});
test.afterAll(async () => {
  await f?.close();
});
test('administers versioned policy, audit integrity and reasoned legal preservation', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  await page.getByText('Enterprise governance & operations', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Enterprise governance', exact: true });
  await expect(panel.getByLabel('Hosted agent execution')).toBeChecked();
  await panel.getByLabel('External connections', { exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Save governance policy' }).click();
  await expect(panel.getByRole('status')).toContainText('Governance policy saved');
  await panel.getByText('Security audit', { exact: true }).click();
  await panel.getByLabel('Search audit actions').fill('governance.policy');
  await panel.getByRole('button', { name: 'Search audit', exact: true }).click();
  await expect(panel.getByText('governance.policy_changed', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(panel.getByRole('status')).toContainText('Chain verified');
  await panel.getByText('Legal holds (0 active)', { exact: true }).click();
  await panel.getByLabel('Case reference', { exact: true }).fill('BROWSER-LEGAL');
  await panel
    .getByLabel('Preservation reason', { exact: true })
    .fill('Preserve workspace content for an ongoing investigation.');
  await panel.getByRole('button', { name: 'Create legal hold', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Legal hold created');
  await panel
    .getByLabel('Release reason for BROWSER-LEGAL')
    .fill('The investigation is complete and preservation has been released.');
  await panel.getByRole('button', { name: 'Release hold', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Hold released');
  const result = await new AxeBuilder({ page })
    .include('[aria-label="Enterprise governance"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
});
test('shows public incidents and does not assume operational health from an empty feed', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await f.db.query(
    "INSERT INTO public_incidents(id,title,status,description) VALUES($1,'Planned local maintenance','monitoring','A synthetic browser fixture; no real outage is being announced.')",
    [randomUUID()],
  );
  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'Planned local maintenance' })).toBeVisible();
  await expect(page.getByText('monitoring', { exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
