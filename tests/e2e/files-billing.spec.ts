import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { taskBrowserFixture } from './task-browser-fixture.js';
import { LocalFileStore } from '../../apps/api/src/files/storage.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>, directory: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbit-commercial-browser-'));
  f = await taskBrowserFixture({
    store: new LocalFileStore(join(directory, 'objects')),
    stagingDirectory: join(directory, 'staging'),
    scanner: { scan: async () => 'clean' },
  });
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await context.unrouteAll({ behavior: 'wait' });
});
test.afterAll(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});
test('saves billing controls, keeps payments disabled, and persists localized guide progress', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  const billing = page.getByRole('region', { name: 'Billing and usage' });
  await expect(billing.getByText('Self-hosted', { exact: true })).toBeVisible();
  await expect(billing.getByText(/Payments are awaiting provider setup/)).toBeVisible();
  await billing.getByLabel('Hard budget in USD microdollars').fill('100000000');
  await billing.getByRole('button', { name: 'Save spending controls' }).click();
  await expect(billing.getByRole('status')).toContainText('Spending controls saved');
  const guide = page.getByRole('region', { name: 'Getting started' });
  await guide.getByRole('button', { name: 'Make yourself at home' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Set up your profile').check();
  await expect(dialog.getByLabel('Set up your profile')).toBeChecked();
  await expect
    .poll(async () => {
      const r = await f.call(f.owner, 'GET', '/v1/account/onboarding');
      return r.json().steps;
    })
    .toContain('profile');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const violations = await new AxeBuilder({ page })
    .include('[aria-label="Billing and usage"]')
    .include('[aria-label="Getting started"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(violations.violations).toEqual([]);
});
test('publishes file versions, creates a recipient link, downloads and revokes it', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  const policy = page.getByRole('region', { name: 'File protection' });
  await policy.getByLabel('Allow recipient-restricted expiring links').check();
  await policy.getByRole('button', { name: 'Save file policy' }).click();
  await expect(policy.getByRole('status')).toContainText('Policy saved');
  const task = await f.createTask('Versioned evidence');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Versioned evidence', exact: true }).click();
  await page.getByLabel('Choose task files', { exact: true }).setInputFiles({
    name: 'evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('version one'),
  });
  await expect(page.getByText('Ready to attach', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Attach files to task', exact: true }).click();
  await page.getByRole('button', { name: 'File versions and sharing' }).click();
  const dialog = page.getByRole('dialog').last();
  await expect(dialog.getByText(/Current version 1/)).toBeVisible();
  await dialog.getByLabel('Publish a new version').setInputFiles({
    name: 'evidence-v2.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('version two'),
  });
  await dialog.getByRole('button', { name: 'Upload version', exact: true }).click();
  await expect(dialog.getByText(/Current version 2/)).toBeVisible();
  await dialog.getByLabel('Teammate', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Create expiring link' }).click();
  const link = await dialog.getByLabel('Copy this link; it is shown only once').inputValue();
  expect(link).toContain('#share=');
  const versions = await f.call(f.owner, 'GET', `/v1/tasks/${task}/attachments`);
  const file = versions.json().items[0].id;
  expect((await f.call(f.owner, 'GET', `/v1/files/${file}/content?version=1`)).body).toBe(
    'version one',
  );
  const violations = await new AxeBuilder({ page })
    .include('[data-slot="dialog-content"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(violations.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(dialog.getByText(/Revoked/)).toBeVisible();
});
test('resumes a large upload after a lost committed chunk response', async ({ page, context }) => {
  const task = await f.createTask('Resumable upload evidence');
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Resumable upload evidence', exact: true }).click();
  let lost = false;
  await page.route('**/api/v1/files/*/upload', async (route) => {
    if (route.request().method() !== 'PATCH' || lost) {
      await route.fallback();
      return;
    }
    lost = true;
    const address = f.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing isolated API address.');
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    const response = await route.fetch({ url: `http://127.0.0.1:${address.port}${path}` });
    expect(response.ok()).toBe(true);
    await route.abort('failed');
  });
  await page.getByLabel('Choose task files', { exact: true }).setInputFiles({
    name: 'large-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(1024 * 1024 + 17, 65),
  });
  await page.getByRole('button', { name: 'Retry task upload' }).click();
  await expect(page.getByText('Ready to attach', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Attach files to task', exact: true }).click();
  await expect(
    page.locator('.task-attachments').getByRole('link', { name: /large-notes.txt/ }),
  ).toBeVisible();
  expect(await f.db.query('SELECT id FROM files WHERE task_id=$1', [task])).toHaveLength(1);
});
