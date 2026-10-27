import { test, expect, type BrowserContext } from '@playwright/test';
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
  workspace: string,
  member: string,
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
      name: 'Writer',
      email: 'writer@content-browser.test',
      password: 'browser-secure-password',
      workspace: 'Knowledge Studio',
    },
  });
  owner = signup.cookies[0]!.value;
  await verifyFixtureAccount(db, 'writer@content-browser.test');
  const boot = await call('GET', '/v1/bootstrap');
  workspace = boot.json().workspace.id;
  member = boot.json().me.id;
  const invite = await call('POST', '/v1/invitations', {
    email: 'editor@content-browser.test',
    role: 'member',
  });
  const accepted = await server.inject({
    method: 'POST',
    url: '/v1/invitations/accept',
    payload: { token: invite.json().token, name: 'Editor', password: 'browser-secure-password' },
  });
  mate = accepted.cookies[0]!.value;
  await verifyFixtureAccount(db, 'editor@content-browser.test');
  mateId = String((await db.query("SELECT id FROM memberships WHERE name='Editor'"))[0]!.id);
  origin = (await server.listen({ host: '127.0.0.1', port: 0 })).replace('127.0.0.1', 'localhost');
});
test.afterAll(async () => {
  await server.close();
  await db.close();
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
});
function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
async function channel(name: string) {
  return (await call('POST', '/v1/conversations', { name, visibility: 'public' })).json<{
    id: string;
  }>().id;
}
async function send(conversation: string, body: string, threadId?: string) {
  const response = await call('POST', `/v1/conversations/${conversation}/messages`, {
    body,
    clientId: randomUUID(),
    ...(threadId ? { threadId } : {}),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}
async function seed(conversation: string, count: number, thread: string | null = null) {
  await db.transaction(async (tx) => {
    const [row] = await tx.query(
      'UPDATE conversations SET next_sequence=next_sequence+$2 WHERE id=$1 RETURNING next_sequence',
      [conversation, count],
    );
    const high = Number(row!.next_sequence);
    await tx.query(
      `INSERT INTO messages(id,workspace_id,conversation_id,author_id,body,client_id,sequence,thread_id) SELECT gen_random_uuid(),$1,$2,$3,'History line ' || n,gen_random_uuid(),n,$4 FROM generate_series($5::integer,$6::integer) n`,
      [workspace, conversation, member, thread, high - count + 1, high],
    );
  });
}

test('loads older messages and replies, retains loaded history during live updates, and searches back to a precise message', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await connect(context);
  const conversation = await channel('history-browser');
  await seed(conversation, 235);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app');
  await page.getByRole('button', { name: /^history-browser/ }).click();
  await expect(page.getByText('History line 235', { exact: true })).toBeVisible();
  await expect(page.getByText('History line 1', { exact: true })).toHaveCount(0);
  const older = page.getByRole('button', { name: 'Load older messages', exact: true });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/messages/history?') && response.url().includes('before='),
    ),
    older.click(),
  ]);
  await expect(older).toBeEnabled();
  await page.locator('.messages').evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.getByText('History line 36', { exact: true })).toBeVisible();
  await older.click();
  await expect(page.getByRole('button', { name: 'Load older messages', exact: true })).toHaveCount(
    0,
  );
  await page.locator('.messages').evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.getByText('History line 1', { exact: true })).toBeVisible();
  const first = String(
    (
      await db.query('SELECT id FROM messages WHERE conversation_id=$1 AND sequence=1', [
        conversation,
      ])
    )[0]!.id,
  );
  await call('PATCH', `/v1/messages/${first}`, { version: 1, body: 'Edited older history line' });
  await expect(page.getByText('Edited older history line', { exact: true })).toBeAttached();
  await send(conversation, 'Live after pagination');
  await expect(
    page.getByRole('button', { name: 'Jump to latest messages', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Edited older history line', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Jump to latest messages', exact: true }).click();
  await expect(page.getByText('Live after pagination', { exact: true })).toBeVisible();
  const root = await send(conversation, 'Thread history root');
  await seed(conversation, 125, root);
  await send(conversation, 'Newest reply', root);
  await page.locator(`[data-message-id="${root}"]`).getByRole('button', { name: /repl/ }).click();
  await expect(page.getByRole('button', { name: 'Load older replies', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load older replies', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load older replies', exact: true })).toHaveCount(
    0,
  );
  await page.locator('.thread-replies').evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(
    page.locator('.thread-replies').getByText('History line 238', { exact: true }),
  ).toBeVisible();
  expect(await page.locator('.thread-replies [data-message-id]').count()).toBeLessThan(80);
  await page.getByLabel('Search messages', { exact: true }).fill('Edited older history');
  await page.getByLabel('Search messages', { exact: true }).press('Enter');
  await expect(page.locator('.search-result')).toHaveCount(1);
  await page.locator('.search-result').click();
  await expect(page.locator(`[data-message-id="${first}"]`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to latest conversation' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to latest conversation' }).click();
  await expect(page.getByText('Live after pagination', { exact: true })).toBeAttached();
  expect(errors).toEqual([]);
});

test('edits knowledge, preserves a conflicting draft, compares revisions and restores into a new version', async ({
  page,
  context,
}) => {
  await connect(context);
  const created = await call('POST', '/v1/knowledge', {
    title: 'Browser release guide',
    body: 'Original release instructions',
  });
  const id = created.json<{ id: string }>().id;
  await page.goto('/app');
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: /Browser release guide/ }).click();
  await page.getByRole('button', { name: 'Edit page', exact: true }).click();
  await page.getByLabel('Page content', { exact: true }).fill('My unsaved release instructions');
  await page.getByLabel('Change summary', { exact: true }).fill('Merge release guidance');
  const concurrent = await call(
    'PATCH',
    `/v1/knowledge/${id}`,
    {
      version: 1,
      title: 'Browser release guide',
      body: 'Teammate changed release instructions',
      summary: 'Teammate correction',
      clientId: randomUUID(),
    },
    mate,
  );
  expect(concurrent.statusCode, concurrent.body).toBe(200);
  await expect(page.getByText('A newer version is available: v2', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Page content', { exact: true })).toHaveValue(
    'My unsaved release instructions',
  );
  await expect(page.getByRole('button', { name: 'Save new version', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'I reviewed v2; keep my draft', exact: true }).click();
  await page.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(page.locator('.document-body')).toHaveText('My unsaved release instructions');
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Version 1 / })
    .click();
  await expect(page.locator('.revision-comparison')).toContainText('Original release instructions');
  await expect(page.locator('.revision-comparison')).toContainText(
    'My unsaved release instructions',
  );
  await page
    .getByRole('button', { name: 'Restore version 1 as a new version', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.document-body')).toHaveText('Original release instructions');
  expect((await call('GET', `/v1/knowledge/${id}`)).json().version).toBe(4);
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.revision-list li')).toHaveCount(4);
  await page.screenshot({
    path: test.info().outputPath('orbit-content-history.png'),
    fullPage: true,
  });
});

test('filters search by author and content type, paginates results, and opens knowledge hits', async ({
  page,
  context,
}) => {
  await connect(context);
  const conversation = await channel('search-browser');
  await seed(conversation, 65);
  await page.goto('/app');
  await page.getByLabel('Search messages', { exact: true }).fill('History');
  await page.getByLabel('Search messages', { exact: true }).press('Enter');
  await page.getByLabel('Conversation', { exact: true }).selectOption(conversation);
  await page.getByRole('button', { name: 'Apply search', exact: true }).click();
  await expect(page.locator('.search-result')).toHaveCount(30);
  await page.getByRole('button', { name: 'Load more results', exact: true }).click();
  await expect(page.locator('.search-result')).toHaveCount(60);
  await page.getByLabel('Author', { exact: true }).selectOption(mateId);
  await page.getByRole('button', { name: 'Apply search', exact: true }).click();
  await expect(page.locator('.search-result')).toHaveCount(0);
  await call('POST', '/v1/knowledge', {
    title: 'Searchable research guide',
    body: 'Knowledge full text search fixture',
  });
  await page.getByLabel('Search in', { exact: true }).selectOption('knowledge');
  await page.getByLabel('Advanced search terms', { exact: true }).fill('research');
  await page.getByLabel('Conversation', { exact: true }).selectOption('');
  await page.getByLabel('Author', { exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Apply search', exact: true }).click();
  await expect(page.locator('.search-result')).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath('orbit-content-search.png'),
    fullPage: true,
  });
  await page.locator('.search-result').click();
  await expect(page.locator('.document-body')).toHaveText('Knowledge full text search fixture');
});

test('retries a committed save after a lost response without appending a duplicate revision', async ({
  page,
  context,
}) => {
  await connect(context);
  const created = await call('POST', '/v1/knowledge', {
    title: 'Retryable handbook',
    body: 'Initial retry text',
  });
  const id = created.json<{ id: string }>().id;
  let dropped = false;
  await page.route(`**/api/v1/knowledge/${id}`, async (route) => {
    if (route.request().method() === 'PATCH' && !dropped) {
      const saved = await route.fetch({ url: `${origin}/v1/knowledge/${id}` });
      expect(saved.status()).toBe(200);
      dropped = true;
      await route.abort('failed');
    } else await route.fallback();
  });
  await page.goto('/app');
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: /Retryable handbook/ }).click();
  await page.getByRole('button', { name: 'Edit page', exact: true }).click();
  await page.getByLabel('Page content', { exact: true }).fill('Save survived the lost response');
  await page.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('.document-body')).toHaveText('Save survived the lost response');
  expect((await call('GET', `/v1/knowledge/${id}/versions`)).json().items).toHaveLength(2);
});

test('clears a private knowledge draft immediately when conversation access is revoked', async ({
  page,
  context,
}) => {
  const created = await call('POST', '/v1/conversations/groups', {
    title: 'Private knowledge group',
    membershipIds: [mateId],
  });
  const conversation = created.json<{ id: string }>().id;
  const published = await call('POST', '/v1/knowledge', {
    title: 'Restricted handbook',
    body: 'Restricted source context',
    conversationId: conversation,
  });
  expect(published.statusCode, published.body).toBe(201);
  await connect(context, mate);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: /Restricted handbook/ }).click();
  await page.getByRole('button', { name: 'Edit page', exact: true }).click();
  await page.getByLabel('Page content', { exact: true }).fill('Private unsaved draft');
  const removed = await call('PATCH', `/v1/conversations/${conversation}`, {
    version: 1,
    member: { membershipId: mateId, action: 'remove' },
  });
  expect(removed.statusCode, removed.body).toBe(200);
  await expect(page.getByLabel('Page content', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Restricted source context', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Restricted handbook/ })).toHaveCount(0);
});
