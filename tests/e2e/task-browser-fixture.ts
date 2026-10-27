import type { BrowserContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { messagingFixture } from '../../apps/api/test/messaging-fixture.js';
import type { FileDependencies } from '../../apps/api/src/files/config.js';
import { allowBrowserStreams, proxyApi, browserOrigin } from './api-proxy.js';
export async function taskBrowserFixture(
  files?: FileDependencies,
  options: Parameters<typeof messagingFixture>[2] = {},
) {
  const f = await messagingFixture(files, allowBrowserStreams, {
    origin: browserOrigin,
    ...options,
  });
  const origin = (await f.app.listen({ host: '127.0.0.1', port: 0 })).replace(
    '127.0.0.1',
    'localhost',
  );
  return {
    ...f,
    async close() {
      const closing = f.close();
      f.app.server.closeAllConnections();
      await closing;
    },
    async connect(context: BrowserContext, session = f.owner) {
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
    },
    async createTask(title: string, input: Record<string, unknown> = {}) {
      const r = await f.call(f.owner, 'POST', '/v1/tasks', { title, ...input });
      expect(r.statusCode, r.body).toBe(201);
      return r.json<{ id: string }>().id;
    },
  };
}
