import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { database, migrate, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { testEmail, verifyFixtureAccount } from '../../apps/api/test/email.js';
import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';
let db: Database,
  server: FastifyInstance,
  origin: string,
  owner: string,
  mate: string,
  ownerId: string,
  mateId: string;
test.beforeEach(async () => {
  db = await database();
  await migrate(db);
  server = await buildApp(db, { origin: browserOrigin, email: testEmail() });
  allowBrowserStreams(server);
  const signup = await server.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      name: 'Task Owner',
      email: 'owner@tasks-browser.test',
      password: 'browser-secure-password',
      workspace: 'Delivery Studio',
    },
  });
  owner = signup.cookies[0]!.value;
  await verifyFixtureAccount(db, 'owner@tasks-browser.test');
  ownerId = (await call('GET', '/v1/bootstrap')).json().me.id;
  const invite = await call('POST', '/v1/invitations', {
    email: 'mate@tasks-browser.test',
    role: 'member',
  });
  const accepted = await server.inject({
    method: 'POST',
    url: '/v1/invitations/accept',
    payload: {
      token: invite.json().token,
      name: 'Task Editor',
      password: 'browser-secure-password',
    },
  });
  mate = accepted.cookies[0]!.value;
  await verifyFixtureAccount(db, 'mate@tasks-browser.test');
  mateId = (await call('GET', '/v1/bootstrap', undefined, mate)).json().me.id;
  origin = (await server.listen({ host: '127.0.0.1', port: 0 })).replace('127.0.0.1', 'localhost');
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
  await server.close();
  await db.close();
});
function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  payload?: unknown,
  session = owner,
) {
  return server.inject({
    method,
    url,
    headers: { cookie: `ao_session=${session}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}
async function connect(context: BrowserContext, session = owner) {
  await context.addCookies([
    {
      name: 'ao_session',
      value: session,
      url: 'http://localhost:3000',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await proxyApi(context, origin);
}
async function create(title: string, extra: Record<string, unknown> = {}) {
  const response = await call('POST', '/v1/tasks', { title, ...extra });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}
async function open(page: Page, title: string) {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.locator('.task-detail-heading h2')).toHaveText(title);
}
async function state(page: Page, next: string, evidence?: string) {
  await page.getByLabel('Task next state', { exact: true }).selectOption(next);
  if (evidence) await page.getByLabel('Task completion evidence', { exact: true }).fill(evidence);
  await page.getByRole('button', { name: 'Update task state', exact: true }).click();
}

test('plans due dates, nested work and dependencies, requires evidence and displays transition history', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await connect(context);
  await create('Security prerequisite', { assigneeId: ownerId });
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Release train');
  await page.getByLabel('Description', { exact: true }).fill('Coordinate release verification');
  await page.getByLabel('Assignee', { exact: true }).selectOption(ownerId);
  await page.getByLabel('Task due date', { exact: true }).fill('2000-01-01');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.task-row').filter({ hasText: 'Release train' })).toContainText(
    'Overdue',
  );
  await page.getByRole('button', { name: 'Release train', exact: true }).click();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  await page.getByLabel('Edit task due date', { exact: true }).fill('2027-11-20');
  await page.getByRole('button', { name: 'Save task changes', exact: true }).click();
  await expect(page.locator('.task-detail-metadata')).toContainText('2027');
  await page.getByRole('button', { name: 'Add subtask', exact: true }).click();
  await page.getByLabel('Subtask title', { exact: true }).fill('Release checklist');
  await page.getByLabel('Subtask assignee', { exact: true }).selectOption(ownerId);
  await page.getByRole('button', { name: 'Create subtask', exact: true }).click();
  await page.getByRole('button', { name: /^Release checklist/ }).click();
  await page.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await page.getByLabel('Find a prerequisite', { exact: true }).fill('Security prerequisite');
  await page
    .locator('.task-picker')
    .getByRole('button', { name: /^Security prerequisite/ })
    .click();
  await expect(page.getByText(/Waiting on 1 unfinished prerequisite/)).toBeVisible();
  await state(page, 'queued');
  await expect(page.locator('.task-detail-heading .state')).toHaveText('Queued');
  await state(page, 'active');
  await expect(page.locator('.task-detail-page').getByRole('alert')).toContainText(
    'Finish prerequisites',
  );
  await page
    .locator('.task-related-list')
    .getByRole('button', { name: /^Security prerequisite/ })
    .click();
  await state(page, 'queued');
  await state(page, 'active');
  await state(page, 'awaiting_review');
  await state(page, 'completed', 'Security checks and review passed');
  await expect(page.locator('.task-detail-heading .state')).toHaveText('Completed');
  await open(page, 'Release checklist');
  await state(page, 'active');
  await state(page, 'awaiting_review');
  await state(page, 'completed', 'All release checklist checks verified');
  await expect(page.locator('.task-detail-heading .state')).toHaveText('Completed');
  await page.getByRole('button', { name: '↑ Parent: Release train', exact: true }).click();
  await state(page, 'queued');
  await state(page, 'active');
  await state(page, 'awaiting_review');
  await state(page, 'completed', 'Parent and child evidence reviewed');
  await expect(page.locator('.task-detail-heading .state')).toHaveText('Completed');
  await page.getByRole('button', { name: 'Load state history', exact: true }).click();
  await expect(page.locator('.task-history-entry')).toHaveCount(4);
  await expect(page.locator('.task-history-entry').first()).toContainText(
    'Parent and child evidence reviewed',
  );
  await page.locator('.task-detail-page').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: test.info().outputPath('orbit-task-detail.png'), fullPage: true });
});

test('shares task comments live, keeps older pages, edits and deletes discussion, and opens task notifications', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const id = await create('Discussion task', { assigneeId: mateId });
  for (let i = 0; i < 35; i++) {
    const response = await call('POST', `/v1/tasks/${id}/comments`, {
      body: 'Task context ' + i,
      clientId: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(201);
  }
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    await connect(a);
    await connect(b, mate);
    const writer = await a.newPage(),
      reader = await b.newPage();
    await writer.goto('/app');
    await reader.goto('/app');
    await open(writer, 'Discussion task');
    await open(reader, 'Discussion task');
    await expect(reader.getByText('Task context 0', { exact: true })).toHaveCount(0);
    await reader.getByRole('button', { name: 'Load older task comments', exact: true }).click();
    await expect(reader.getByText('Task context 0', { exact: true })).toBeVisible();
    await reader.getByLabel('Add a task comment', { exact: true }).fill('Please check the rollout');
    await reader.getByRole('button', { name: 'Post comment', exact: true }).click();
    await expect(writer.getByText('Please check the rollout', { exact: true })).toBeVisible();
    await expect(reader.getByText('Task context 0', { exact: true })).toBeAttached();
    const commentId = await reader
      .locator('.task-comment')
      .filter({ hasText: 'Please check the rollout' })
      .getAttribute('data-task-comment-id');
    const edited = reader.locator(`[data-task-comment-id="${commentId}"]`);
    await edited.getByRole('button', { name: 'Edit comment', exact: true }).click();
    await edited
      .getByLabel('Edit task comment', { exact: true })
      .fill('Rollout verification is ready');
    await edited.getByRole('button', { name: 'Save comment', exact: true }).click();
    await expect(writer.getByText('Rollout verification is ready', { exact: true })).toBeVisible();
    const source = writer
      .locator('.task-comment')
      .filter({ hasText: 'Rollout verification is ready' });
    await source.getByRole('button', { name: 'Delete comment', exact: true }).click();
    await source.getByRole('button', { name: 'Confirm delete comment', exact: true }).click();
    await expect(reader.getByText('Rollout verification is ready', { exact: true })).toHaveCount(0);
    await expect(reader.getByText('Comment deleted', { exact: true })).toBeVisible();
    await writer.getByLabel('Add a task comment', { exact: true }).fill('Final task context');
    await writer.getByRole('button', { name: 'Post comment', exact: true }).click();
    await reader.getByRole('button', { name: /^Notifications/ }).click();
    const notice = reader
      .locator('.notification-list li')
      .filter({ hasText: 'Final task context' });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: /Commented on a task/ }).click();
    await expect(reader.locator('.task-detail-heading h2')).toHaveText('Discussion task');
  } finally {
    await Promise.all([...a.pages(), ...b.pages()].map((page) => page.goto('about:blank')));
    await a.unrouteAll({ behavior: 'ignoreErrors' });
    await b.unrouteAll({ behavior: 'ignoreErrors' });
    await a.close();
    await b.close();
  }
});

test('preserves task edit drafts during conflicts and clears private content after access revocation', async ({
  page,
  context,
}) => {
  const group = await call('POST', '/v1/conversations/groups', {
    title: 'Private task team',
    membershipIds: [mateId],
  });
  const conversation = group.json<{ id: string }>().id;
  const id = await create('Private task plan', {
    assigneeId: mateId,
    conversationId: conversation,
    description: 'Restricted original description',
  });
  await connect(context, mate);
  await page.goto('/app');
  await open(page, 'Private task plan');
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  await page
    .getByLabel('Edit task description', { exact: true })
    .fill('Unsaved task planning draft');
  const changed = await call('PATCH', `/v1/tasks/${id}`, {
    version: 1,
    description: 'Owner updated task scope',
    dueDate: '2027-12-01',
  });
  expect(changed.statusCode, changed.body).toBe(200);
  await expect(
    page.getByText('A newer task version is available: v2', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Edit task description', { exact: true })).toHaveValue(
    'Unsaved task planning draft',
  );
  await expect(page.getByRole('button', { name: 'Save task changes', exact: true })).toBeDisabled();
  await page
    .getByRole('button', { name: 'I reviewed v2; keep my task draft', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save task changes', exact: true }).click();
  await expect(page.locator('.task-description')).toHaveText('Unsaved task planning draft');
  await page.getByLabel('Add a task comment', { exact: true }).fill('Private discussion draft');
  const removed = await call('PATCH', `/v1/conversations/${conversation}`, {
    version: 1,
    member: { membershipId: mateId, action: 'remove' },
  });
  expect(removed.statusCode, removed.body).toBe(200);
  await expect(page.getByLabel('Add a task comment', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Private task plan', exact: true })).toHaveCount(0);
  await expect(page.getByText('Unsaved task planning draft', { exact: true })).toHaveCount(0);
});

test('paginates and filters task lists by assignee, overdue date and hierarchy', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const prefix = 'Filter task ' + randomUUID().slice(0, 6);
  let parent = '';
  for (let i = 0; i < 35; i++) {
    const id = await create(prefix + ' ' + i, {
      ...(i < 5 ? { dueDate: '2000-01-01' } : {}),
      ...(i < 3 ? { assigneeId: mateId } : {}),
      ...(i === 34 ? { parentId: parent } : {}),
    });
    if (i === 0) parent = id;
  }
  await connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByLabel('Find tasks', { exact: true }).fill(prefix);
  await page.getByRole('button', { name: 'Apply task filters', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(30);
  await page.getByRole('button', { name: 'Load more tasks', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(35);
  await page.getByLabel('Overdue only', { exact: true }).check();
  await page.getByRole('button', { name: 'Apply task filters', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(5);
  await page.getByLabel('Task assignee filter', { exact: true }).selectOption(mateId);
  await page.getByRole('button', { name: 'Apply task filters', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(3);
  await page.getByLabel('Overdue only', { exact: true }).uncheck();
  await page.getByLabel('Task assignee filter', { exact: true }).selectOption('');
  await page.getByLabel('Root tasks only', { exact: true }).check();
  await page.getByRole('button', { name: 'Apply task filters', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(30);
  await page.getByRole('button', { name: 'Load more tasks', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(34);
  await page.locator('.task-page').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: test.info().outputPath('orbit-task-list.png'), fullPage: true });
});
