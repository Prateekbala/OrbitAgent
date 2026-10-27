import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { statements } from './statements.js';
export * from './scope.js';
export { statements } from './statements.js';
export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}
export interface Database extends Sql {
  transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function database(
  options: { url?: string; directory?: string; onPoolError?: (code: string) => void } = {},
): Promise<Database> {
  if (options.url) {
    const pool = new pg.Pool({
      connectionString: options.url,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
    pool.on('error', (error) => {
      const code = (error as { code?: string }).code;
      options.onPoolError?.(code && /^[A-Z0-9]{5}$/.test(code) ? code : 'DATABASE_POOL_ERROR');
    });
    const query = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await pool.query(sql, params)).rows as T[];
    return {
      query,
      async transaction(work) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work({
            query: async (sql, params = []) => (await client.query(sql, params)).rows,
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (options.directory) await mkdir(dirname(options.directory), { recursive: true });
  const db = new PGlite(options.directory ?? 'memory://');
  await db.waitReady;
  return {
    query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await db.query<T>(sql, params)).rows,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
            (await tx.query<T>(sql, params)).rows,
        }),
      ),
    close: () => db.close(),
  };
}
export async function migrate(db: Database) {
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^\d+_[a-z_]+\.sql$/.test(file)).sort();
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(842110)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of files) {
      const version = Number(file.split('_')[0]);
      if (
        (await tx.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).length
      )
        continue;
      const sql = await readFile(new URL(file, directory), 'utf8');
      for (const statement of statements(sql)) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
    }
  });
}
