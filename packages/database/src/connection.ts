import { X509Certificate } from 'node:crypto';
import type { PoolConfig } from 'pg';

export function decodeDatabaseCertificate(encoded: string) {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 32768 || bytes.toString('base64') !== encoded)
    throw new Error(
      'DATABASE_CA_CERT_BASE64 must contain a base64-encoded database CA certificate.',
    );
  try {
    return new X509Certificate(bytes).toString();
  } catch {
    throw new Error('DATABASE_CA_CERT_BASE64 must contain a valid database CA certificate.');
  }
}

export function postgresPoolOptions(options: {
  url: string;
  maxConnections?: number;
  caCertificate?: string;
}): PoolConfig {
  const max = options.maxConnections ?? 10;
  if (!Number.isInteger(max) || max < 1 || max > 50)
    throw new Error('Database pool size must be an integer from 1 to 50.');
  let connectionString = options.url;
  let ssl: PoolConfig['ssl'];
  if (options.caCertificate) {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') !== 'verify-full')
      throw new Error('A custom database CA requires sslmode=verify-full.');
    for (const key of ['sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat'])
      if (url.searchParams.has(key))
        throw new Error('Configure the database CA through one source only.');
    url.searchParams.delete('sslmode');
    connectionString = url.toString();
    ssl = { ca: options.caCertificate, rejectUnauthorized: true };
  }
  return {
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    ...(ssl ? { ssl } : {}),
  };
}
