import { decodeDatabaseCertificate } from '@ao/database';

function connection(value: string | undefined, name: string) {
  try {
    if (!value) throw new Error();
    const url = new URL(value);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      url.hash ||
      url.searchParams.get('sslmode') !== 'verify-full'
    )
      throw new Error();
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return { value, url };
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL with credentials and sslmode=verify-full.`);
  }
}

export function migrationConfiguration(env: Partial<NodeJS.ProcessEnv>) {
  const key = env.DATABASE_URL ? 'DATABASE_URL' : 'MIGRATION_DATABASE_URL';
  const owner = connection(env[key], key);
  return {
    ownerUrl: owner.value,
    tls: env.DATABASE_CA_CERT_BASE64
      ? { caCertificate: decodeDatabaseCertificate(env.DATABASE_CA_CERT_BASE64) }
      : {},
  };
}

export function databaseConfiguration(env: Partial<NodeJS.ProcessEnv>) {
  const migration = migrationConfiguration(env);
  if (env.DATABASE_URL) {
    if (env.API_DATABASE_URL || env.WORKER_DATABASE_URL || env.MIGRATION_DATABASE_URL)
      throw new Error('Use DATABASE_URL alone when sharing the database connection.');
    return { ...migration, shared: true, credentials: [] };
  }
  if (
    ['orbit_api', 'orbit_worker'].includes(
      decodeURIComponent(new URL(migration.ownerUrl).username).split('.')[0]!,
    )
  )
    throw new Error('MIGRATION_DATABASE_URL must use a separate operator login.');
  const credentials = (['orbit_api', 'orbit_worker'] as const).map((name, index) => {
    const key = index === 0 ? 'API_DATABASE_URL' : 'WORKER_DATABASE_URL';
    const { url, value } = connection(env[key], key);
    const password = decodeURIComponent(url.password);
    if (
      decodeURIComponent(url.username).split('.')[0] !== name ||
      password.length < 32 ||
      password.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(password)
    )
      throw new Error(
        `${key} must use its documented login and a 32–256 character password without control characters.`,
      );
    return { name, password, url: value };
  });
  if (credentials[0]!.password === credentials[1]!.password)
    throw new Error('API_DATABASE_URL and WORKER_DATABASE_URL must use different passwords.');
  return { ...migration, shared: false, credentials };
}
