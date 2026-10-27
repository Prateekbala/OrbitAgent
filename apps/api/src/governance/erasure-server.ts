import { database, assertIsolatedServiceConnection } from '@ao/database';
import { configuredMedia } from '../calls/provider.js';
import { configuredFiles } from '../files/config.js';
import { OrganizationErasureWorker } from './organization-erasure.js';
if (!process.env.ERASURE_DATABASE_URL)
  throw new Error('Configure a dedicated erasure database login.');
const db = await database({ url: process.env.ERASURE_DATABASE_URL });
await assertIsolatedServiceConnection(db, 'ao_erasure');
const files = configuredFiles(process.env, process.cwd());
const worker = new OrganizationErasureWorker(
  db,
  files.store,
  process.env.CALL_RECORDING_DIRECTORY,
  (code) => process.stderr.write(JSON.stringify({ code }) + '\n'),
  configuredMedia(process.env),
);
const stop = worker.start();
const keepAlive = setInterval(() => {}, 15000);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    clearInterval(keepAlive);
    void stop().then(() => db.close());
  });
