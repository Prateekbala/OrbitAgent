import { readFile } from 'node:fs/promises';
import { database, assertIsolatedServiceConnection } from '@ao/database';
import { buildModelBroker } from './app.js';
if (
  !process.env.MODEL_BROKER_DATABASE_URL ||
  !process.env.BYOK_WRAPPING_PRIVATE_KEY_FILES ||
  !process.env.BYOK_CAPABILITY_VERIFY_KEY_FILE
)
  throw new Error(
    'Configure the isolated broker login, wrapping keys and capability verification key.',
  );
const db = await database({ url: process.env.MODEL_BROKER_DATABASE_URL });
await assertIsolatedServiceConnection(db, 'ao_model_broker');
const files = JSON.parse(process.env.BYOK_WRAPPING_PRIVATE_KEY_FILES) as unknown;
if (
  !Array.isArray(files) ||
  files.length < 1 ||
  files.length > 8 ||
  files.some((f) => typeof f !== 'string')
)
  throw new Error('Configure one active and at most seven retained wrapping key files.');
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.MODEL_BROKER_TLS_KEY_FILE || !process.env.MODEL_BROKER_TLS_CERT_FILE)
)
  throw new Error('Production model broker requires its dedicated TLS certificate.');
const https =
  process.env.MODEL_BROKER_TLS_KEY_FILE && process.env.MODEL_BROKER_TLS_CERT_FILE
    ? {
        key: await readFile(process.env.MODEL_BROKER_TLS_KEY_FILE, 'utf8'),
        cert: await readFile(process.env.MODEL_BROKER_TLS_CERT_FILE, 'utf8'),
      }
    : undefined;
const app = buildModelBroker(db, {
  ...(https ? { https } : {}),
  verifyKey: await readFile(process.env.BYOK_CAPABILITY_VERIFY_KEY_FILE, 'utf8'),
  privateKeys: await Promise.all(files.map((f) => readFile(f, 'utf8'))),
});
for (const s of ['SIGINT', 'SIGTERM'] as const)
  process.once(s, () => void app.close().then(() => db.close()));
await app.listen({
  host: process.env.MODEL_BROKER_HOST ?? '127.0.0.1',
  port: Number(process.env.MODEL_BROKER_PORT ?? 4010),
});
