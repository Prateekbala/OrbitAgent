import { database, migrate, assertRuntimeConnection, type Database } from '@ao/database';
import { databaseConfiguration } from './database-configuration.js';

let owner: Database | undefined;
let stage = 'configuration';
try {
  const config = databaseConfiguration(process.env);
  owner = await database({ url: config.ownerUrl, maxConnections: 1, ...config.tls });
  stage = 'migrations';
  await migrate(owner);
  stage = 'runtime role setup';
  await owner.transaction(async (tx) => {
    for (const credential of config.credentials) {
      const [existing] = await tx.query(
        'SELECT rolsuper,rolinherit,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolcanlogin FROM pg_roles WHERE rolname=$1',
        [credential.name],
      );
      if (existing) {
        const [authority] = await tx.query(
          "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND pg_has_role($1,c.relowner,'MEMBER')) owns, pg_has_role($1,'ao_erasure','MEMBER') OR pg_has_role($1,'ao_model_broker','MEMBER') isolated",
          [credential.name],
        );
        if (
          !existing.rolcanlogin ||
          existing.rolsuper ||
          existing.rolinherit ||
          existing.rolbypassrls ||
          existing.rolcreaterole ||
          existing.rolcreatedb ||
          existing.rolreplication ||
          authority?.owns ||
          authority?.isolated
        )
          throw new Error('Existing runtime login is privileged.');
      } else {
        const [command] = await tx.query(
          "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) command",
          [credential.name, credential.password],
        );
        await tx.query(String(command!.command));
      }
      await tx.query(`GRANT ao_runtime,ao_identity,ao_dispatcher,ao_worker TO ${credential.name}`);
    }
  });
  stage = 'runtime connection verification';
  if (config.shared) await assertRuntimeConnection(owner, { sharedLogin: true });
  for (const credential of config.credentials) {
    const runtime = await database({ url: credential.url, maxConnections: 1, ...config.tls });
    try {
      await assertRuntimeConnection(runtime);
    } finally {
      await runtime.close();
    }
  }
  console.log(
    config.shared
      ? 'Migrations completed and the shared connection verified with active tenant RLS. API, worker and migrations share credential authority.'
      : 'Migrations completed and both restricted runtime connections verified. Existing passwords were not rotated.',
  );
} catch {
  console.error(
    `Database setup failed during ${stage}. Check DATABASE_URL (or the separate legacy URLs), TLS certificate and role permissions. Credentials were not printed. Completed migrations remain applied.`,
  );
  process.exitCode = 1;
} finally {
  await owner?.close().catch(() => {
    process.exitCode = 1;
  });
}
