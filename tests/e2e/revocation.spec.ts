import { test, expect, type Page } from '@playwright/test';
import { taskBrowserFixture } from './task-browser-fixture.js';

let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeAll(async () => {
  f = await taskBrowserFixture();
});
test.afterAll(async () => {
  await f?.close();
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
});

async function controlledStream(page: Page) {
  await page.addInitScript(() => {
    const streams: EventTarget[] = [];
    Object.defineProperty(window, 'testEventStreams', { value: streams });
    Object.defineProperty(window, 'EventSource', {
      value: class extends EventTarget {
        static CLOSED = 2;
        readyState = 0;
        constructor() {
          super();
          streams.push(this);
          queueMicrotask(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event('ready'));
          });
        }
        close() {
          this.readyState = 2;
        }
      },
    });
  });
}
async function invalidate(page: Page, id?: string) {
  await page.evaluate((conversation) => {
    window.dispatchEvent(new Event('focus'));
    if (conversation) {
      const streams = (window as unknown as { testEventStreams: EventTarget[] }).testEventStreams;
      streams.at(-1)!.dispatchEvent(
        new MessageEvent('changes', {
          data: JSON.stringify({
            events: [
              {
                id: 'r'.repeat(43),
                event_type: 'conversation.access_revoked',
                resource_id: conversation,
                conversation_id: null,
              },
            ],
            cursor: 'v1.' + 'c'.repeat(48),
            hasMore: false,
          }),
        }),
      );
    }
  }, id);
}
async function group(name: string) {
  const r = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
    title: name,
    membershipIds: [f.mateBoot.me.id],
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json<{ id: string }>().id;
  expect((await f.send(f.owner, id, 'Private context for ' + name)).statusCode).toBe(201);
  return id;
}
async function open(page: Page, name: string) {
  await page.goto('/app');
  await page
    .getByRole('navigation', { name: 'Direct and group messages' })
    .getByRole('button', { name: new RegExp('^' + name) })
    .click();
  await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
  await expect(
    page.locator('.messages').getByText('Private context for ' + name, { exact: true }),
  ).toBeVisible();
}
async function remove(id: string) {
  const r = await f.call(f.owner, 'PATCH', `/v1/conversations/${id}`, {
    version: 1,
    member: { membershipId: f.mateBoot.me.id, action: 'remove' },
  });
  expect(r.statusCode, r.body).toBe(200);
  expect((await f.call(f.mate, 'GET', `/v1/conversations/${id}/messages`)).statusCode).toBe(404);
}
async function hidden(page: Page, name: string) {
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Direct and group messages' })
      .getByRole('button', { name: new RegExp('^' + name) }),
  ).toHaveCount(0);
  await expect(page.getByText('Private context for ' + name, { exact: true })).toHaveCount(0);
}

test('applies revocation even when a full refresh coalesces its event', async ({
  page,
  context,
}) => {
  const name = 'Coalesced private group',
    id = await group(name);
  await controlledStream(page);
  await f.connect(context, f.mate);
  await open(page, name);
  await page
    .getByRole('textbox', { name: 'Message ' + name, exact: true })
    .fill('Unsent private draft');
  await page.getByRole('button', { name: 'View participants', exact: true }).click();
  await remove(id);
  await invalidate(page, id);
  await hidden(page, name);
  await expect(page.getByRole('dialog', { name: 'Group details', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message ' + name, exact: true })).toHaveCount(0);
});

test('recovers membership before content when a revocation event was missed', async ({
  page,
  context,
}) => {
  const name = 'Resumed private group',
    id = await group(name);
  await controlledStream(page);
  await f.connect(context, f.mate);
  await open(page, name);
  await remove(id);
  await invalidate(page);
  await hidden(page, name);
});

test('clears access while an old bootstrap is delayed and never restores its private snapshot', async ({
  page,
  context,
}) => {
  const name = 'Delayed private snapshot',
    id = await group(name);
  await controlledStream(page);
  await f.connect(context, f.mate);
  await open(page, name);
  let release!: () => void, captured!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let intercept = true;
  await page.route('**/api/v1/bootstrap', async (route) => {
    if (!intercept) {
      await route.fallback();
      return;
    }
    intercept = false;
    const snapshot = await f.call(f.mate, 'GET', '/v1/bootstrap');
    captured();
    await held;
    await route
      .fulfill({
        status: snapshot.statusCode,
        contentType: 'application/json',
        body: snapshot.body,
      })
      .catch((error) => {
        if (!route.request().failure()) throw error;
      });
  });
  try {
    await invalidate(page);
    await ready;
    await remove(id);
    await invalidate(page, id);
    await hidden(page, name);
  } finally {
    release();
  }
  await page.unrouteAll({ behavior: 'wait' });
  const refreshed = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/bootstrap') && r.status() === 200,
  );
  await invalidate(page);
  await refreshed;
  await hidden(page, name);
});
