import { createApplication } from './bootstrap.js';

const { app, db, processRole } = await createApplication();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
if (processRole !== 'worker')
  await app.listen({
    port: Number(process.env.API_PORT ?? 4000),
    host: process.env.API_HOST ?? '127.0.0.1',
  });
