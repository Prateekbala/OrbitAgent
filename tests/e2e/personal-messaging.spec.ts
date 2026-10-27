import { test, expect } from '@playwright/test';
import { taskBrowserFixture } from './task-browser-fixture.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async () => {
  f = await taskBrowserFixture();
});
test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  await page.close();
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await f?.close();
});
test('renders rich text, saves and pins messages, follows a thread, and restores a persistent draft', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  const channel = f.ownerBoot.channels[0]!,
    composer = page.getByRole('textbox', { name: `Message #${channel.name}`, exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('**A clear decision**\n\n- Release after review');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const message = page.locator('.message').filter({ hasText: 'A clear decision' });
  await expect(message.locator('strong').filter({ hasText: 'A clear decision' })).toBeVisible();
  await expect(message.locator('li')).toHaveText('Release after review');
  await message.getByRole('button', { name: 'Save message', exact: true }).click();
  await expect(message.getByRole('button', { name: 'Unsave', exact: true })).toBeVisible();
  await message.getByRole('button', { name: 'Pin message', exact: true }).click();
  await expect(message.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();
  await message.getByRole('button', { name: 'Unfollow thread', exact: true }).click();
  await message.getByRole('button', { name: 'Follow thread', exact: true }).click();
  await expect(message.getByRole('button', { name: 'Unfollow thread', exact: true })).toBeVisible();
  await composer.fill('Draft preserved through reload');
  await expect
    .poll(
      async () =>
        (await f.call(f.owner, 'GET', `/v1/conversations/${channel.id}/draft`)).json().body,
    )
    .toBe('Draft preserved through reload');
  await page.reload();
  await expect(composer).toHaveValue('Draft preserved through reload');
  await page.getByRole('button', { name: 'Your messages', exact: true }).click();
  await expect(page.locator('.personal-message-card')).toContainText('A clear decision');
  await page.getByRole('button', { name: 'Open message', exact: true }).click();
  await expect(message).toBeVisible();
  const id = await message.getAttribute('data-message-id');
  await page.goto(`/?workspace=${f.ownerBoot.workspace.id}&message=${id}`);
  await expect(message).toBeVisible();
  const draft = await f.call(f.owner, 'PUT', `/v1/conversations/${channel.id}/draft`, {
    threadId: id,
    body: 'Continue this thread draft',
    format: 'markdown',
    version: 0,
  });
  expect(draft.statusCode, draft.body).toBe(200);
  await page.getByRole('button', { name: 'Your messages', exact: true }).click();
  await page.getByRole('button', { name: 'Drafts', exact: true }).click();
  await page
    .locator('.personal-message-card')
    .filter({ hasText: 'Continue this thread draft' })
    .getByRole('button', { name: 'Continue draft', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'Reply to thread', exact: true })).toHaveValue(
    'Continue this thread draft',
  );
});
test('queues encrypted offline messages across reload and sends once after reconnecting', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  const channel = f.ownerBoot.channels[0]!,
    composer = page.getByRole('textbox', { name: `Message #${channel.name}`, exact: true });
  await expect(composer).toBeEnabled();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await composer.fill('offline-private-sentinel');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.composer-wrap [role=status]')).toContainText('Queued on this device');
  const protectedStorage = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('orbit-private-messaging');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const request = db.transaction('records').objectStore('records').getAll();
    return await new Promise<boolean>((resolve) => {
      request.onsuccess = () =>
        resolve(
          request.result.every(
            (row: { ciphertext: ArrayBuffer }) =>
              !new TextDecoder().decode(row.ciphertext).includes('offline-private-sentinel'),
          ),
        );
    });
  });
  expect(protectedStorage).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: /Your messages/ })).toBeVisible();
  await context.setOffline(false);
  await expect
    .poll(
      async () =>
        (await f.messages(f.owner, channel.id)).filter((m) => m.body === 'offline-private-sentinel')
          .length,
      { timeout: 20000 },
    )
    .toBe(1);
  await expect(
    page.locator('.message').filter({ hasText: 'offline-private-sentinel' }),
  ).toBeVisible();
  await page.reload();
  await expect
    .poll(
      async () =>
        (await f.messages(f.owner, channel.id)).filter((m) => m.body === 'offline-private-sentinel')
          .length,
    )
    .toBe(1);
});
test('schedules and cancels delivery and customizes, archives, and restores a channel', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  const channel = f.ownerBoot.channels[0]!,
    composer = page.getByRole('textbox', { name: `Message #${channel.name}`, exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('A scheduled browser message');
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  const time = await page.evaluate(() => {
    const d = new Date(Date.now() + 3600000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  await page.getByLabel('Delivery time', { exact: true }).fill(time);
  await page.getByRole('button', { name: 'Schedule message', exact: true }).click();
  await expect(page.locator('.composer-wrap [role=status]')).toHaveText('Message scheduled.');
  await page.getByRole('button', { name: 'Your messages', exact: true }).click();
  await page.getByRole('button', { name: 'Scheduled', exact: true }).click();
  await expect(page.locator('.personal-message-card')).toContainText('A scheduled browser message');
  await page.getByRole('button', { name: 'Cancel scheduled message', exact: true }).click();
  await expect(page.locator('.personal-message-card')).toContainText('cancelled');
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  const sidebar = page.getByRole('region', { name: 'Sidebar customization' });
  await sidebar.getByRole('button', { name: 'Add sidebar section', exact: true }).click();
  await sidebar.getByLabel('Section name').fill('Focused work');
  await sidebar.locator('summary').filter({ hasText: 'Assign and hide conversations' }).click();
  await sidebar
    .getByLabel(`Section for ${channel.name}`, { exact: true })
    .selectOption({ label: 'Focused work' });
  await sidebar.getByRole('button', { name: 'Save sidebar preferences', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Focused work' })).toContainText(channel.name);
  await page.getByRole('button', { name: 'Discover channels', exact: true }).click();
  const card = page
    .locator('.personal-message-card')
    .filter({ has: page.getByRole('heading', { name: channel.name, exact: true }) });
  await card.getByRole('button', { name: 'Archive channel', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByLabel('Show archived channels').check();
  await card.getByRole('button', { name: 'Restore channel', exact: true }).click();
  await page.getByLabel('Show archived channels').uncheck();
  await expect(card).toBeVisible();
});
test('virtualizes a long timeline while loading earlier history and opening a permalink', async ({
  page,
  context,
}) => {
  const channel = f.ownerBoot.channels[0]!.id;
  const ids: string[] = [];
  for (let i = 0; i < 150; i++) {
    const r = await f.send(f.owner, channel, 'Timeline message ' + i);
    ids.push(r.json().id);
  }
  await f.connect(context);
  await page.goto('/app');
  await expect(page.locator('[data-virtualized=true]')).toBeVisible();
  await expect(page.locator('.message').filter({ hasText: 'Timeline message 149' })).toBeVisible();
  expect(await page.locator('.messages .message').count()).toBeLessThan(80);
  await page.locator('.messages').evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.locator('.message').filter({ hasText: 'Timeline message 50' })).toBeVisible();
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
  await expect(page.locator('.message').filter({ hasText: 'Timeline message 50' })).toBeVisible();
  expect(await page.locator('.messages .message').count()).toBeLessThan(80);
  await page.goto(`/?workspace=${f.ownerBoot.workspace.id}&message=${ids[4]}`);
  await expect(page.locator(`[data-message-id="${ids[4]}"]`)).toBeVisible();
  await page.goto(`/?workspace=${f.ownerBoot.workspace.id}&message=${ids[74]}`);
  await expect(page.locator(`[data-message-id="${ids[74]}"]`)).toBeVisible();
  await page.locator('.messages').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.locator(`[data-message-id="${ids[124]}"]`)).toBeVisible();
  const edited = await f.call(f.owner, 'PATCH', `/v1/messages/${ids[124]}`, {
    version: 1,
    body: 'Updated while reading beyond the permalink',
  });
  expect(edited.statusCode, edited.body).toBe(200);
  await expect(
    page.locator('.message').filter({ hasText: 'Updated while reading beyond the permalink' }),
  ).toBeVisible();
});
test('collects existing participants’ consent before sharing private group history', async ({
  page,
  context,
  browser,
}) => {
  const targetEmail = (await f.call(f.other, 'GET', '/v1/account')).json().email,
    invite = await f.call(f.owner, 'POST', '/v1/invitations', { email: targetEmail }),
    accepted = await f.call(f.other, 'POST', '/v1/invitations/accept', {
      token: invite.json().token,
    }),
    targetSession = accepted.cookies[0]!.value,
    target = (await f.boot(targetSession)).me.id;
  const created = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Consented history',
      membershipIds: [f.mateBoot.me.id],
      historyPolicy: 'retained',
    }),
    group = created.json().id,
    old = (await f.send(f.owner, group, 'Earlier confidential decision')).json().id;
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Consented history', exact: true }).click();
  await page.getByRole('button', { name: 'View participants', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Group details' });
  await dialog.getByRole('combobox', { name: 'Add participant', exact: true }).selectOption(target);
  await dialog.getByLabel('History access').selectOption('retained');
  await dialog.getByRole('button', { name: 'Request history consent', exact: true }).click();
  await expect(dialog).toContainText('1 of 2 approvals');
  expect((await f.call(targetSession, 'GET', `/v1/messages/${old}/context`)).statusCode).toBe(404);
  const mateContext = await browser.newContext();
  const matePage = await mateContext.newPage();
  try {
    await f.connect(mateContext, f.mate);
    await matePage.goto('/app');
    await matePage.getByRole('button', { name: /^Consented history/ }).click();
    await matePage.getByRole('button', { name: 'View participants', exact: true }).click();
    const mateDialog = matePage.getByRole('dialog', { name: 'Group details' });
    await mateDialog.getByRole('button', { name: 'Approve history sharing', exact: true }).click();
    await expect(mateDialog).toContainText('accepted');
    expect((await f.call(targetSession, 'GET', `/v1/messages/${old}/context`)).statusCode).toBe(
      200,
    );
  } finally {
    await matePage.goto('about:blank');
    await mateContext.unrouteAll({ behavior: 'wait' });
    await mateContext.close();
  }
});
