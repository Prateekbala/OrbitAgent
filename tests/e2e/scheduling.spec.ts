import { TaskSchedulingWorker } from '../../apps/api/src/scheduling/worker.js';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
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
test.beforeAll(async () => {
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
test.afterAll(async () => {
  await server.close();
  await db.close();
});
test.afterEach(async ({ page, context }) => {
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
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
test('configures recurrence and reminders, previews month-end occurrences, and pauses schedules', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const id = await create('Monthly finance review', { dueDate: '2035-01-31', assigneeId: ownerId });
  await connect(context);
  await page.goto('/app');
  await open(page, 'Monthly finance review');
  await page.getByRole('button', { name: 'Make recurring', exact: true }).click();
  await page.getByLabel('Recurrence frequency', { exact: true }).selectOption('monthly');
  await page.getByLabel('First occurrence', { exact: true }).fill('2035-01-31');
  await page.getByLabel('Recurrence end date', { exact: true }).fill('2035-03-31');
  await page.getByLabel('Recurrence creation lead days', { exact: true }).fill('2');
  await page.getByLabel('Recurrence creation time', { exact: true }).fill('08:00');
  await page.getByLabel('Recurrence time zone', { exact: true }).fill('Asia/Kolkata');
  await page.getByRole('button', { name: 'Save recurring schedule', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit recurring schedule', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add due-date reminder', exact: true }).click();
  await page.getByLabel('Reminder days before', { exact: true }).fill('1');
  await page.getByLabel('Reminder time', { exact: true }).fill('09:00');
  await page.getByLabel('Reminder time zone', { exact: true }).fill('Asia/Kolkata');
  await page.getByRole('button', { name: 'Save due-date reminder', exact: true }).click();
  await expect(page.locator('.task-schedule-summary').last()).toContainText('1 day(s) before due');
  await page.getByRole('button', { name: '← All tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByLabel('Calendar month', { exact: true }).fill('2035-02');
  const feb = page.getByRole('cell', { name: '2035-02-28', exact: true });
  await expect(feb.locator('.calendar-task.preview')).toContainText('Monthly finance review');
  await page.getByLabel('Calendar assignee', { exact: true }).selectOption(mateId);
  await expect(page.locator('.calendar-task')).toHaveCount(0);
  await page.getByLabel('Calendar assignee', { exact: true }).selectOption(ownerId);
  await expect(feb.locator('.calendar-task.preview')).toHaveCount(1);
  await page
    .locator('.task-calendar')
    .screenshot({ path: test.info().outputPath('orbit-task-calendar.png') });
  await feb.getByRole('button', { name: /Monthly finance review/ }).click();
  await expect(page.locator('.task-detail-heading h2')).toHaveText('Monthly finance review');
  await page.getByRole('button', { name: 'Edit recurring schedule', exact: true }).click();
  await page.getByLabel('Pause this schedule', { exact: true }).check();
  await page.getByRole('button', { name: 'Save recurring schedule', exact: true }).click();
  await expect(page.locator('.task-schedule-summary').first()).toContainText('Paused');
  await page.getByRole('button', { name: '← All tasks', exact: true }).click();
  await expect(page.getByLabel('Calendar month', { exact: true })).toHaveValue('2035-02');
  await expect(page.locator('.calendar-task.preview')).toHaveCount(0);
  await page.getByRole('button', { name: 'Recurring', exact: true }).click();
  await expect(
    page.locator('.recurring-task-row').filter({ hasText: 'Monthly finance review' }),
  ).toContainText('Paused');
  const configured = (await call('GET', `/v1/tasks/${id}/scheduling`)).json();
  expect(configured.recurrence).toMatchObject({ lead_days: 2, paused: true, frequency: 'monthly' });
  expect(configured.reminder).toMatchObject({
    enabled: true,
    days_before: 1,
    time_zone: 'Asia/Kolkata',
  });
});

test('delivers a recurring task reminder live and opens its generated occurrence', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const id = await create('Recurring operations check', {
    dueDate: '2036-04-03',
    assigneeId: ownerId,
  });
  expect(
    (
      await call('PUT', `/v1/tasks/${id}/reminder`, {
        version: 0,
        enabled: true,
        daysBefore: 1,
        localTime: '09:00',
        timeZone: 'UTC',
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await call('PUT', `/v1/tasks/${id}/recurrence`, {
        version: 0,
        frequency: 'weekly',
        interval: 1,
        startDate: '2036-04-03',
        endDate: '2036-04-03',
        leadDays: 2,
        timeZone: 'UTC',
        localTime: '08:00',
        paused: false,
      })
    ).statusCode,
  ).toBe(200);
  await connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const failures: unknown[] = [];
  const worker = new TaskSchedulingWorker(db, (error) => failures.push(error));
  await worker.tick(new Date('2036-04-01T09:00:00Z'));
  expect(failures).toEqual([]);
  const occurrence = (
    await db.query(
      'SELECT o.task_id FROM task_occurrences o JOIN task_recurrences r ON r.workspace_id=o.workspace_id AND r.id=o.recurrence_id WHERE r.task_id=$1',
      [id],
    )
  )[0];
  expect(occurrence).toBeTruthy();
  await worker.tick(new Date('2036-04-02T09:00:00Z'));
  expect(failures).toEqual([]);
  const notice = page
    .locator('.notification-list li')
    .filter({ hasText: 'Recurring operations check' })
    .filter({ hasText: 'Task due-date reminder' });
  const notices = (await call('GET', '/v1/notifications?limit=50')).json().items as {
    id: string;
    task_id: string;
    kind: string;
  }[];
  const generatedNotice = notices.find(
    (n) => n.kind === 'task_reminder' && n.task_id === occurrence!.task_id,
  )!;
  await expect(notice).toHaveCount(2);
  await page
    .locator(`[data-notification-id="${generatedNotice.id}"]`)
    .getByRole('button', { name: /Task due-date reminder/ })
    .click();
  await expect(page.locator('.task-detail-heading h2')).toHaveText('Recurring operations check');
  await expect(
    page.getByRole('button', { name: 'Open recurring source', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open recurring source', exact: true }).click();
  await expect(page.locator('.task-schedule-summary').first()).toContainText('Schedule ended');
});

test('retains a schedule draft on a concurrent update and requires review', async ({
  page,
  context,
}) => {
  const id = await create('Schedule conflict review', { dueDate: '2037-01-01' });
  await call('PUT', `/v1/tasks/${id}/recurrence`, {
    version: 0,
    frequency: 'daily',
    interval: 1,
    startDate: '2037-01-01',
    endDate: null,
    leadDays: 0,
    timeZone: 'UTC',
    localTime: '09:00',
    paused: false,
  });
  await connect(context);
  await page.goto('/app');
  await open(page, 'Schedule conflict review');
  await page.getByRole('button', { name: 'Edit recurring schedule', exact: true }).click();
  await page.getByLabel('Recurrence interval', { exact: true }).fill('3');
  expect(
    (
      await call('PUT', `/v1/tasks/${id}/recurrence`, {
        version: 1,
        frequency: 'weekly',
        interval: 2,
        startDate: '2037-01-01',
        endDate: null,
        timeZone: 'UTC',
        localTime: '09:00',
        paused: false,
      })
    ).statusCode,
  ).toBe(200);
  await expect(
    page.getByText('This schedule changed. Cancel and reopen it to review the latest settings.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Recurrence interval', { exact: true })).toHaveValue('3');
  await expect(
    page.getByRole('button', { name: 'Save recurring schedule', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel recurrence edit', exact: true }).click();
  await page.getByRole('button', { name: 'Edit recurring schedule', exact: true }).click();
  await expect(page.getByLabel('Recurrence frequency', { exact: true })).toHaveValue('weekly');
  await expect(page.getByLabel('Recurrence interval', { exact: true })).toHaveValue('2');
});
