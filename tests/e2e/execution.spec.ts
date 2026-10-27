import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';
import { testEmail } from '../../apps/api/test/email.js';
import { verifyFixtureInBrowser } from './account-helpers.js';
import { test, expect } from '@playwright/test';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { ExecutionWorker } from '../../apps/api/src/execution/worker.js';
import type { HostedRuntime } from '../../apps/api/src/execution/types.js';
const fixture: HostedRuntime = {
  configured: true,
  async createSession() {
    return 'browser-fixture-session';
  },
  async generate() {
    return {
      reply: 'I proposed the release review. It awaits approval.',
      proposals: [
        {
          tool: 'create_task',
          parameters: {
            title: 'Review hosted release',
            description: 'Verify the release evidence before acceptance.',
            priority: 'high',
          },
        },
      ],
    };
  },
  async cancel() {},
  async recover() {
    return null;
  },
};
let db: Database, server: FastifyInstance, stop: () => Promise<void>, origin: string;
test.beforeAll(async () => {
  db = await database();
  await migrate(db);
  server = await buildApp(db, { origin: browserOrigin, runtime: fixture, email: testEmail() });
  allowBrowserStreams(server);
  origin = await server.listen({ host: '127.0.0.1', port: 0 });
  stop = new ExecutionWorker(db, fixture).start(50);
});
test.afterAll(async () => {
  await stop();
  await server.close();
  await db.close();
});
test('hosted run requires exact human approval before creating a task', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await proxyApi(page, origin);
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('Run Reviewer');
  await page.getByLabel('Workspace name').fill('Hosted Test Studio');
  await page.getByLabel('Email address').fill('reviewer@example.test');
  await page.getByLabel('Password', { exact: true }).fill('hosted-browser-test-password');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await verifyFixtureInBrowser(page, db, 'reviewer@example.test');
  await page.getByRole('button', { name: /^Agents/ }).click();
  await page.getByRole('button', { name: 'Add agent', exact: true }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Hosted Atlas');
  await page.getByLabel('Execution', { exact: true }).selectOption('managed');
  await page.getByLabel('Role and instructions').fill('Plan release reviews with clear evidence.');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hosted Atlas', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your agent credential' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Agent runs', exact: true }).click();
  await page.getByRole('button', { name: 'Run agent', exact: true }).click();
  await page.getByLabel('Request', { exact: true }).fill('Propose a release review task.');
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(page.getByText('Awaiting review', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review hosted release', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Approvals', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review hosted release', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Review action', exact: true }).click();
  await page.getByLabel('Decision note').fill('The scope and evidence requirement are correct.');
  await page.getByRole('button', { name: 'Approve action', exact: true }).click();
  await expect(
    page.getByText('Applied once with a recorded approval.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review hosted release', exact: true }),
  ).toBeVisible();
  expect(await db.query("SELECT id FROM tasks WHERE title='Review hosted release'")).toHaveLength(
    1,
  );
  expect(errors).toEqual([]);
});
