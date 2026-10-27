import { test, expect, type Page } from '@playwright/test';
import { browserOrigin } from './api-proxy.js';
import { taskBrowserFixture } from './task-browser-fixture.js';
import { RetrievalWorker } from '../../apps/api/src/retrieval/worker.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async () => {
  f = await taskBrowserFixture(undefined, {
    answers: {
      model: 'fixture/browser-answer',
      synthesize: async ({ evidence }) => ({
        claims: [
          {
            text: 'The rollout has verified evidence.',
            supports: [
              { citation: evidence[0]!.citation, quote: evidence[0]!.excerpt.slice(0, 200) },
            ],
          },
        ],
        missingEvidence: false,
        conflictingEvidence: false,
      }),
    },
    connectorOAuth: {
      github: {
        authorization: (state) =>
          `${browserOrigin}/api/v1/connections/oauth/github/callback?` +
          new URLSearchParams({ state, code: 'fixture-code' }),
        exchange: async () => ({
          accessToken: 'private-fixture-oauth',
          expiresAt: Date.now() + 3600000,
        }),
        refresh: async () => ({
          accessToken: 'private-fixture-refresh',
          expiresAt: Date.now() + 3600000,
        }),
      },
    },
  });
});
test('shows an explicitly selected model-written answer with inspectable supporting sources', async ({
  page,
  context,
}) => {
  await f.createTask('Synthesis browser task', {
    description: 'SynthesisBrowserEvidence confirms the verified rollout.',
  });
  await new RetrievalWorker(f.db).tick();
  await f.connect(context);
  await page.goto('/app');
  await page.getByLabel('Search messages', { exact: true }).fill('SynthesisBrowserEvidence');
  await page.getByLabel('Search messages', { exact: true }).press('Enter');
  await page.getByLabel('Evidence query', { exact: true }).fill('SynthesisBrowserEvidence');
  await page
    .getByLabel('Model-written answer (requires operator configuration)', { exact: true })
    .check();
  await page.getByRole('button', { name: 'Find evidence', exact: true }).click();
  await expect(page.locator('.retrieval-answer')).toContainText(
    'The rollout has verified evidence. [1]',
  );
  await expect(page.getByText(/Supporting quotations are checked/)).toBeVisible();
  await page.getByRole('button', { name: 'Inspect evidence', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Source evidence' })).toContainText(
    'SynthesisBrowserEvidence',
  );
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await f?.close();
});
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  await page.getByText('Connections and connector catalog', { exact: true }).click();
  return page
    .locator('details')
    .filter({ has: page.getByText('Connections and connector catalog', { exact: true }) });
}
async function memories(page: Page) {
  await page.getByRole('button', { name: /^Agents/ }).click();
  await page.getByText('Inspectable agent memory', { exact: true }).click();
  return page.getByRole('region', { name: 'Source-owner consent inbox' });
}
test('chooses OAuth write consent and reconnects the same connection with read-only access', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  let panel = await settings(page);
  await panel.getByLabel('OAuth access', { exact: true }).selectOption('write');
  await panel.getByLabel('OAuth connection audience').selectOption('workspace');
  await panel.getByRole('button', { name: 'Connect GitHub with OAuth', exact: true }).click();
  await expect
    .poll(async () =>
      Number((await f.db.query('SELECT count(*) count FROM connections'))[0]!.count),
    )
    .toBe(1);
  await expect(
    page.getByRole('button', { name: 'Settings & activity', exact: true }),
  ).toBeVisible();
  panel = await settings(page);
  await expect(panel.getByText(/approved writes enabled/)).toBeVisible();
  await panel.getByRole('button', { name: 'Manage connection', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Native write operations' })).toBeVisible();
  await panel
    .getByRole('button', { name: 'Reconnect GitHub with OAuth (read)', exact: true })
    .click();
  await expect
    .poll(async () => Number((await f.db.query('SELECT version FROM connections'))[0]!.version))
    .toBe(2);
  const rows = await f.db.query('SELECT write_enabled FROM connections');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.write_enabled).toBe(false);
});
test('configures a native webhook with a one-time secret and revokes delivery', async ({
  page,
  context,
}) => {
  const created = await f.call(f.owner, 'POST', '/v1/connections', {
    provider: 'github',
    name: 'Browser native webhook',
    audience: 'workspace',
    credential: 'private-manual-token',
    allowWrites: true,
  });
  expect(created.statusCode).toBe(201);
  await f.connect(context);
  await page.goto('/app');
  const panel = await settings(page);
  await panel.getByRole('button', { name: 'Manage connection', exact: true }).click();
  const native = panel.getByRole('region', { name: 'Native webhook settings' });
  await native.getByRole('button', { name: 'Configure native webhook', exact: true }).click();
  await expect(native.getByRole('status')).toContainText('shown only here');
  await expect(native.getByText(/Provider callback path/)).toBeVisible();
  await native.getByRole('button', { name: 'Dismiss signing secret', exact: true }).click();
  await expect(native.getByRole('status')).toHaveCount(0);
  await native.getByRole('button', { name: 'Disable native webhook', exact: true }).click();
  await expect(native.getByText(/Disabled · version/)).toBeVisible();
  const [hook] = await f.db.query(
    'SELECT enabled,encrypted_secret FROM connection_native_hooks WHERE connection_id=$1',
    [created.json().id],
  );
  expect(hook!.enabled).toBe(false);
  expect(hook!.encrypted_secret).toBe('');
});
test('collects independent source-owner consent, publishes a private derived memory and withdraws access', async ({
  page,
  context,
  browser,
}) => {
  const agent = (
    await f.call(f.owner, 'POST', '/v1/agents', {
      name: 'Mixed evidence steward',
      role: 'Retain cited evidence.',
    })
  ).json().id;
  const channel = f.ownerBoot.channels[0]!.id;
  const one = (await f.send(f.owner, channel, 'First owner evidence')).json().id,
    two = (await f.send(f.mate, channel, 'Second owner evidence')).json().id;
  const saved = await f.call(f.owner, 'POST', '/v1/memory', {
    agentId: agent,
    boundary: 'private',
    title: 'Mixed owner browser memory',
    body: 'This memory needs both owners.',
    sources: [
      { kind: 'message', id: one, version: 1 },
      { kind: 'message', id: two, version: 1 },
    ],
    expiresAt: new Date(Date.now() + 86400000 * 7).toISOString(),
  });
  expect(saved.statusCode, saved.body).toBe(201);
  await f.connect(context);
  await page.goto('/app');
  await memories(page);
  await page.getByRole('button', { name: 'Share with source-owner consent', exact: true }).click();
  const form = page.locator('form').filter({
    has: page.getByRole('heading', { name: 'Request source-owner consent', exact: true }),
  });
  await form.getByLabel('Publication audience', { exact: true }).selectOption(channel);
  await form.getByLabel('Reason', { exact: true }).fill('Publish our reviewed browser evidence.');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Request owner approvals', exact: true }).click();
  let inbox = page.getByRole('region', { name: 'Source-owner consent inbox' });
  await inbox
    .getByRole('button', { name: 'Publish our reviewed browser evidence.', exact: true })
    .click();
  await inbox.getByRole('checkbox').check();
  await inbox.getByRole('button', { name: 'Record source consent', exact: true }).click();
  await expect(
    inbox.getByRole('button', { name: 'Publish approved memory', exact: true }),
  ).toBeDisabled();
  const second = await browser.newContext();
  try {
    await f.connect(second, f.mate);
    const reviewer = await second.newPage();
    await reviewer.goto('/app');
    const reviewInbox = await memories(reviewer);
    await reviewInbox
      .getByRole('button', { name: 'Publish our reviewed browser evidence.', exact: true })
      .click();
    await expect(
      reviewer.getByRole('heading', { name: 'Mixed owner browser memory', exact: true }),
    ).toHaveCount(0);
    await reviewInbox
      .getByRole('button', { name: 'Inspect my message source, version 1', exact: true })
      .click();
    await expect(reviewInbox.getByRole('region', { name: 'Source evidence' })).toContainText(
      'Second owner evidence',
    );
    await reviewInbox.getByRole('checkbox').check();
    await reviewInbox.getByRole('button', { name: 'Record source consent', exact: true }).click();
    inbox = page.getByRole('region', { name: 'Source-owner consent inbox' });
    await expect(
      inbox.getByRole('button', { name: 'Publish approved memory', exact: true }),
    ).toBeEnabled();
    await inbox.getByRole('button', { name: 'Publish approved memory', exact: true }).click();
    await expect(
      reviewer.getByRole('heading', { name: 'Mixed owner browser memory', exact: true }),
    ).toBeVisible();
    await reviewInbox
      .getByRole('button', { name: 'Withdraw my source consent', exact: true })
      .click();
    await expect(
      reviewer.getByRole('heading', { name: 'Mixed owner browser memory', exact: true }),
    ).toHaveCount(0);
  } finally {
    await Promise.all(second.pages().map((p) => p.goto('about:blank')));
    await second.unrouteAll({ behavior: 'ignoreErrors' });
    await second.close();
  }
});
