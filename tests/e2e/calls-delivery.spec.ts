import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CallWorker } from '../../apps/api/src/calls/worker.js';
import { test, expect } from '@playwright/test';
import { taskBrowserFixture } from './task-browser-fixture.js';
import { LiveKitMedia } from '../../apps/api/src/calls/provider.js';
import type { CallMedia } from '../../apps/api/src/calls/provider.js';

let fixture: Awaited<ReturnType<typeof taskBrowserFixture>>;
const live = Boolean(process.env.LIVEKIT_TEST_URL);
const unavailableRecording: CallMedia = {
  url: 'ws://localhost:7880',
  recording: false,
  async mute() {},
  async ensureRoom() {},
  async ticket() {
    return 'fixture';
  },
  async remove() {},
  async close() {},
  async recordings() {
    return [];
  },
  async record() {
    throw new Error('Recording is not configured.');
  },
  async stopRecording() {},
};
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});
test.beforeAll(async () => {
  fixture = await taskBrowserFixture(undefined, {
    ...(process.env.LIVEKIT_RECORDING_TEST === 'true'
      ? { recordingDirectory: resolve('.data/call-recordings') }
      : {}),
    media: live
      ? new LiveKitMedia(
          process.env.LIVEKIT_TEST_URL!,
          process.env.LIVEKIT_TEST_KEY!,
          process.env.LIVEKIT_TEST_SECRET!,
          process.env.LIVEKIT_RECORDING_TEST === 'true',
        )
      : unavailableRecording,
  });
});
test.afterAll(async () => fixture?.close());
test.afterEach(async ({ page, context }) => {
  await page.goto('about:blank');
  await context.unrouteAll({ behavior: 'wait' });
});

test('call privacy controls require consent and advertise unavailable recording accurately', async ({
  page,
  context,
}) => {
  await fixture.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Open calls' }).click();
  const dialog = page.getByRole('dialog', { name: 'Calls', exact: true });
  await expect(dialog.getByLabel('Call privacy')).toHaveValue('no_recording');
  if (process.env.LIVEKIT_RECORDING_TEST !== 'true')
    await expect(
      dialog.getByRole('option', { name: 'Retained recording · 30-day retention' }),
    ).toHaveAttribute('disabled', '');
  await dialog.getByRole('button', { name: 'Start a call' }).click();
  await expect(dialog.getByRole('button', { name: 'Join call', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await expect(dialog.getByRole('button', { name: 'Join call', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'End call for everyone' }).click();
});
test('notification delivery preferences persist without requesting browser permissions', async ({
  page,
  context,
}) => {
  await fixture.connect(context);
  await page.goto('/app');
  await page
    .getByRole('navigation', { name: 'Workspace views', exact: true })
    .getByRole('button', { name: 'Notifications', exact: true })
    .click();
  await page.getByRole('button', { name: 'Notification settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Notification settings' });
  await dialog.getByLabel('Email notifications').selectOption('hourly');
  await dialog.getByLabel('Timezone', { exact: true }).fill('Asia/Kolkata');
  await dialog.getByRole('button', { name: 'Save delivery settings' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Delivery settings saved.');
  const response = await fixture.call(
    fixture.owner,
    'GET',
    '/v1/notification-delivery/preferences',
  );
  expect(response.json().preferences).toMatchObject({
    email: 'hourly',
    timezone: 'Asia/Kolkata',
    push: false,
  });
});
test('two browsers exchange real microphone and video tracks through self-hosted LiveKit', async ({
  page,
  context,
  browser,
}) => {
  test.skip(
    !live,
    'Requires the self-hosted media verification environment; no provider mock qualifies this test.',
  );
  test.setTimeout(90000);
  await fixture.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Open calls' }).click();
  const host = page.getByRole('dialog', { name: 'Calls', exact: true });
  await fixture.db.query("UPDATE calls SET state='ended',ended_at=now() WHERE state='ending'");
  await host.getByRole('button', { name: 'Start a call' }).click();
  await host.getByRole('checkbox').check();
  await host.getByRole('button', { name: 'Join call', exact: true }).click();
  await expect(host.getByRole('button', { name: 'Unmute microphone' })).toBeEnabled({
    timeout: 30000,
  });
  await host.getByRole('button', { name: 'Unmute microphone' }).click();
  await host.getByRole('button', { name: 'Start camera' }).click();
  const peerContext = await browser.newContext();
  try {
    await fixture.connect(peerContext, fixture.mate);
    const peer = await peerContext.newPage();
    await peer.goto('/app');
    await peer.getByRole('button', { name: 'Open calls' }).click();
    const guest = peer.getByRole('dialog', { name: 'Calls', exact: true });
    await guest
      .getByRole('button', { name: /Join call$/ })
      .first()
      .click();
    await guest.getByRole('checkbox').check();
    await guest.getByRole('button', { name: 'Join call', exact: true }).click();
    await expect(guest.getByRole('button', { name: 'Unmute microphone' })).toBeEnabled({
      timeout: 30000,
    });
    await guest.getByRole('button', { name: 'Unmute microphone' }).click();
    await guest.getByRole('button', { name: 'Start camera' }).click();
    await expect(host.locator('.call-video video')).toHaveCount(2, { timeout: 20000 });
    await expect(guest.locator('.call-video video')).toHaveCount(2, { timeout: 20000 });
    await expect
      .poll(() =>
        host
          .locator('.call-video video')
          .evaluateAll((videos) =>
            videos.every((video) => (video as HTMLVideoElement).readyState >= 2),
          ),
      )
      .toBe(true);
    await host.getByRole('button', { name: 'Leave', exact: true }).click();
    await guest.getByRole('button', { name: 'Leave', exact: true }).click();
    await host.getByRole('button', { name: 'End call for everyone' }).click();
  } finally {
    await peerContext.close();
  }
});

test('retained recording produces a private MP4 only after consent', async ({ page, context }) => {
  test.skip(
    !live || process.env.LIVEKIT_RECORDING_TEST !== 'true',
    'Requires the separately deployed local recording worker.',
  );
  test.setTimeout(120000);
  await fixture.db.query("UPDATE calls SET state='ended',ended_at=now() WHERE state='ending'");
  await fixture.connect(context);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Open calls' }).click();
  const dialog = page.getByRole('dialog', { name: 'Calls', exact: true });
  await dialog.getByLabel('Call privacy').selectOption('retained_recording');
  await dialog.getByRole('button', { name: 'Start a call' }).click();
  await expect(dialog.getByRole('button', { name: 'Join call', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Join call', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Unmute microphone' })).toBeEnabled({
    timeout: 30000,
  });
  await dialog.getByRole('button', { name: 'Unmute microphone' }).click();
  await dialog.getByRole('button', { name: 'Start camera' }).click();
  const [call] = await fixture.db.query(
    "SELECT id,room_name FROM calls WHERE state='active' ORDER BY created_at DESC LIMIT 1",
  );
  const media = new LiveKitMedia(
    process.env.LIVEKIT_TEST_URL!,
    process.env.LIVEKIT_TEST_KEY!,
    process.env.LIVEKIT_TEST_SECRET!,
    true,
  );
  const worker = new CallWorker(fixture.db, media, resolve('.data/call-recordings'));
  await worker.tick();
  await expect
    .poll(
      async () => {
        const recordings = await media.recordings(String(call!.room_name));
        return recordings.some((recording) => recording.state === 'active');
      },
      { timeout: 45000 },
    )
    .toBe(true);
  await page.waitForTimeout(4000);
  await dialog.getByRole('button', { name: 'End call for everyone' }).click();
  await worker.tick();
  const path = resolve('.data/call-recordings', String(call!.id) + '.mp4');
  await expect
    .poll(
      async () => {
        const file = await stat(path).catch(() => null);
        return Boolean(file && file.size > 1000);
      },
      { timeout: 45000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        await worker.tick();
        const [state] = await fixture.db.query('SELECT recording_state FROM calls WHERE id=$1', [
          call!.id,
        ]);
        return state!.recording_state;
      },
      { timeout: 30000 },
    )
    .toBe('stopped');
  await media.close(String(call!.room_name));
  const recording = await fixture.call(fixture.owner, 'GET', `/v1/calls/${call!.id}/recording`);
  expect(recording.statusCode, recording.body.slice(0, 200)).toBe(200);
  expect(recording.headers['content-type']).toBe('video/mp4');
  expect(
    (await fixture.call(fixture.other, 'GET', `/v1/calls/${call!.id}/recording`)).statusCode,
  ).toBe(404);
});
