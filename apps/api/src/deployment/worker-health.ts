import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';

export async function startWorkerHealth(port = 8081, heartbeat = '/tmp/orbit-worker-heartbeat') {
  let draining = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404).end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    let healthy = false;
    try {
      const age = Date.now() - (await stat(heartbeat)).mtimeMs;
      healthy = !draining && age >= 0 && age < 45000;
    } catch {}
    response
      .writeHead(healthy ? 200 : 503)
      .end(JSON.stringify({ status: healthy ? 'ok' : 'unavailable' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    async close() {
      draining = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
