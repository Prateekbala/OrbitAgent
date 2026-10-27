import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { taskBrowserFixture } from './task-browser-fixture.js';
import type { HostedRuntime } from '../../apps/api/src/execution/types.js';
import type { AgentOutput } from '@ao/contracts';
import { ExecutionWorker } from '../../apps/api/src/execution/worker.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>,
  extra: BrowserContext[] = [];
let output: AgentOutput = { reply: 'A structured form is proposed.', proposals: [] };
const runtime: HostedRuntime = {
  configured: true,
  async createSession() {
    return randomUUID();
  },
  async generate() {
    return output;
  },
  async recover() {
    return null;
  },
  async cancel() {},
};
test.beforeEach(async () => {
  f = await taskBrowserFixture(undefined, { runtime });
});
test.afterEach(async ({ page, context }) => {
  for (const c of extra) await c.close();
  extra = [];
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
  await f?.close();
});
async function create(title: string, body = 'Original source content.') {
  const r = await f.call(f.owner, 'POST', '/v1/knowledge', { title, body });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function open(page: Page, title: string) {
  await page.goto('/app');
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(title) }).click();
}
test('merges two simultaneous browser editors and preserves attributed rich-text history', async ({
  page,
  context,
  browser,
}) => {
  const id = await create('Collaborative procedure');
  await f.connect(context);
  const other = await browser.newContext();
  extra.push(other);
  await f.connect(other, f.mate);
  const peer = await other.newPage();
  await Promise.all([open(page, 'Collaborative procedure'), open(peer, 'Collaborative procedure')]);
  await Promise.all([
    page.getByRole('button', { name: 'Edit together', exact: true }).click(),
    peer.getByRole('button', { name: 'Edit together', exact: true }).click(),
  ]);
  const a = page.getByLabel('Shared page content', { exact: true }),
    b = peer.getByLabel('Shared page content', { exact: true });
  await expect(a).toBeEnabled();
  await expect(b).toBeEnabled();
  await Promise.all([
    a.fill('**Owner evidence.** Original source content.'),
    b.fill('Peer evidence. Original source content.'),
  ]);
  await expect(a).toHaveValue(/Owner evidence/);
  await expect(a).toHaveValue(/Peer evidence/);
  await expect(b).toHaveValue(/Owner evidence/);
  await expect(b).toHaveValue(/Peer evidence/);
  await expect(
    page.getByRole('button', { name: 'Close shared editor', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Close shared editor', exact: true }).click();
  await expect(page.locator('.document-body strong')).toHaveText('Owner evidence.');
  const result = (await f.call(f.owner, 'GET', `/v1/knowledge/${id}`)).json();
  expect(result.body).toContain('Peer evidence.');
  expect(result.version).toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Version history' })).toContainText('Teammate');
});
test('reviews ownership, provenance and page comments through the knowledge UI', async ({
  page,
  context,
}) => {
  const source = await create('Reference decision'),
    id = await create('Governed procedure');
  await f.connect(context);
  await open(page, 'Governed procedure');
  await page.getByRole('button', { name: 'Ownership, sources and review', exact: true }).click();
  await page.getByLabel('Knowledge type', { exact: true }).selectOption('procedure');
  await page.getByRole('button', { name: 'Save page governance', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Governance saved.');
  await page.getByLabel('Link source page', { exact: true }).selectOption(source);
  await page.getByRole('button', { name: 'Add provenance source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source linked.');
  await page
    .getByLabel('Review evidence', { exact: true })
    .fill('Checked every step against the source decision.');
  await page.getByRole('button', { name: 'Record page review', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Review recorded.');
  await page
    .getByLabel('Comment', { exact: true })
    .fill('The verification steps are reproducible.');
  await page.getByRole('button', { name: 'Add page comment', exact: true }).click();
  await expect(
    page.getByText('The verification steps are reproducible.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Resolve comment', exact: true }).click();
  await expect(page.getByText('Resolved', { exact: true })).toBeVisible();
  const exported = await f.call(f.owner, 'GET', `/v1/knowledge/${id}/export`);
  expect(exported.statusCode, exported.body).toBe(200);
  expect(exported.json().sources[0].source_page_id).toBe(source);
});
test('configures tool approval rules and submits an isolated structured form', async ({
  page,
  context,
}) => {
  const created = await f.call(f.owner, 'POST', '/v1/agents', {
    name: 'Form reviewer',
    role: 'Propose a release evidence form.',
    runtime: 'managed',
  });
  const agentId = created.json().id,
    current = (await f.call(f.owner, 'GET', `/v1/agents/${agentId}`)).json();
  await f.call(f.owner, 'POST', `/v1/agents/${agentId}/revisions`, {
    version: current.version,
    configuration: { ...current.configuration, tools: ['interactive_form'] },
  });
  output = {
    reply: 'Review the proposed release evidence form.',
    proposals: [
      {
        tool: 'interactive_form',
        parameters: {
          title: 'Release evidence',
          description: 'Collect independently reviewed evidence.',
          fields: '[{"name":"evidence","label":"Evidence URL","type":"text","required":true}]',
        },
      },
    ],
  };
  const run = await f.call(f.owner, 'POST', '/v1/runs', {
    agentId,
    conversationId: f.ownerBoot.channels[0]!.id,
    prompt: 'Prepare the evidence form.',
    requestKey: randomUUID(),
  });
  expect(run.statusCode, run.body).toBe(201);
  const worker = new ExecutionWorker(f.db, runtime);
  await worker.tick();
  const [invocation] = await f.db.query('SELECT * FROM tool_invocations WHERE run_id=$1', [
    run.json().id,
  ]);
  expect(invocation).toBeDefined();
  await f.call(f.owner, 'POST', `/v1/approvals/${invocation!.id}/decisions`, {
    decision: 'approved',
    digest: invocation!.action_digest,
    reason: 'Reviewed the form fields.',
  });
  await worker.tick();
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Appearance', exact: true })
    .getByRole('radio', { name: 'Dark', exact: true })
    .click();
  await page.keyboard.press('Escape');
  const iframe = page.frameLocator('iframe[title="Isolated interactive form"]');
  await expect(iframe.locator('body')).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await iframe
    .getByLabel('Evidence URL', { exact: true })
    .fill('https://evidence.example.com/build/42');
  for (const theme of ['Light', 'Dark'] as const) {
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Appearance', exact: true })
      .getByRole('radio', { name: theme, exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(iframe.getByLabel('Evidence URL', { exact: true })).toHaveValue(
      'https://evidence.example.com/build/42',
    );
  }
  await expect(iframe.locator('body')).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await iframe.getByRole('button', { name: 'Review form response', exact: true }).click();
  await page.getByRole('button', { name: 'Submit reviewed response', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Form response submitted.');
  expect((await f.db.query('SELECT values FROM tool_form_submissions'))[0]?.values).toEqual({
    evidence: 'https://evidence.example.com/build/42',
  });
  await page.getByRole('button', { name: 'Tools and provider connections', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Tools and provider connections' });
  await expect(dialog).toContainText('execute_code');
  await dialog.getByLabel('payment approval', { exact: true }).selectOption('deny');
  await dialog.getByRole('button', { name: 'Save tool approval policy', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Tool approval policy saved.');
  expect(
    (await f.call(f.owner, 'GET', '/v1/execution/tool-policy')).json().rules.payment.approval,
  ).toBe('deny');
});
