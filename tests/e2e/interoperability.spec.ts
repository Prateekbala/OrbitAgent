import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { taskBrowserFixture } from './task-browser-fixture.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async () => {
  f = await taskBrowserFixture();
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
  await f.close();
});
test('reviews a Slack dry run, imports an attributed message and pauses the migration', async ({
  page,
  context,
}) => {
  const channel = await f.channel('private');
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Migrations', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser Slack import');
  await page.getByLabel('Source workspace ID', { exact: true }).fill('browser-' + randomUUID());
  await page.getByRole('button', { name: 'Create paused migration' }).click();
  await expect(page.getByRole('heading', { name: 'Browser Slack import' })).toBeVisible();
  await page.getByLabel('Source channel ID', { exact: true }).fill('C_BROWSER');
  await page.getByLabel('Target channel', { exact: true }).selectOption(channel);
  await page
    .getByText(
      'I am authorized to import this source and have reviewed the target audience, including any expansion.',
    )
    .locator('input')
    .check();
  await page.getByRole('button', { name: 'Save channel mapping' }).click();
  await expect(page.getByText('C_BROWSER →', { exact: false })).toBeVisible();
  await page.getByLabel('Import JSON page').setInputFiles({
    name: 'slack.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify([
        { ts: '1710000000.000001', user: 'U_BROWSER', text: 'Browser imported history' },
      ]),
    ),
  });
  await expect(page.getByText('1 pending', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run preflight' }).click();
  await expect(page.getByRole('heading', { name: 'Dry-run permission preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Start / resume' }).click();
  await page.getByRole('button', { name: 'Process next batch' }).click();
  await expect(page.getByText('1 applied', { exact: true })).toBeVisible();
  await expect(page.getByText(/All staged records resolved/)).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText(/^paused ·/)).toBeVisible();
});
test('accepts explicit shared-channel terms, posts with external attribution, and observes host revocation', async ({
  page,
  context,
}) => {
  const channel = await f.channel('private'),
    [org] = await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
      f.otherBoot.workspace.id,
    ]);
  const invite = await f.call(f.owner, 'POST', '/v1/shared-channels/invitations', {
    conversationId: channel,
    organizationId: org!.organization_id,
    policy: {
      history: 'join_time',
      retentionDays: 365,
      export: false,
      agents: false,
      recording: false,
    },
  });
  expect(invite.statusCode, invite.body).toBe(201);
  await f.connect(context, f.other);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Shared channels', exact: true }).click();
  await page.getByLabel('Invitation token', { exact: true }).fill(invite.json().token);
  await page.getByRole('button', { name: 'Review proposed agreement' }).click();
  await expect(page.getByRole('heading', { name: new RegExp('Owner Studio') })).toBeVisible();
  await page.getByRole('button', { name: 'Accept agreement and grant participation' }).click();
  await page.getByLabel('Message shared channel').fill('Browser external reply');
  await page.getByRole('button', { name: 'Send to shared channel' }).click();
  await expect(page.locator('.shared-message-list')).toContainText('Browser external reply');
  expect((await f.messages(f.owner, channel))[0]!.external_organization?.organizationId).toBe(
    org!.organization_id,
  );
  const revoked = await f.call(
    f.owner,
    'POST',
    '/v1/shared-channels/' + invite.json().id + '/revoke',
    { version: 2 },
  );
  expect(revoked.statusCode, revoked.body).toBe(200);
  await expect(page.locator('.platform-view [role=alert]')).toContainText('unavailable', {
    timeout: 15000,
  });
  await expect(page.locator('.shared-message-list')).not.toContainText('Browser external reply');
});
