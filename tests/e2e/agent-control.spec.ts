import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { taskBrowserFixture } from './task-browser-fixture.js';
import { ExecutionWorker } from '../../apps/api/src/execution/worker.js';
import type { HostedRuntime } from '../../apps/api/src/execution/types.js';
const runtime: HostedRuntime = {
  configured: true,
  capabilities: {
    models: ['fixture/model'],
    durableCheckpoints: true,
    resumeObservation: true,
    maxSeconds: 86400,
  },
  async createSession() {
    return randomUUID();
  },
  async generate() {
    return { reply: 'Browser fixture: supplied evidence has been reviewed.', proposals: [] };
  },
  async generateDetailed() {
    return {
      output: { reply: 'Browser fixture: supplied evidence has been reviewed.', proposals: [] },
      usage: { inputTokens: 100, outputTokens: 20, costMicros: 10000 },
    };
  },
  async recover() {
    return null;
  },
  async cancel() {},
};
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async () => {
  f = await taskBrowserFixture(undefined, { runtime });
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
  await f?.close();
});
async function agent(name: string, execution: 'external' | 'managed' = 'managed') {
  const response = await f.call(f.owner, 'POST', '/v1/agents', {
    name,
    role: 'Review release evidence and report gaps.',
    runtime: execution,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}
test('manages immutable agent revisions, scoped credentials, ownership and archive lifecycle', async ({
  page,
  context,
}) => {
  const id = await agent('Controlled receiver', 'external');
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: /^Agents/ }).click();
  await page.getByRole('button', { name: 'Agent controls', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Controlled receiver · Agent controls' });
  await dialog
    .getByLabel('Agent instructions', { exact: true })
    .fill('Reviewed instructions require reproducible evidence.');
  await dialog.getByLabel('Activation', { exact: true }).selectOption('manual');
  await dialog.getByRole('button', { name: 'Save new agent revision' }).click();
  await expect(dialog).toContainText('Revision 2');
  await dialog.getByRole('button', { name: 'History', exact: true }).click();
  await expect(dialog.locator('article.work-card')).toHaveCount(2);
  await expect(dialog).toContainText('Reviewed instructions require reproducible evidence.');
  await dialog.getByRole('button', { name: 'Credentials', exact: true }).click();
  await dialog.getByLabel('Credential name', { exact: true }).fill('Scoped browser receiver');
  await dialog.getByLabel('Expires in days', { exact: true }).fill('7');
  await dialog.getByRole('button', { name: 'Create credential', exact: true }).click();
  await expect(
    dialog.getByText('Save this credential now. It is shown once.', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Revoke Scoped browser receiver' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Dismiss secret', exact: true }).click();
  await expect(dialog.locator('.agent-secret')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Revoke Scoped browser receiver' }).click();
  await expect(dialog.getByRole('button', { name: 'Revoke Scoped browser receiver' })).toHaveCount(
    0,
  );
  await dialog.getByRole('button', { name: 'Configuration', exact: true }).click();
  await dialog.getByLabel('Agent owner', { exact: true }).selectOption(f.mateBoot.me.id);
  await dialog.getByRole('button', { name: 'Apply lifecycle change' }).click();
  await expect
    .poll(async () => (await f.call(f.owner, 'GET', `/v1/agents/${id}`)).json().status)
    .toBe('paused');
  await dialog.getByLabel('Agent state', { exact: true }).selectOption('archived');
  await dialog.getByRole('button', { name: 'Apply lifecycle change' }).click();
  await expect(dialog.getByRole('button', { name: 'Save new agent revision' })).toBeDisabled();
  expect((await f.call(f.owner, 'GET', `/v1/agents/${id}`)).json().owner_id).toBe(f.mateBoot.me.id);
});
test('shows budgets, checkpoints and public traces and independently verifies delegated results', async ({
  page,
  context,
}) => {
  const parentAgent = await agent('Parent coordinator'),
    childAgent = await agent('Independent specialist'),
    channel = f.ownerBoot.channels[0]!.id;
  const created = await f.call(f.owner, 'POST', '/v1/runs', {
    agentId: parentAgent,
    conversationId: channel,
    prompt: 'Prepare a verified release plan.',
    requestKey: randomUUID(),
  });
  expect(created.statusCode, created.body).toBe(201);
  const parent = created.json().id;
  await new ExecutionWorker(f.db, runtime).tick();
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Agent runs', exact: true }).click();
  await page.getByRole('button', { name: 'Execution limits and spending', exact: true }).click();
  const policy = page.getByRole('region', { name: 'Execution limits and spending' });
  await expect(policy).toContainText('Spent');
  await policy.getByLabel('Workspace execution budget (USD)', { exact: true }).fill('10');
  await policy.getByRole('button', { name: 'Save execution policy' }).click();
  await expect
    .poll(async () =>
      Number((await f.call(f.owner, 'GET', '/v1/execution/policy')).json().budget_micros),
    )
    .toBe(10000000);
  await page.getByRole('button', { name: 'Run details and coordination', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Parent coordinator · Run details' });
  await expect(dialog).toContainText('The validated result was published.');
  await expect(dialog).toContainText('Reservation');
  await dialog.getByRole('button', { name: 'Delegate work', exact: true }).click();
  await dialog.getByLabel('Delegate agent', { exact: true }).selectOption(childAgent);
  await dialog.getByLabel('Delegation owner', { exact: true }).selectOption(f.ownerBoot.me.id);
  await dialog.getByLabel('Independent verifier', { exact: true }).selectOption(f.mateBoot.me.id);
  await dialog
    .getByLabel('Delegation request', { exact: true })
    .fill('Prepare independent reproducible release checks.');
  await dialog
    .getByLabel('Required output contract', { exact: true })
    .fill('Return reproducible evidence and all unresolved gaps.');
  await dialog
    .getByLabel('Stop condition', { exact: true })
    .fill('Stop when required evidence is unavailable.');
  const deadline = await page.evaluate(() => {
    const date = new Date(Date.now() + 3600000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  });
  await dialog.getByLabel('Delegation deadline', { exact: true }).fill(deadline);
  await dialog.getByRole('button', { name: 'Create delegation', exact: true }).click();
  await expect(dialog).toContainText('Return reproducible evidence and all unresolved gaps.');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  const [child] = await f.db.query('SELECT id FROM agent_runs WHERE parent_run_id=$1', [parent]);
  expect(child).toBeTruthy();
  await new ExecutionWorker(f.db, runtime).tick();
  await context.clearCookies();
  await f.connect(context, f.mate);
  await page.reload();
  await page.getByRole('button', { name: 'Agent runs', exact: true }).click();
  const childCard = page.locator('.run-card').filter({ hasText: 'Independent specialist' });
  await childCard.getByRole('button', { name: 'Run details and coordination' }).click();
  dialog = page.getByRole('dialog', { name: 'Independent specialist · Run details' });
  await dialog
    .getByLabel('Verification evidence', { exact: true })
    .fill('Independently reproduced every supplied release check.');
  await dialog.getByRole('button', { name: 'Record independent verification' }).click();
  await expect(dialog).toContainText('Verification: accepted');
  expect(
    (await f.call(f.owner, 'GET', `/v1/runs/${parent}/detail`)).json().coordination_status,
  ).toBe('verified');
});
test('preserves a rejected webhook URL and displays dead-letter retry controls', async ({
  page,
  context,
}) => {
  const id = await agent('Webhook receiver', 'external');
  const message = (
    await f.send(f.owner, f.ownerBoot.channels[0]!.id, 'Delivery retry evidence')
  ).json().id;
  await f.db.query(
    "INSERT INTO agent_inbox(id,workspace_id,agent_id,message_id,state,attempts,summary) VALUES($1,$2,$3,$4,'dead',5,'Receiver attempts exhausted')",
    [randomUUID(), f.ownerBoot.workspace.id, id, message],
  );
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: /^Agents/ }).click();
  await page.getByRole('button', { name: 'Agent controls', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Webhook receiver · Agent controls' });
  await dialog.getByRole('button', { name: 'Delivery and webhooks', exact: true }).click();
  await expect(dialog).toContainText('Receiver attempts exhausted');
  await dialog.getByRole('button', { name: 'Retry delivery', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry delivery', exact: true })).toHaveCount(0);
  await dialog
    .getByLabel('Webhook URL', { exact: true })
    .fill('https://unapproved.example.test/hook');
  await dialog.getByRole('button', { name: 'Save webhook and rotate secret' }).click();
  await expect(dialog.getByRole('alert')).toContainText('operator-approved');
  await expect(dialog.getByLabel('Webhook URL', { exact: true })).toHaveValue(
    'https://unapproved.example.test/hook',
  );
});
