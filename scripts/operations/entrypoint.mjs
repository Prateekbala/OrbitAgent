import { readFile } from 'node:fs/promises';
import { register } from 'tsx/esm/api';
import { pathToFileURL } from 'node:url';
const permitted = [
  'DATABASE_URL',
  'ERASURE_DATABASE_URL',
  'MODEL_BROKER_DATABASE_URL',
  'IDENTITY_ENCRYPTION_KEY',
  'IDENTITY_PREVIOUS_KEYS_JSON',
  'EMAIL_ENCRYPTION_KEY',
  'REALTIME_CURSOR_KEY',
  'EVE_SERVICE_TOKEN',
  'RESEND_API_KEY',
  'OPERATIONS_METRICS_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
];
for (const name of permitted) {
  const file = process.env[name + '_FILE'];
  if (!file) continue;
  if (process.env[name])
    throw new Error('Configure each protected value through exactly one source.');
  const value = await readFile(file, 'utf8');
  if (!value.trim() || value.length > 16384)
    throw new Error('A required protected configuration file is invalid.');
  process.env[name] = value.trim();
}
register();
await import(pathToFileURL(process.argv[2] ?? 'apps/api/src/server.ts').href);
