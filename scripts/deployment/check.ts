import { readFile } from 'node:fs/promises';
import {
  deploymentEnvironment,
  DeploymentConfigurationError,
} from '../../apps/api/src/deployment/environment.js';

const issues = new Set<string>();
for (const key of ['EVE_RUNTIME_URL', 'EVE_SERVICE_TOKEN'])
  if (!process.env[key]?.trim()) issues.add(`${key} is required for hosted agent execution`);
for (const role of ['api', 'worker'] as const) {
  try {
    deploymentEnvironment(role, { ...process.env, VERCEL_ENV: 'production' });
  } catch (error) {
    if (!(error instanceof DeploymentConfigurationError)) throw error;
    for (const issue of error.issues) issues.add(issue);
  }
}
try {
  const config = JSON.parse(
    await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'),
  ) as {
    services: {
      api: { functions: Record<string, { regions: string[] }> };
      worker: {
        functions: Record<
          string,
          { regions: string[]; experimentalTriggers: { type: string; topic: string }[] }
        >;
      };
    };
    daemons?: unknown;
  };
  const apiRegions = [
    ...new Set(Object.values(config.services.api.functions).flatMap((entry) => entry.regions)),
  ].sort();
  const workerRegions = [
    ...new Set(Object.values(config.services.worker.functions).flatMap((entry) => entry.regions)),
  ].sort();
  if (!apiRegions.length || JSON.stringify(apiRegions) !== JSON.stringify(workerRegions))
    issues.add('API and worker hosting regions must match in vercel.json');
  if (config.daemons) issues.add('On-demand deployment must not reserve an always-running daemon');
  if (
    !Object.values(config.services.worker.functions).some((entry) =>
      entry.experimentalTriggers.some(
        (trigger) => trigger.type === 'queue/v2beta' && trigger.topic === 'orbit-background-v1',
      ),
    )
  )
    issues.add('The background worker must have its private queue trigger');
} catch {
  issues.add('vercel.json must define valid API and worker regions');
}
if (issues.size) {
  console.error('Deployment configuration is incomplete:');
  for (const issue of issues) console.error('- ' + issue);
  process.exitCode = 1;
} else {
  console.log(
    'Deployment configuration checks passed. No credentials were printed and no database or provider requests were made.',
  );
  console.log(
    'Database roles, provider connectivity, and release acceptance still require independent verification.',
  );
}
