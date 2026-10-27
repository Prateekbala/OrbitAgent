import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { taskBrowserFixture } from './task-browser-fixture.js';
let fixture: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeAll(async () => {
  fixture = await taskBrowserFixture();
  await fixture.createTask('Review the shared launch plan', {
    description: 'Verify the release evidence and project dependencies.',
  });
  const knowledge = await fixture.call(fixture.owner, 'POST', '/v1/knowledge', {
    title: 'Launch decisions',
    body: 'We keep the shared sage identity in both themes. Every decision includes its supporting evidence.',
  });
  expect(knowledge.statusCode).toBe(201);
  const message = await fixture.call(
    fixture.owner,
    'POST',
    `/v1/conversations/${fixture.ownerBoot.channels[0]!.id}/messages`,
    {
      clientId: randomUUID(),
      format: 'markdown',
      body: 'The launch checklist is ready for review.\n\n**Next steps**\n- Verify the release evidence\n- Review dependencies with the team',
    },
  );
  expect(message.statusCode).toBe(201);
  await fixture.send(
    fixture.mate,
    fixture.ownerBoot.channels[0]!.id,
    'I’ll review the remaining dependencies and share the results here.',
  );
});
test.afterAll(async () => fixture?.close());
test.afterEach(async ({ page, context }) => {
  await page.close();
  await context.unrouteAll({ behavior: 'ignoreErrors' });
});
async function chooseTheme(page: Page, theme: 'Light' | 'Dark' | 'System') {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
  await dialog.getByRole('radio', { name: theme, exact: true }).click();
  await expect(dialog.getByRole('radio', { name: theme, exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}
async function expectDark(page: Page, dark = true) {
  await expect(page.locator('html')).toHaveClass(dark ? /\bdark\b/ : /\blight\b/);
  await expect(page.locator('.main')).toHaveCSS(
    'background-color',
    dark ? 'rgb(20, 20, 20)' : 'rgb(255, 255, 255)',
  );
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim().toLowerCase(),
    ),
  ).toBe(dark ? '#86dba2' : '#263e30');
}

test('persists appearance across reloads and tabs, follows system changes, and keeps explicit preferences', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fixture.connect(context);
  await page.goto('/app');
  await chooseTheme(page, 'Dark');
  await expectDark(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expectDark(page);
  const peer = await context.newPage();
  try {
    await peer.goto('/app');
    await expectDark(peer);
    await chooseTheme(page, 'Light');
    await expectDark(peer, false);
    await chooseTheme(page, 'System');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectDark(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expectDark(page, false);
    await chooseTheme(page, 'Light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectDark(page, false);
  } finally {
    await peer.close();
  }
  expect(errors).toEqual([]);
});

test('dark mode covers every workspace destination, settings, and dialogs without white application surfaces', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await fixture.connect(context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/app');
  await chooseTheme(page, 'Dark');
  const navigation = page.getByRole('navigation', { name: 'Workspace views', exact: true });
  for (const label of [
    'Notifications',
    'Your messages',
    'Discover channels',
    'Conversations',
    'Tasks',
    'Agents',
    'Knowledge',
    'Agent runs',
    'Automations',
    'Developer',
    'Migrations',
    'Shared channels',
    'Approvals',
    'Team',
  ]) {
    await navigation.getByRole('button', { name: label, exact: true }).click();
    await expectDark(page);
    const whiteSurfaces = await page.locator('.main').evaluate((main) =>
      Array.from(main.querySelectorAll('*'))
        .filter((element) => {
          if (
            !(element instanceof HTMLElement) ||
            !element.getClientRects().length ||
            element.closest('.appearance-sample')
          )
            return false;
          const rect = element.getBoundingClientRect();
          if (rect.width < 24 || rect.height < 16) return false;
          const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)$/.exec(
            getComputedStyle(element).backgroundColor,
          );
          return (
            match &&
            Number(match[1]) > 220 &&
            Number(match[2]) > 220 &&
            Number(match[3]) > 220 &&
            (!match[4] || Number(match[4]) > 0.9)
          );
        })
        .map((element) => `${element.tagName}.${element.className}`)
        .slice(0, 10),
    );
    expect(whiteSurfaces, label).toEqual([]);
    if (['Conversations', 'Tasks', 'Knowledge', 'Developer', 'Team'].includes(label))
      await page.screenshot({
        path: test.info().outputPath(`dark-${label.toLowerCase()}-desktop.png`),
        animations: 'disabled',
      });
  }
  await page.getByRole('button', { name: 'Settings & activity', exact: true }).click();
  const appearance = page.getByRole('region', { name: 'Appearance settings', exact: true });
  await expect(appearance.getByRole('radio', { name: 'Dark', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.screenshot({
    path: test.info().outputPath('dark-settings-desktop.png'),
    animations: 'disabled',
  });
  await navigation.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a task', exact: true });
  await expect(dialog).toHaveCSS('background-color', 'rgb(20, 20, 20)');
  await expect(dialog.getByLabel('Task title', { exact: true })).toHaveCSS(
    'color',
    'rgb(237, 237, 237)',
  );
  await page.screenshot({
    path: test.info().outputPath('dark-task-dialog.png'),
    animations: 'disabled',
  });
});

test('sidebar filtering, day separators, header members and mobile theme controls remain usable', async ({
  page,
  context,
}) => {
  await fixture.connect(context);
  await page.goto('/app');
  await expect(page.locator('.message-day-divider')).toHaveText('Today');
  await expect(page.locator('.rich-message ul').first()).toHaveCSS('list-style-type', 'disc');
  const search = page.getByRole('searchbox', { name: 'Find a conversation', exact: true });
  await search.fill('no-such-conversation');
  await expect(
    page.getByRole('status').filter({ hasText: 'No conversations match' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Channels', exact: true }).getByRole('button'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear conversation filter', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(
    page.getByRole('navigation', { name: 'Channels', exact: true }).getByRole('button'),
  ).toHaveCount(fixture.ownerBoot.channels.length);
  await page.getByRole('button', { name: 'View participants', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await chooseTheme(page, 'Dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectDark(page);
  await page.screenshot({
    path: test.info().outputPath('dark-conversation-mobile.png'),
    animations: 'disabled',
  });
  await chooseTheme(page, 'Light');
  await expectDark(page, false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('message reactions, editing and knowledge authoring use legible dark controls', async ({
  page,
  context,
}) => {
  await fixture.connect(context);
  await page.goto('/app');
  await chooseTheme(page, 'Dark');
  const message = page
    .locator('.message')
    .filter({ hasText: 'The launch checklist is ready for review.' });
  await message.hover();
  await message.getByLabel('Add reaction', { exact: true }).click();
  const picker = message.getByRole('group', { name: 'Choose reaction', exact: true });
  await expect(picker).toHaveCSS('background-color', 'rgb(36, 36, 36)');
  await picker.getByRole('button', { name: 'React with 👍', exact: true }).click();
  await message.getByRole('button', { name: 'Edit message', exact: true }).click();
  const editor = message.getByRole('textbox', { name: 'Edit message text', exact: true });
  await expect(editor).toHaveCSS('color', 'rgb(237, 237, 237)');
  await message.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Workspace views', exact: true })
    .getByRole('button', { name: 'Knowledge', exact: true })
    .click();
  await page.getByRole('button', { name: /Launch decisions/ }).click();
  await page.getByRole('button', { name: 'Edit page', exact: true }).click();
  await expect(page.getByLabel('Page title', { exact: true })).toHaveCSS(
    'color',
    'rgb(237, 237, 237)',
  );
  await page.screenshot({
    path: test.info().outputPath('dark-knowledge-editor.png'),
    animations: 'disabled',
  });
});
