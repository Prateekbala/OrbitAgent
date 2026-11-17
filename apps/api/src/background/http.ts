import type { FastifyInstance } from 'fastify';
import type { BackgroundDispatcher } from './dispatcher.js';

export function backgroundWakeups(app: FastifyInstance, background: BackgroundDispatcher) {
  app.addHook('onSend', async (request, _reply, payload) => {
    if (!request.url.startsWith('/v1/realtime')) {
      try {
        await background.publish();
      } catch {
        app.log.error({ code: 'BACKGROUND_PUBLISH_FAILED' }, 'Background wake-up remains pending');
      }
    }
    return payload;
  });
}
