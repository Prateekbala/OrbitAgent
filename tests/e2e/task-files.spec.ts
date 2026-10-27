import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LocalFileStore } from '../../apps/api/src/files/storage.js';
import { taskBrowserFixture } from './task-browser-fixture.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>, directory: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbit-task-browser-files-'));
  f = await taskBrowserFixture({
    store: new LocalFileStore(join(directory, 'objects')),
    scanner: { scan: async () => 'clean' },
    stagingDirectory: join(directory, 'staging'),
  });
});
test.afterAll(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
});
test('shares task attachments live, previews images, downloads privately, removes files and revokes access', async ({
  page,
  context,
  browser,
}) => {
  const group = (
    await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Private delivery files',
      membershipIds: [f.mateBoot.me.id],
    })
  ).json<{ id: string }>().id;
  const id = await f.createTask('Private release evidence', {
    conversationId: group,
    assigneeId: f.ownerBoot.me.id,
  });
  const other = await browser.newContext();
  try {
    await f.connect(context);
    await f.connect(other, f.mate);
    const reader = await other.newPage();
    for (const p of [page, reader]) {
      await p.goto('/app');
      await p.getByRole('button', { name: 'Tasks', exact: true }).click();
      await p.getByRole('button', { name: 'Private release evidence', exact: true }).click();
    }
    const bytes = Buffer.from('Release evidence for this task.');
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#558855' },
    })
      .png()
      .toBuffer();
    await page.getByLabel('Choose task files', { exact: true }).setInputFiles([
      { name: 'release-evidence.txt', mimeType: 'text/plain', buffer: bytes },
      { name: 'release-preview.png', mimeType: 'image/png', buffer: png },
    ]);
    await expect(page.getByText('Ready to attach', { exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: 'Attach files to task', exact: true }).click();
    await expect(
      reader.locator('.task-attachments').getByRole('link', { name: /release-evidence.txt/ }),
    ).toBeVisible();
    await expect(
      reader.getByRole('img', { name: 'Preview of release-preview.png', exact: true }),
    ).toBeVisible();
    await expect(reader.getByLabel('Choose task files', { exact: true })).toHaveCount(0);
    const downloaded = reader.waitForEvent('download');
    await reader
      .locator('.task-attachments')
      .getByRole('link', { name: /release-evidence.txt/ })
      .click();
    const file = await downloaded;
    expect(await readFile((await file.path())!)).toEqual(bytes);
    await page
      .getByRole('button', { name: 'Remove attachment release-evidence.txt', exact: true })
      .click();
    await page.getByRole('button', { name: 'Confirm remove attachment', exact: true }).click();
    await expect(
      reader.locator('.task-attachments').getByRole('link', { name: /release-evidence.txt/ }),
    ).toHaveCount(0);
    const imageId = (await f.call(f.owner, 'GET', `/v1/tasks/${id}/attachments`)).json().items[0]
      .id;
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
          version: 1,
          member: { membershipId: f.mateBoot.me.id, action: 'remove' },
        })
      ).statusCode,
    ).toBe(200);
    await expect(reader.locator('.task-attachments')).toHaveCount(0);
    expect((await f.call(f.mate, 'GET', `/v1/files/${imageId}/content`)).statusCode).toBe(404);
    await page.screenshot({
      path: test.info().outputPath('orbit-task-attachments.png'),
      fullPage: true,
    });
  } finally {
    await other.unrouteAll({ behavior: 'wait' });
    await other.close();
  }
});
test('keeps failed upload drafts, retries uploads and recovers a lost attachment response without duplicating files', async ({
  page,
  context,
}) => {
  const id = await f.createTask('Retry task evidence');
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Retry task evidence', exact: true }).click();
  let fail = true;
  await page.route('**/api/v1/files/*/content', async (route) => {
    if (fail && route.request().method() === 'PUT') {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Temporary task upload failure' } }),
      });
    } else await route.fallback();
  });
  await page.getByLabel('Choose task files', { exact: true }).setInputFiles({
    name: 'retry-evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Retained task evidence'),
  });
  await expect(page.getByRole('button', { name: 'Retry task upload', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry task upload', exact: true }).click();
  await expect(page.getByText('Ready to attach', { exact: true })).toBeVisible();
  let committed = false;
  await page.route(`**/api/v1/tasks/${id}/attachments`, async (route) => {
    if (!committed && route.request().method() === 'POST') {
      committed = true;
      const r = await f.call(
        f.owner,
        'POST',
        `/v1/tasks/${id}/attachments`,
        route.request().postDataJSON(),
      );
      expect(r.statusCode, r.body).toBe(200);
      await route.abort('failed');
    } else await route.fallback();
  });
  await page.getByRole('button', { name: 'Attach files to task', exact: true }).click();
  await expect(page.locator('.task-file-composer').getByRole('alert')).toContainText(
    'draft has been kept',
  );
  await expect(page.getByText('Ready to attach', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Attach files to task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Attach files to task', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('.task-attachment')).toHaveCount(1);
  expect((await f.call(f.owner, 'GET', `/v1/tasks/${id}/attachments`)).json().items).toHaveLength(
    1,
  );
  await page.getByLabel('Choose task files', { exact: true }).setInputFiles({
    name: 'discard.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Discard this queued evidence'),
  });
  await expect(page.getByText('Ready to attach', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard upload discard.txt', exact: true }).click();
  await expect(page.locator('.task-file-composer .upload-list li')).toHaveCount(0);
});
