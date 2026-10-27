import { database, migrate } from '@ao/database';
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error('Set MIGRATION_DATABASE_URL to a dedicated migration login.');
const db = await database({ url: process.env.MIGRATION_DATABASE_URL });
try {
  await migrate(db);
  console.log('Database migrations applied.');
} finally {
  await db.close();
}
