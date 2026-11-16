import { deploymentEnvironment } from './deployment/environment.js';
import { startWorkerHealth } from './deployment/worker-health.js';
import { failStartup } from './deployment/startup.js';

try {
  process.env = deploymentEnvironment('worker', process.env);
  await import('./server.js');
  const health = await startWorkerHealth();
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void health.close().catch(() => {});
    });
} catch (error) {
  failStartup(error);
}
