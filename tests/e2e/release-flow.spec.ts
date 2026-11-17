import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  migrate,
  scopedDatabase,
  tenantScope,
  identifyPrincipal,
  type Database,
} from '@ao/database';
import type { FastifyInstance } from 'fastify';
import type { Bootstrap, ToolInvocation } from '@ao/contracts';
import { buildApp } from '../../apps/api/src/app.js';
import { testDatabase } from '../../apps/api/test/database.js';
import { TestMailbox } from '../../apps/api/test/email.js';
import { EmailService } from '../../apps/api/src/email/service.js';
import { EmailWorker } from '../../apps/api/src/email/worker.js';
import { ExecutionWorker } from '../../apps/api/src/execution/worker.js';
import {
  BackgroundDispatcher,
  type BackgroundWorker,
} from '../../apps/api/src/background/dispatcher.js';
import { backgroundDatabase } from '../../apps/api/src/background/database.js';
import { backgroundWakeups } from '../../apps/api/src/background/http.js';
import { TestBackgroundQueue } from '../../apps/api/test/background-queue.js';
import { managedRuntimeFixture } from './managed-runtime-fixture.js';
import { allowBrowserStreams, browserOrigin, proxyApi } from './api-proxy.js';

let db: Database;
let server: FastifyInstance;
let origin: string;
let mailbox: TestMailbox;
let emailWorker: EmailWorker;
let execution: ExecutionWorker;
let queue: TestBackgroundQueue;
let managed: Awaited<ReturnType<typeof managedRuntimeFixture>> | undefined;
test.beforeAll(async () => {
  test.setTimeout(180000);
  managed = await managedRuntimeFixture();
  db = await testDatabase();
  await migrate(db);
  mailbox = new TestMailbox();
  const email = new EmailService(
    mailbox,
    Buffer.alloc(32, 7).toString('base64'),
    'Orbit <release@example.test>',
    browserOrigin,
  );
  server = await buildApp(db, { origin: browserOrigin, email, runtime: managed.runtime });
  emailWorker = new EmailWorker(backgroundDatabase(db, 'email'), email);
  execution = new ExecutionWorker(
    backgroundDatabase(db, 'execution'),
    managed.runtime,
    undefined,
    undefined,
    { maxConcurrent: 1, maxDispatchSeconds: 180 },
  );
  queue = new TestBackgroundQueue();
  const background = new BackgroundDispatcher(
    db,
    new Map<string, BackgroundWorker>([
      ['email', emailWorker],
      ['execution', execution],
    ]),
    queue,
  );
  queue.dispatcher = background;
  backgroundWakeups(server, background);
  allowBrowserStreams(server);
  origin = await server.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => {
  await queue?.close();
  await server?.close();
  await db?.close();
  await managed?.close();
});

async function api(
  context: BrowserContext,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  data?: unknown,
) {
  const session = (await context.cookies()).find((cookie) => cookie.name === 'ao_session')?.value;
  return context.request.fetch(origin + path, {
    method,
    headers: { cookie: `ao_session=${session ?? ''}`, origin: browserOrigin },
    ...(data ? { data } : {}),
  });
}

async function signup(page: Page, context: BrowserContext, workspace: string): Promise<Bootstrap> {
  await proxyApi(context, origin);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const email = randomUUID() + '@release.example.test';
  await page.goto('/sign-up');
  await page.getByLabel('Your name', { exact: true }).fill(workspace + ' Owner');
  await page.getByLabel('Workspace name', { exact: true }).fill(workspace);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('release-browser-test-password');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Verify your email.', exact: true }),
  ).toBeVisible();
  expect((await api(context, '/v1/bootstrap')).status()).toBe(403);
  await expect
    .poll(() => mailbox.messages.some(({ message }) => message.to.includes(email)))
    .toBe(true);
  const delivered = mailbox.messages.find(({ message }) => message.to.includes(email));
  expect(delivered).toBeDefined();
  const link = delivered!.message.text.match(
    /http:\/\/localhost:\d+\/verify-email#[A-Za-z0-9_-]{43}/,
  )?.[0];
  expect(link).toBeDefined();
  await page.goto(link!);
  await page.getByRole('button', { name: 'Verify email address', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email verified.', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.locator('.workspace-title')).toHaveText(workspace);
  const bootstrap = await api(context, '/v1/bootstrap');
  expect(bootstrap.status()).toBe(200);
  return bootstrap.json();
}

test('signup, delivered verification, managed Groq reply, exact approval and task creation preserve tenant isolation', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const outsider = await browser.newContext();
  const otherPage = await outsider.newPage();
  try {
    const owner = await signup(page, context, 'Release Alpha');
    const other = await signup(otherPage, outsider, 'Release Beta');
    expect(owner.workspace.id).not.toBe(other.workspace.id);
    const source = 'ALPHA_EVIDENCE_' + randomUUID();
    const foreign = 'BETA_PRIVATE_EVIDENCE_' + randomUUID();
    for (const [account, workspace, body] of [
      [context, owner, source],
      [outsider, other, foreign],
    ] as const) {
      const sent = await api(
        account,
        `/v1/conversations/${workspace.channels[0]!.id}/messages`,
        'POST',
        { clientId: randomUUID(), body },
      );
      expect(sent.status()).toBe(201);
    }
    await page.getByRole('button', { name: /^Agents/ }).click();
    await page.getByRole('button', { name: 'Add agent', exact: true }).first().click();
    await page.getByLabel('Name', { exact: true }).fill('Release Atlas');
    await page.getByLabel('Execution', { exact: true }).selectOption('managed');
    await page
      .getByLabel('Role and instructions')
      .fill('Propose one release review task based on the source evidence.');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Release Atlas', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Agent runs', exact: true }).click();
    await page.getByRole('button', { name: 'Run agent', exact: true }).click();
    await page
      .getByLabel('Request', { exact: true })
      .fill('Propose a release review task from this channel evidence.');
    await page.getByRole('button', { name: 'Start run', exact: true }).click();
    await expect(
      page.getByText('Awaiting review', { exact: true }),
      managed!.diagnostics(),
    ).toBeVisible({ timeout: 45000 });
    expect(managed!.requests).toHaveLength(1);
    expect(queue.deliveries.some((message) => message.worker === 'execution')).toBe(true);
    expect(queue.errors).toEqual([]);
    const providerInput = JSON.stringify(managed!.requests[0]);
    expect(providerInput).toContain(source);
    expect(providerInput).not.toContain(foreign);
    expect(providerInput).not.toContain('synthetic-release-groq-api-key');
    const approvals = await api(context, '/v1/approvals');
    const [action] = (await approvals.json()) as ToolInvocation[];
    expect(action?.status).toBe('pending');
    expect(
      await db.query('SELECT id FROM tasks WHERE workspace_id=$1 AND title=$2', [
        owner.workspace.id,
        'Review isolated release',
      ]),
    ).toHaveLength(0);
    expect((await api(outsider, `/v1/runs/${action!.run_id}`)).status()).toBe(404);
    expect((await api(outsider, '/v1/approvals')).status()).toBe(200);
    expect(await (await api(outsider, '/v1/approvals')).json()).toEqual([]);
    const decision = {
      decision: 'approved',
      digest: action!.action_digest,
      reason: 'Reviewed the source and scope.',
    };
    expect(
      (await api(outsider, `/v1/approvals/${action!.id}/decisions`, 'POST', decision)).status(),
    ).toBe(404);
    expect(
      (
        await api(context, `/v1/approvals/${action!.id}/decisions`, 'POST', {
          ...decision,
          digest: '0'.repeat(64),
        })
      ).status(),
    ).toBe(409);
    const [run] = await db.query('SELECT agent_id FROM agent_runs WHERE id=$1', [action!.run_id]);
    expect(
      (
        await api(outsider, '/v1/runs', 'POST', {
          agentId: run!.agent_id,
          conversationId: other.channels[0]!.id,
          requestKey: randomUUID(),
          prompt: 'Attempt cross-tenant execution',
        })
      ).status(),
    ).toBe(404);
    expect(managed!.requests).toHaveLength(1);
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Review isolated release', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Approvals', exact: true }).click();
    await page.getByRole('button', { name: 'Review action', exact: true }).click();
    await page.getByLabel('Decision note').fill(decision.reason);
    await page.getByRole('button', { name: 'Approve action', exact: true }).click();
    await expect(
      page.getByText('Applied once with a recorded approval.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Review isolated release', exact: true }),
    ).toBeVisible();
    const tasks = await db.query('SELECT id,title FROM tasks WHERE workspace_id=$1 AND title=$2', [
      owner.workspace.id,
      'Review isolated release',
    ]);
    expect(tasks).toHaveLength(1);
    const taskId = String(tasks[0]!.id);
    expect((await api(outsider, `/v1/tasks/${taskId}`)).status()).toBe(404);
    expect(
      (await api(context, `/v1/approvals/${action!.id}/decisions`, 'POST', decision)).status(),
    ).toBe(409);
    await queue.dispatcher.publish();
    expect(await db.query('SELECT id FROM tasks WHERE id=$1', [taskId])).toHaveLength(1);
    expect(
      await db.query('SELECT id FROM approval_decisions WHERE invocation_id=$1', [action!.id]),
    ).toHaveLength(1);
    await tenantScope(other.workspace.id, async () => {
      identifyPrincipal(other.me.id, 'member');
      const isolated = scopedDatabase(db);
      expect(
        (await isolated.query("SELECT row_security_active('tasks'::regclass) active"))[0]!.active,
      ).toBe(true);
      expect(
        (
          await isolated.query('SELECT id FROM conversations WHERE workspace_id=$1', [
            other.workspace.id,
          ])
        ).length,
      ).toBeGreaterThan(0);
      expect(await isolated.query('SELECT id FROM tasks WHERE id=$1', [taskId])).toEqual([]);
      expect(
        await isolated.query('SELECT id FROM agent_runs WHERE id=$1', [action!.run_id]),
      ).toEqual([]);
      expect(
        await isolated.query('SELECT id FROM tool_invocations WHERE id=$1', [action!.id]),
      ).toEqual([]);
      expect(
        await isolated.query(
          "UPDATE tasks SET title='cross-tenant mutation' WHERE id=$1 RETURNING id",
          [taskId],
        ),
      ).toEqual([]);
      await expect(
        isolated.query(
          'INSERT INTO tasks(id,workspace_id,title,description,priority) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), owner.workspace.id, 'forbidden', 'foreign insertion', 'normal'],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
    expect((await db.query('SELECT title FROM tasks WHERE id=$1', [taskId]))[0]!.title).toBe(
      'Review isolated release',
    );
    expect(managed!.requests).toHaveLength(1);
    expect(queue.errors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await outsider.close();
  }
});
