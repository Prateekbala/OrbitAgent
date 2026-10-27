import type { BrowserContext, Page, Route } from '@playwright/test';
import type { FastifyInstance } from 'fastify';

export const browserOrigin = `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3000}`;

export function allowBrowserStreams(server: FastifyInstance) {
  server.addHook('onRequest', async (_req, reply) => {
    reply
      .header('access-control-allow-origin', browserOrigin)
      .header('access-control-allow-credentials', 'true');
  });
}
export async function proxyApi(target: BrowserContext | Page, origin: string) {
  await target.route('**/api/**', async (route: Route) => {
    const page = route.request().frame().page();
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '') + url.search;
    if (
      url.pathname.endsWith('/events/stream') ||
      (route.request().method() === 'GET' &&
        /^\/api\/v1\/files\/[^/]+\/content$/.test(url.pathname))
    ) {
      await route.continue({ url: origin.replace('127.0.0.1', 'localhost') + path });
    } else {
      try {
        const response = await route.fetch({ url: origin + path, maxRedirects: 0 });
        try {
          const body = await response.body();
          if (!page.isClosed())
            await route.fulfill({ status: response.status(), headers: response.headers(), body });
        } finally {
          await response.dispose().catch(() => {});
        }
      } catch (error) {
        const settled =
          error instanceof Error && error.message.includes('Route is already handled');
        if (!settled && !page.isClosed() && !route.request().failure()) throw error;
      }
    }
  });
}
