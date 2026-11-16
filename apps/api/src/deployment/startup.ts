import { DeploymentConfigurationError } from './environment.js';

export function failStartup(error: unknown): never {
  const message =
    error instanceof DeploymentConfigurationError
      ? error.message
      : 'Deployment startup failed. Check configuration, database roles, migrations and dependency connectivity.';
  process.stderr.write(
    JSON.stringify({ level: 'error', code: 'DEPLOYMENT_STARTUP_FAILED', message }) + '\n',
  );
  process.exit(1);
}
