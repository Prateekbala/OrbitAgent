import { deploymentEnvironment } from './deployment/environment.js';
import { failStartup } from './deployment/startup.js';

try {
  process.env = deploymentEnvironment('api', process.env);
  await import('./server.js');
} catch (error) {
  failStartup(error);
}
