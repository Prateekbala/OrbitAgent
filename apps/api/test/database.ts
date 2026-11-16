import { randomUUID } from 'node:crypto';
import { database, decodeDatabaseCertificate, type Database } from '@ao/database';

export async function testDatabase(): Promise<Database> {
  const connection = process.env.TEST_DATABASE_URL;
  if (!connection) return database();
  const tls = process.env.TEST_DATABASE_CA_CERT_BASE64
    ? { caCertificate: decodeDatabaseCertificate(process.env.TEST_DATABASE_CA_CERT_BASE64) }
    : {};
  const admin = await database({ url: connection, ...tls });
  const name = `ao_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(connection);
    url.pathname = '/' + name;
    const db = await database({ url: url.toString(), ...tls });
    return {
      query: db.query,
      transaction: db.transaction,
      async close() {
        try {
          await db.close();
          await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        } finally {
          await admin.close();
        }
      },
    };
  } catch (error) {
    await admin.close();
    throw error;
  }
}
