import { browserOrigin } from './api-proxy.js';
import { test, expect } from '@playwright/test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { taskBrowserFixture } from './task-browser-fixture.js';
import { AutomationWorker } from '../../apps/api/src/automations/worker.js';
let f: Awaited<ReturnType<typeof taskBrowserFixture>>;
test.beforeEach(async () => {
  f = await taskBrowserFixture();
});
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
  await f?.close();
});
test('creates and versions a recurring workflow, previews upcoming runs and pauses its queued work', async ({
  page,
  context,
}) => {
  const channel = f.ownerBoot.channels[0]!,
    template = await f.call(f.owner, 'POST', '/v1/work-templates', {
      clientId: randomUUID(),
      name: 'Browser scheduled workflow',
      kind: 'workflow',
      conversationId: channel.id,
      definition: {
        steps: [{ key: 'create', type: 'create_task', title: 'Scheduled browser task' }],
      },
    });
  expect(template.statusCode, template.body).toBe(200);
  expect(
    (
      await f.call(f.owner, 'PUT', `/v1/work-templates/${template.json().id}/publication`, {
        version: 1,
        revision: 1,
      })
    ).statusCode,
  ).toBe(200);
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'New automation', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New automation' });
  await dialog.getByLabel('Automation name', { exact: true }).fill('Browser weekday check');
  await dialog.getByLabel('Automation destination', { exact: true }).selectOption(channel.id);
  await dialog.getByLabel('Automation action', { exact: true }).selectOption('workflow');
  await dialog.getByLabel('Automation workflow', { exact: true }).selectOption(template.json().id);
  await dialog.getByRole('button', { name: 'Save paused automation', exact: true }).click();
  const details = page.getByLabel('Automation details', { exact: true });
  await expect(details).toContainText('paused');
  await details.getByRole('button', { name: 'Resume automation', exact: true }).click();
  await expect(details).toContainText('active');
  await expect(details.getByRole('listitem')).toHaveCount(10);
  const [id] = await f.db.query('SELECT id FROM automations WHERE name=$1', [
    'Browser weekday check',
  ]);
  await f.db.query('UPDATE automations SET next_at=$2 WHERE id=$1', [
    id!.id,
    new Date(Date.now() - 1000),
  ]);
  const errors: string[] = [];
  await new AutomationWorker(f.db, (e) => errors.push(e)).tick();
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'Refresh automations', exact: true }).click();
  await expect(details.getByLabel('Automation run history')).toContainText('running');
  await details.getByRole('button', { name: 'Pause automation', exact: true }).click();
  await expect(details).toContainText('cancelled');
  await details.getByRole('button', { name: 'Edit automation', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit automation' });
  await edit.getByLabel('Automation name', { exact: true }).fill('Browser revised check');
  await edit.getByRole('button', { name: 'Save paused automation', exact: true }).click();
  await expect(details).toContainText('revision 2');
  await expect(details.getByLabel('Automation revision history')).toContainText('Revision 1');
});
test('creates, rotates and revokes an audience-scoped developer key and registers an OAuth application', async ({
  page,
  context,
}) => {
  await f.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Developer', exact: true }).click();
  const form = page.getByRole('form', { name: 'Create API key' });
  await form.getByLabel('API key name', { exact: true }).fill('Browser client');
  await form.getByLabel('tasks.read', { exact: true }).check();
  await form.getByText(f.ownerBoot.channels[0]!.name, { exact: true }).locator('input').check();
  await form.getByRole('button', { name: 'Create scoped API key', exact: true }).click();
  const secret = page.getByLabel('Developer credential', { exact: true });
  await expect(secret).toHaveValue(/^orb_/);
  const first = await secret.inputValue();
  await page.getByRole('button', { name: 'Rotate Browser client', exact: true }).click();
  await expect(secret).not.toHaveValue(first);
  await page.getByRole('button', { name: 'Revoke Browser client', exact: true }).click();
  await expect(secret).toHaveCount(0);
  const oauth = page.getByRole('region', { name: 'OAuth application registration' });
  await oauth.getByLabel('OAuth application name', { exact: true }).fill('Browser OAuth app');
  await oauth
    .getByLabel('Exact redirect URLs, one per line', { exact: true })
    .fill('https://app.example/oauth/callback');
  await oauth.getByRole('button', { name: 'Register OAuth application', exact: true }).click();
  await expect(oauth).toContainText('Browser OAuth app');
  await expect(oauth).toContainText('Client ID:');
});

test('reviews OAuth workspace and acting identity before issuing a resource-scoped authorization code', async ({
  page,
  context,
}) => {
  const organizations = (await f.call(f.owner, 'GET', '/v1/organizations')).json(),
    org = organizations[0].id;
  const target = await f.call(f.owner, 'POST', `/v1/organizations/${org}/workspaces`, {
    name: 'Consent destination',
    region: 'global',
  });
  expect(target.statusCode, target.body).toBe(201);
  const client = await f.call(f.owner, 'POST', '/v1/developer/clients', {
    name: 'Browser consent application',
    redirectUris: ['https://client.example/callback'],
  });
  expect(client.statusCode, client.body).toBe(201);
  const verifier = randomBytes(48).toString('base64url'),
    state = randomBytes(24).toString('base64url'),
    resource = `${browserOrigin}/api/public/v1`;
  const query = new URLSearchParams({
    client_id: client.json().id,
    redirect_uri: 'https://client.example/callback',
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource,
    scope: 'tasks.read',
    state,
  });
  await f.connect(context);
  await page.route('https://client.example/callback**', async (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Fixture callback</h1>' }),
  );
  await page.goto('/developer/authorize?' + query);
  await expect(page.getByText('Browser consent application', { exact: true })).toBeVisible();
  await page
    .getByLabel('Choose authorization workspace', { exact: true })
    .selectOption(target.json().membershipId);
  await expect(page.getByText('Consent destination', { exact: true })).toBeVisible();
  await page
    .getByRole('group', { name: 'Conversations this application may access' })
    .getByText('general', { exact: true })
    .locator('input')
    .check();
  await page.getByRole('button', { name: 'Allow selected access', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.origin === 'https://client.example' && url.pathname === '/callback',
  );
  const callback = new URL(page.url());
  expect(callback.origin).toBe('https://client.example');
  expect(callback.pathname).toBe('/callback');
  expect(callback.searchParams.get('state')).toBe(state);
  expect(callback.searchParams.get('iss')).toBe(`${browserOrigin}/api`);
  const tokens = await f.app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: {
      grant_type: 'authorization_code',
      client_id: client.json().id,
      redirect_uri: 'https://client.example/callback',
      code_verifier: verifier,
      code: callback.searchParams.get('code'),
      resource,
    },
  });
  expect(tokens.statusCode, tokens.body).toBe(200);
  expect(
    (
      await f.db.query('SELECT workspace_id FROM platform_credentials WHERE client_id=$1', [
        client.json().id,
      ])
    )[0]!.workspace_id,
  ).toBe(target.json().id);
});
