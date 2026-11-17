import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'orbit-release-postgres-'));
const suffix = randomUUID().slice(0, 8);
const network = `orbit-release-${suffix}`;
const databaseNetwork = `${network}-host`;
const postgres = `orbit-release-db-${suffix}`;
const api = `orbit-release-api-${suffix}`;
const setup = `orbit-release-setup-${suffix}`;
const image = `orbit-release-check:${suffix}`;
const secrets = new Set();
let stage = 'Docker readiness';
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const run = async (program, args, options = {}) =>
  (
    await execute(program, args, {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
      signal: controller.signal,
      ...options,
    })
  ).stdout.trim();
const docker = (args) => run('docker', args);
const delay = () => new Promise((resolve) => setTimeout(resolve, 300));
const saveEnv = async (name, values) => {
  const path = join(directory, name);
  for (const [key, value] of Object.entries(values)) {
    if (/PASSWORD|SECRET|KEY|TOKEN|DATABASE_URL/.test(key)) secrets.add(value);
    if (key.endsWith('DATABASE_URL')) secrets.add(new URL(value).password);
  }
  await writeFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  return path;
};
async function healthy(container, port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker([
        'exec',
        container,
        'node',
        '-e',
        `fetch('http://127.0.0.1:${port}/health',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))`,
      ]);
      return;
    } catch {
      await delay();
    }
  }
  throw new Error('A disposable application container did not become healthy.');
}
try {
  if (process.argv.slice(2).some((value) => value !== '--skip-browser'))
    throw new Error('Unknown verification option.');
  await docker(['info', '--format', '{{.ServerVersion}}']);
  stage = 'production image build';
  console.log('Building the production API image for isolated verification.');
  await docker(['build', '--platform', 'linux/amd64', '-f', 'Dockerfile.vercel', '-t', image, '.']);
  stage = 'disposable PostgreSQL and TLS setup';
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=db',
    '-addext',
    'subjectAltName=DNS:db,DNS:localhost,IP:127.0.0.1',
    '-keyout',
    join(directory, 'db.key'),
    '-out',
    join(directory, 'db.crt'),
  ]);
  await docker(['network', 'create', '--internal', network]);
  await docker(['network', 'create', databaseNetwork]);
  const password = randomBytes(32).toString('base64url');
  const pgEnv = await saveEnv('postgres.env', { POSTGRES_PASSWORD: password });
  await docker([
    'run',
    '-d',
    '--name',
    postgres,
    '--network',
    databaseNetwork,
    '-p',
    '127.0.0.1::5432',
    '--env-file',
    pgEnv,
    'postgres:17.10',
  ]);
  await docker(['network', 'connect', '--alias', 'db', network, postgres]);
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      await docker(['exec', postgres, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      ready = true;
      break;
    } catch {
      await delay();
    }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready.');
  await docker(['cp', join(directory, 'db.key'), `${postgres}:/tmp/db.key`]);
  await docker(['cp', join(directory, 'db.crt'), `${postgres}:/tmp/db.crt`]);
  await docker([
    'exec',
    '-u',
    '0',
    postgres,
    'chown',
    'postgres:postgres',
    '/tmp/db.key',
    '/tmp/db.crt',
  ]);
  await docker(['exec', '-u', '0', postgres, 'chmod', '600', '/tmp/db.key']);
  for (const sql of [
    "ALTER SYSTEM SET ssl = 'on'",
    "ALTER SYSTEM SET ssl_cert_file = '/tmp/db.crt'",
    "ALTER SYSTEM SET ssl_key_file = '/tmp/db.key'",
    'SELECT pg_reload_conf()',
  ])
    await docker([
      'exec',
      postgres,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ]);
  const ca = (await readFile(join(directory, 'db.crt'))).toString('base64');
  const scoped = {
    API_DATABASE_URL: `postgresql://orbit_api:${randomBytes(32).toString('base64url')}@db:5432/postgres?sslmode=verify-full`,
    WORKER_DATABASE_URL: `postgresql://orbit_worker:${randomBytes(32).toString('base64url')}@db:5432/postgres?sslmode=verify-full`,
    DATABASE_CA_CERT_BASE64: ca,
  };
  const bootstrapEnv = await saveEnv('bootstrap.env', {
    ...scoped,
    MIGRATION_DATABASE_URL: `postgresql://postgres:${password}@db:5432/postgres?sslmode=verify-full`,
  });
  const bootstrap = [
    'run',
    '--rm',
    '--name',
    setup,
    '--network',
    network,
    '--env-file',
    bootstrapEnv,
    '--mount',
    `type=bind,src=${join(root, 'scripts/deployment')},dst=/app/scripts/deployment,readonly`,
    '--entrypoint',
    'node',
    image,
    '--import',
    'tsx',
    'scripts/deployment/prepare-database.ts',
  ];
  stage = 'database bootstrap';
  await docker(bootstrap);
  await docker(bootstrap);
  const sharedEnv = await saveEnv('shared.env', {
    DATABASE_URL: `postgresql://postgres:${password}@db:5432/postgres?sslmode=verify-full`,
    DATABASE_CA_CERT_BASE64: ca,
  });
  const sharedBootstrap = bootstrap.map((value) => (value === bootstrapEnv ? sharedEnv : value));
  await docker(sharedBootstrap);
  await docker(sharedBootstrap);
  stage = 'production API startup';
  console.log(
    'Verified migrations, repeatable runtime-login setup and certificate-verified database connections.',
  );
  const runtimeEnv = await saveEnv('runtime.env', {
    DATABASE_URL: `postgresql://postgres:${password}@db:5432/postgres?sslmode=verify-full`,
    DATABASE_CA_CERT_BASE64: ca,
    WEB_ORIGIN: 'https://orbit.example.test',
    IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    EMAIL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    REALTIME_CURSOR_KEY: randomBytes(32).toString('base64'),
    OPERATIONS_METRICS_TOKEN: randomBytes(32).toString('base64url'),
    GMAIL_USER: 'orbit-release@gmail.com',
    GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
    CLOUDINARY_CLOUD_NAME: 'orbit-test',
    CLOUDINARY_API_KEY: '123456789',
    CLOUDINARY_API_SECRET: 'synthetic-cloudinary-secret',
    GROQ_API_KEY: 'synthetic-groq-key',
    VERCEL: '1',
    VERCEL_ENV: 'production',
  });
  stage = 'private on-demand worker bootstrap';
  await docker([
    'run',
    '--rm',
    '--network',
    network,
    '--read-only',
    '--tmpfs',
    '/tmp:uid=1000,gid=1000,mode=0700',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--env-file',
    runtimeEnv,
    '--entrypoint',
    'node',
    image,
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    `
      const {createApplication}=await import('./apps/api/src/bootstrap.ts');
      const {deploymentEnvironment}=await import('./apps/api/src/deployment/environment.ts');
      const {dispatcherScope}=await import('@ao/database');
      const messages=[];
      const {app,db,background}=await createApplication(deploymentEnvironment('worker',process.env),{
        backgroundPublisher:{async publish(message){messages.push(message);}}
      });
      try {
        if(app.server.listening||!background) throw new Error('Worker must be on demand and private');
        await background.publish();
        const message=messages.find(message=>message.worker==='email');
        if(!message||messages.length<20) throw new Error('Worker registry was not initialized');
        await background.run(message);
        const [row]=await dispatcherScope(()=>db.query("SELECT last_completed_at FROM background_schedules WHERE worker='email'"));
        if(!row?.last_completed_at) throw new Error('Worker did not complete its bounded tick');
      } finally {await app.close();await db.close();}
    `,
  ]);
  console.log(
    'Verified the production worker starts without a listener or polling loop and completes an on-demand tick.',
  );
  for (const name of [api]) {
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      network,
      '--read-only',
      '--tmpfs',
      '/tmp:uid=1000,gid=1000,mode=0700',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--env-file',
      runtimeEnv,
    ];
    args.push(image);
    await docker(args);
    await healthy(name, 3000);
    if ((await docker(['exec', name, 'id', '-u'])) === '0')
      throw new Error('Application containers must not run as root.');
  }
  const port = await docker([
    'inspect',
    '--format',
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    postgres,
  ]);
  const testEnvironment = {
    ...process.env,
    TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=verify-full`,
    TEST_DATABASE_CA_CERT_BASE64: ca,
  };
  stage = 'PostgreSQL background durability tests';
  await run(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'test/background.test.ts'],
    {
      cwd: join(root, 'apps/api'),
      env: testEnvironment,
    },
  );
  if (!process.argv.includes('--skip-browser')) {
    stage = 'PostgreSQL browser flow';
    console.log(
      'Testing the browser signup-to-approval flow against isolated PostgreSQL with verified TLS.',
    );
    await run(process.execPath, ['scripts/verification/release-flow.mjs'], {
      env: testEnvironment,
    });
  }
  for (const name of [api]) {
    stage = 'graceful shutdown';
    await docker(['stop', '-t', '20', name]);
    if ((await docker(['inspect', '--format', '{{.State.ExitCode}}', name])) !== '0')
      throw new Error('Application shutdown did not drain cleanly.');
  }
  console.log(
    JSON.stringify({
      verifiedDatabaseTLS: true,
      idempotentBootstrap: true,
      restrictedRuntimeLogins: true,
      sharedConnectionRLS: true,
      nonRootReadOnlyContainers: true,
      onDemandBackground: true,
      gracefulShutdown: true,
      browserFlow: !process.argv.includes('--skip-browser'),
      liveProviders: false,
    }),
  );
} catch (error) {
  if (error && typeof error === 'object' && ('stdout' in error || 'stderr' in error)) {
    let output = [error.stdout, error.stderr]
      .filter((value) => typeof value === 'string')
      .join('\n');
    for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length))
      output = output.split(secret).join('[redacted]');
    const logs = join(root, '.data/release-checks');
    await mkdir(logs, { recursive: true, mode: 0o700 });
    const diagnostic = join(logs, `${suffix}.log`);
    await writeFile(diagnostic, `${stage}\n${output.slice(-32768)}\n`, { mode: 0o600 });
    console.error(`Redacted verification output: ${diagnostic}`);
  }
  console.error(
    error instanceof Error && !('cmd' in error)
      ? error.message
      : `Isolated PostgreSQL release verification failed during ${stage}. Check Docker, build output and deployment setup. Credentials were not printed.`,
  );
  process.exitCode = 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
  for (const name of [setup, api, postgres])
    await execute('docker', ['rm', '-fv', name], { timeout: 15000 }).catch(() => {});
  await execute('docker', ['network', 'rm', network], { timeout: 15000 }).catch(() => {});
  await execute('docker', ['network', 'rm', databaseNetwork], { timeout: 15000 }).catch(() => {});
  await execute('docker', ['image', 'rm', image], { timeout: 15000 }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
