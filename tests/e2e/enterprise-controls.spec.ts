import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { generateKeyPairSync } from 'node:crypto';
import { taskBrowserFixture } from './task-browser-fixture.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  f = await taskBrowserFixture(undefined, {
    byokPublicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await context.unrouteAll({ behavior: 'wait' });
});
test.afterAll(async () => f?.close());
test('manages a sealed model key without retaining the form secret', async ({ page, context }) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  await page.getByText('Model keys & organization deletion', { exact: true }).click();
  const panel = page.getByRole('region', {
    name: 'Model keys and organization deletion',
    exact: true,
  });
  await panel.getByLabel('Key label', { exact: true }).fill('Private model account');
  await panel.getByLabel('API key', { exact: true }).fill('sk-browser-synthetic-key-do-not-use');
  await panel.getByLabel('Allowed model IDs', { exact: true }).fill('openai/fixture-model');
  await panel
    .getByLabel('Key expiry', { exact: true })
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
  await panel.getByRole('button', { name: 'Save model key', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Model key saved');
  await expect(panel.getByLabel('API key', { exact: true })).toHaveValue('');
  await panel.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Model key revoked');
  expect(
    (
      await new AxeBuilder({ page })
        .include('[aria-label="Model keys and organization deletion"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
});
test('confirms organization deletion and shows independent progress outside the frozen workspace', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  await page.getByText('Model keys & organization deletion', { exact: true }).click();
  const panel = page.getByRole('region', {
    name: 'Model keys and organization deletion',
    exact: true,
  });
  await panel
    .getByLabel('Type organization name: Owner Studio', { exact: true })
    .fill('Owner Studio');
  await panel
    .getByLabel('Current password (or sign in with SSO within five minutes)', { exact: true })
    .fill('messaging-test-password');
  await panel
    .getByLabel('Deletion reason', { exact: true })
    .fill('Authorized organization closure with retained legal evidence.');
  await panel.getByRole('button', { name: 'Permanently freeze and delete organization' }).click();
  await expect(page).toHaveURL(/\/organizations\/[a-f0-9-]+\/erasure$/);
  await expect(page.getByText('Preparing deletion', { exact: true })).toBeVisible();
  await expect(page.getByText(/Database content: pending/)).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
