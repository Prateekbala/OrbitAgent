import { defineConfig } from '@playwright/test';
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PLAYWRIGHT_PORT must be an integer between 1 and 65535.');
}
const baseURL = `http://localhost:${port}`;
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  webServer: {
    command: `${process.env.CI ? 'npm run start -w @ao/web' : 'npm run dev -w @ao/web'} -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
