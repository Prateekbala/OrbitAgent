import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const values = {
  IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  EMAIL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  REALTIME_CURSOR_KEY: randomBytes(32).toString('base64'),
  OPERATIONS_METRICS_TOKEN: randomBytes(32).toString('base64url'),
  EVE_SERVICE_TOKEN: randomBytes(32).toString('base64url'),
};
try {
  await writeFile(
    '.env.vercel.keys.local',
    Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n') + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    'Deployment keys saved privately in .env.vercel.keys.local. Preserve these keys across deployments; do not commit them.',
  );
} catch (error) {
  if (error?.code !== 'EEXIST') {
    console.error(
      'Could not save deployment keys. Check directory permissions. No keys were printed.',
    );
  } else console.error('Deployment key file already exists. Existing keys were not changed.');
  process.exitCode = 1;
}
