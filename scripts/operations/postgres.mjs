import { spawn } from 'node:child_process';
export function postgresEnvironment(value) {
  const u = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !u.hostname || !u.pathname.slice(1))
    throw new Error('A PostgreSQL connection is required.');
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: u.searchParams.get('sslmode') ?? 'prefer',
  };
}
export function postgresCommand(command, args, env, stdio = ['ignore', 'pipe', 'pipe']) {
  const child = spawn(command, args, { env, stdio });
  let diagnostic = '';
  child.stderr?.on('data', (v) => {
    if (diagnostic.length < 2000) diagnostic += String(v);
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', () =>
      reject(new Error('The required PostgreSQL client executable is unavailable.')),
    );
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              command +
                ' failed. Inspect the quarantined target with an operator; credentials and SQL output are intentionally omitted.',
            ),
          ),
    );
  });
  return { child, completed };
}
