import { database, migrate, type Database } from '@ao/database';
import { migrationConfiguration } from './database-configuration.js';

let db: Database | undefined;
try {
  const config = migrationConfiguration(process.env);
  db = await database({ url: config.ownerUrl, maxConnections: 1, ...config.tls });
  await migrate(db);
  console.log('Database migrations applied.');
} catch {
  console.error(
    'Deployment migration failed. Check DATABASE_URL (or MIGRATION_DATABASE_URL), verified TLS and migration permissions. Credentials were not printed.',
  );
  process.exitCode = 1;
} finally {
  await db?.close().catch(() => {
    process.exitCode = 1;
  });
}
