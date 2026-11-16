import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deploymentEnvironment,
  DeploymentConfigurationError,
} from '../../apps/api/src/deployment/environment.js';
import { startWorkerHealth } from '../../apps/api/src/deployment/worker-health.js';
import { configuredEmail } from '../../apps/api/src/email/service.js';
import {
  databaseConfiguration,
  migrationConfiguration,
} from '../../scripts/deployment/database-configuration.js';

const fixture: Partial<NodeJS.ProcessEnv> = {
  API_DATABASE_URL:
    'postgresql://orbit_api:' + 'a'.repeat(40) + '@db.example.test/postgres?sslmode=verify-full',
  WORKER_DATABASE_URL:
    'postgresql://orbit_worker:' + 'b'.repeat(40) + '@db.example.test/postgres?sslmode=verify-full',
  MIGRATION_DATABASE_URL:
    'postgresql://postgres:' + 'c'.repeat(40) + '@db.example.test/postgres?sslmode=verify-full',
  WEB_ORIGIN: 'https://orbit.example.test',
  DEPLOYMENT_REGION: 'in',
  IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  EMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
  REALTIME_CURSOR_KEY: Buffer.alloc(32, 3).toString('base64'),
  OPERATIONS_METRICS_TOKEN: 'synthetic-metrics-token-at-least-32-characters',
  EMAIL_PROVIDER: 'resend',
  EMAIL_FROM: 'team@example.test',
  RESEND_API_KEY: 'synthetic-resend-key',
  FILE_STORAGE_PROVIDER: 'cloudinary',
  CLOUDINARY_CLOUD_NAME: 'orbit-test',
  CLOUDINARY_API_KEY: '123456789',
  CLOUDINARY_API_SECRET: 'synthetic-cloudinary-secret',
  GROQ_API_KEY: 'synthetic-groq-key',
  EVE_RUNTIME_URL: 'https://runtime.example.test',
  EVE_SERVICE_TOKEN: 'synthetic-runtime-service-token-32-characters',
  AGENT_MODEL: 'groq/openai/gpt-oss-120b',
  AGENT_APPROVED_MODELS: 'groq/openai/gpt-oss-120b',
  AGENT_MODEL_PRICING_JSON:
    '{"groq/openai/gpt-oss-120b":{"inputMicrosPerMillion":150000,"outputMicrosPerMillion":600000}}',
  RETRIEVAL_ANSWER_MODEL: 'groq/openai/gpt-oss-120b',
};
const runtimeFixture = { ...fixture };
delete runtimeFixture.MIGRATION_DATABASE_URL;
const minimalFixture: Partial<NodeJS.ProcessEnv> = {
  DATABASE_URL: fixture.MIGRATION_DATABASE_URL,
  WEB_ORIGIN: fixture.WEB_ORIGIN,
  IDENTITY_ENCRYPTION_KEY: fixture.IDENTITY_ENCRYPTION_KEY,
  EMAIL_ENCRYPTION_KEY: fixture.EMAIL_ENCRYPTION_KEY,
  REALTIME_CURSOR_KEY: fixture.REALTIME_CURSOR_KEY,
  OPERATIONS_METRICS_TOKEN: fixture.OPERATIONS_METRICS_TOKEN,
  GMAIL_USER: 'team@gmail.com',
  GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
  CLOUDINARY_CLOUD_NAME: fixture.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: fixture.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: fixture.CLOUDINARY_API_SECRET,
  GROQ_API_KEY: fixture.GROQ_API_KEY,
  EVE_RUNTIME_URL: fixture.EVE_RUNTIME_URL,
  EVE_SERVICE_TOKEN: fixture.EVE_SERVICE_TOKEN,
};
const execute = promisify(execFile);
const script = (name: string) =>
  fileURLToPath(new URL('../../scripts/deployment/' + name, import.meta.url));

test('minimal deployment credentials enable the selected providers with bounded model defaults', () => {
  for (const role of ['api', 'worker'] as const) {
    const env = deploymentEnvironment(role, minimalFixture);
    assert.equal(env.EMAIL_PROVIDER, 'gmail');
    assert.equal(env.EMAIL_FROM, minimalFixture.GMAIL_USER);
    assert.equal(env.FILE_STORAGE_PROVIDER, 'cloudinary');
    assert.equal(env.DEPLOYMENT_REGION, 'in');
    assert.equal(env.AGENT_MODEL, 'groq/openai/gpt-oss-120b');
    assert.equal(env.AGENT_APPROVED_MODELS, env.AGENT_MODEL);
    assert.equal(env.RETRIEVAL_ANSWER_MODEL, env.AGENT_MODEL);
    assert.deepEqual(JSON.parse(env.AGENT_MODEL_PRICING_JSON!), {
      'groq/openai/gpt-oss-120b': {
        inputMicrosPerMillion: 150000,
        outputMicrosPerMillion: 600000,
      },
    });
    assert.equal(env.DATABASE_POOL_MAX, role === 'api' ? '1' : '5');
    assert.equal(env.DATABASE_URL, minimalFixture.DATABASE_URL);
    assert.equal(env.DATABASE_CONNECTION_MODE, 'shared');
    const email = configuredEmail(env, env.WEB_ORIGIN!);
    assert.equal(email.provider?.id, 'gmail');
    assert.doesNotThrow(() => email.requireConfigured());
  }
  assert.equal(minimalFixture.AGENT_MODEL, undefined);
  assert.throws(
    () => deploymentEnvironment('api', { ...minimalFixture, AGENT_MODEL: 'other/model' }),
    /rates for AGENT_MODEL/,
  );
  for (const key of [
    'IDENTITY_ENCRYPTION_KEY',
    'EMAIL_ENCRYPTION_KEY',
    'REALTIME_CURSOR_KEY',
    'OPERATIONS_METRICS_TOKEN',
    'GMAIL_APP_PASSWORD',
  ])
    assert.throws(
      () => deploymentEnvironment('api', { ...minimalFixture, [key]: '' }),
      new RegExp(key),
    );
});

test('API and worker select separate credentials and reject privileged secrets', () => {
  for (const role of ['api', 'worker'] as const) {
    const selected = deploymentEnvironment(role, runtimeFixture);
    assert.equal(selected.PROCESS_ROLE, role);
    assert.equal(
      selected.DATABASE_URL,
      role === 'api' ? fixture.API_DATABASE_URL : fixture.WORKER_DATABASE_URL,
    );
    assert.equal(selected.FILE_STAGING_DIRECTORY, '/tmp/orbit-uploads');
    assert.equal(selected.API_DATABASE_URL, undefined);
    assert.equal(selected.WORKER_DATABASE_URL, undefined);
  }
  assert.equal(runtimeFixture.API_DATABASE_URL, fixture.API_DATABASE_URL);
  for (const change of [
    { MIGRATION_DATABASE_URL: fixture.MIGRATION_DATABASE_URL },
    { DATABASE_URL: fixture.API_DATABASE_URL },
    { BYOK_WRAPPING_PRIVATE_KEY_FILES: '/private/key' },
    { WEB_ORIGIN: 'http://orbit.example.test' },
    { API_DATABASE_URL: fixture.API_DATABASE_URL!.replace('verify-full', 'disable') },
    { API_DATABASE_URL: fixture.API_DATABASE_URL!.replace('orbit_api:', 'postgres:') },
    { DEPLOYMENT_REGION: 'bom1' },
    { FILE_STORAGE_PROVIDER: 'local' },
  ])
    assert.throws(
      () => deploymentEnvironment('api', { ...runtimeFixture, ...change }),
      (error) => {
        assert.ok(error instanceof DeploymentConfigurationError);
        assert.ok(!error.message.includes('a'.repeat(40)));
        assert.ok(!error.message.includes('c'.repeat(40)));
        return true;
      },
    );
  assert.throws(
    () => deploymentEnvironment('worker', { ...runtimeFixture, VERCEL_ENV: 'preview' }),
    /previews/,
  );
});

test('Groq and Cloudinary configuration fails closed without their credentials', () => {
  assert.throws(
    () => deploymentEnvironment('api', { ...runtimeFixture, GROQ_API_KEY: '' }),
    /GROQ_API_KEY/,
  );
  assert.throws(
    () => deploymentEnvironment('api', { ...runtimeFixture, CLOUDINARY_API_SECRET: '' }),
    /CLOUDINARY_API_SECRET/,
  );
  assert.throws(
    () =>
      deploymentEnvironment('api', { ...runtimeFixture, RETRIEVAL_OCR_MODEL: fixture.AGENT_MODEL }),
    /separate image/,
  );
  assert.throws(
    () =>
      deploymentEnvironment('api', {
        ...runtimeFixture,
        RETRIEVAL_EMBEDDING_MODEL: fixture.AGENT_MODEL,
      }),
    /embedding provider/,
  );
});

test('database setup requires verified TLS and separate, strong runtime credentials', () => {
  const config = databaseConfiguration(fixture);
  assert.deepEqual(
    config.credentials.map((item) => item.name),
    ['orbit_api', 'orbit_worker'],
  );
  assert.deepEqual(migrationConfiguration(fixture).tls, {});
  for (const change of [
    { MIGRATION_DATABASE_URL: 'https://owner.example.test' },
    { MIGRATION_DATABASE_URL: fixture.API_DATABASE_URL },
    { MIGRATION_DATABASE_URL: fixture.MIGRATION_DATABASE_URL!.replace('verify-full', 'disable') },
    { API_DATABASE_URL: fixture.API_DATABASE_URL!.replace('orbit_api:', 'postgres:') },
    { API_DATABASE_URL: fixture.API_DATABASE_URL!.replace('a'.repeat(40), 'short') },
    { WORKER_DATABASE_URL: fixture.WORKER_DATABASE_URL!.replace('b'.repeat(40), 'a'.repeat(40)) },
    { DATABASE_CA_CERT_BASE64: 'not-a-certificate' },
  ])
    assert.throws(
      () => databaseConfiguration({ ...fixture, ...change }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('a'.repeat(40)));
        assert.ok(!error.message.includes('c'.repeat(40)));
        return true;
      },
    );
});

test('one session URL configures both runtime processes and database setup', () => {
  const config = databaseConfiguration(minimalFixture);
  assert.equal(config.shared, true);
  assert.equal(config.ownerUrl, minimalFixture.DATABASE_URL);
  assert.deepEqual(config.credentials, []);
  assert.equal(migrationConfiguration(minimalFixture).ownerUrl, minimalFixture.DATABASE_URL);
  assert.throws(
    () => databaseConfiguration({ ...minimalFixture, API_DATABASE_URL: fixture.API_DATABASE_URL }),
    /alone/,
  );
  assert.throws(
    () =>
      deploymentEnvironment('api', {
        ...minimalFixture,
        DATABASE_URL: minimalFixture.DATABASE_URL!.replace('verify-full', 'disable'),
      }),
    /verify-full/,
  );
  assert.throws(
    () =>
      deploymentEnvironment('api', {
        ...minimalFixture,
        MIGRATION_DATABASE_URL: fixture.MIGRATION_DATABASE_URL,
      }),
    /must not be included/,
  );
});

test('deployment commands and referenced setup artifacts all exist', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  for (const name of ['deploy:check', 'deploy:keys', 'deploy:migrate', 'deploy:database']) {
    const path = pkg.scripts[name]!.match(/scripts\/deployment\/[a-z-]+\.(?:mjs|ts)/)?.[0];
    assert.ok(path, name + ' must reference a deployment script');
    assert.ok((await stat(new URL('../../' + path, import.meta.url))).isFile());
  }
  for (const path of [
    'Dockerfile.vercel',
    'apps/api/src/vercel.ts',
    'apps/api/src/vercel-worker.ts',
    'scripts/verification/postgres-release.mjs',
    'scripts/verification/release-flow.mjs',
  ])
    assert.ok((await stat(new URL('../../' + path, import.meta.url))).isFile());
});

test('service routing strips the API prefix and keeps the worker private', async () => {
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.services.api.entrypoint, 'src/vercel.ts');
  assert.deepEqual(config.services.api.rewrites, [
    { source: '/api/:path*', destination: '/:path*' },
  ]);
  assert.equal(config.rewrites[0].source, '/api/internal/:path*');
  assert.ok(
    !config.rewrites.some(
      (entry: { destination: { service: string } }) => entry.destination.service === 'worker',
    ),
  );
  assert.deepEqual(
    config.services.api.functions['src/vercel.ts'].regions,
    Object.keys(config.daemons.worker.instances),
  );
  assert.equal(config.daemons.worker.entrypoint, 'Dockerfile.vercel');
});

test('configuration checker succeeds without network access and never prints credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-deploy-check-'));
  try {
    const result = await execute(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), script('check.ts')],
      { cwd: directory, env: minimalFixture },
    );
    assert.match(result.stdout, /checks passed/);
    assert.ok(!result.stdout.includes('synthetic-groq-key'));
    await assert.rejects(
      execute(process.execPath, ['--import', import.meta.resolve('tsx'), script('check.ts')], {
        cwd: directory,
        env: {},
      }),
      (error: unknown) => {
        assert.ok(error && typeof error === 'object' && 'stderr' in error);
        assert.match(String(error.stderr), /DATABASE_URL is required/);
        return true;
      },
    );
    await assert.rejects(
      execute(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), script('prepare-database.ts')],
        {
          cwd: directory,
          env: {
            MIGRATION_DATABASE_URL:
              'postgresql://postgres:synthetic-secret@invalid/?sslmode=disable',
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error && typeof error === 'object' && 'stderr' in error);
        assert.match(String(error.stderr), /failed during configuration/);
        assert.ok(!String(error.stderr).includes('synthetic-secret'));
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generated encryption keys are private and cannot overwrite existing deployments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-deploy-keys-'));
  try {
    const result = await execute(process.execPath, [script('generate-keys.mjs')], {
      cwd: directory,
    });
    const path = join(directory, '.env.vercel.keys.local');
    const original = await readFile(path, 'utf8');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    for (const value of Object.values(parseEnv(original))) {
      assert.ok(typeof value === 'string');
      assert.ok(!result.stdout.includes(value));
    }
    await assert.rejects(
      execute(process.execPath, [script('generate-keys.mjs')], { cwd: directory }),
    );
    assert.equal(await readFile(path, 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('private worker liveness fails on stale or missing heartbeats', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-worker-probe-'));
  const heartbeat = join(directory, 'heartbeat');
  await writeFile(heartbeat, 'ready');
  const health = await startWorkerHealth(0, heartbeat);
  try {
    const address = health.server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.equal((await fetch(url + '/v1/runs')).status, 404);
    const stale = new Date(Date.now() - 60000);
    await utimes(heartbeat, stale, stale);
    assert.equal((await fetch(url + '/health')).status, 503);
    await rm(heartbeat);
    assert.equal((await fetch(url + '/health')).status, 503);
  } finally {
    await health.close();
    await rm(directory, { recursive: true, force: true });
  }
});
