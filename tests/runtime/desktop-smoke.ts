import { _electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'orbit-desktop-smoke-'));
const server = createServer((_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Content-Security-Policy': "default-src 'none'; script-src 'none'",
  });
  res.end('<!doctype html><title>Orbit desktop verification</title><main>Private workspace</main>');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing test origin.');
const { default: electron } = await import('electron');
try {
  const client = await _electron.launch({
    timeout: 15000,
    executablePath: electron as unknown as string,
    args: [join(process.cwd(), 'apps/desktop/dist/main.js')],
    env: {
      ...process.env,
      ORBIT_DESKTOP_ORIGIN: `http://127.0.0.1:${address.port}`,
      ORBIT_DESKTOP_USER_DATA: directory,
      ORBIT_DESKTOP_SMOKE: '1',
    },
  });
  try {
    const window = await client.firstWindow({ timeout: 15000 });
    await window.waitForLoadState();
    assert.equal(await window.title(), 'Orbit desktop verification');
    assert.equal(
      await window.evaluate(() => typeof (globalThis as unknown as { require?: unknown }).require),
      'undefined',
    );
    const sandboxed = await client.evaluate(({ app, BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId();
      return app.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed;
    });
    if (['darwin', 'win32'].includes(process.platform)) assert.equal(sandboxed, true);
    console.log('Desktop starts with isolated renderer, sandbox and no Node access.');
  } finally {
    await client.close();
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
