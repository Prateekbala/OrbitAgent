import { createApplication } from '../bootstrap.js';
import { deploymentEnvironment } from '../deployment/environment.js';

let instance: Promise<import('./dispatcher.js').BackgroundDispatcher> | undefined;
export function serverlessBackground() {
  instance ??= (async () => {
    const { background } = await createApplication(deploymentEnvironment('worker', process.env));
    if (!background) throw new Error('On-demand background execution is not configured.');
    return background;
  })().catch((error: unknown) => {
    instance = undefined;
    throw error;
  });
  return instance;
}
