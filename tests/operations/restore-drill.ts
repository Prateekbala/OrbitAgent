import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { database } from '@ao/database';
import { messagingFixture } from '../../apps/api/test/messaging-fixture.js';
const exec = promisify(execFile),
  suffix = randomUUID().replaceAll('-', ''),
  container = 'orbit-restore-' + suffix,
  network = container,
  restore = 'orbit_restore_' + suffix,
  directory = await mkdtemp(join(tmpdir(), 'orbit-restore-drill-'));
let f: Awaited<ReturnType<typeof messagingFixture>> | undefined,
  admin: Awaited<ReturnType<typeof database>> | undefined;
const docker = async (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  (await exec('docker', args, { env, maxBuffer: 1024 * 1024 })).stdout.trim();
const started = Date.now();
try {
  await docker(['network', 'create', network]);
  await docker([
    'run',
    '-d',
    '--name',
    container,
    '--network',
    network,
    '--network-alias',
    'database',
    '-e',
    'POSTGRES_PASSWORD=local-restore-fixture-only',
    '-p',
    '127.0.0.1::5432',
    'postgres:17.10-bookworm',
  ]);
  for (let i = 0; i < 60; i++) {
    try {
      await docker(['exec', container, 'pg_isready', '-U', 'postgres']);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const port = (await docker(['port', container, '5432/tcp'])).split(':').at(-1)!,
    url = `postgresql://postgres:local-restore-fixture-only@127.0.0.1:${port}/postgres`;
  process.env.TEST_DATABASE_URL = url;
  await exec(
    'npm',
    [
      'run',
      'test',
      '-w',
      '@ao/api',
      '--',
      '--no-file-parallelism',
      'test/governance.test.ts',
      'test/operations.test.ts',
      'test/platform.test.ts',
      'test/auth-upgrade.test.ts',
      'test/organization-erasure.test.ts',
      'test/byok.test.ts',
      'test/enterprise-storage.test.ts',
      'test/byok-provider.test.ts',
      'test/routed-byok.test.ts',
    ],
    { env: { ...process.env, TEST_DATABASE_URL: url }, maxBuffer: 1024 * 1024 },
  );
  admin = await database({ url });
  await admin.query(`CREATE DATABASE ${restore}`);
  f = await messagingFixture();
  const [dbName] = await f.db.query('SELECT current_database() name');
  const message = await f.send(
    f.owner,
    f.ownerBoot.channels[0]!.id,
    'Synthetic recovery acceptance evidence',
  );
  assert.equal(message.statusCode, 201);
  await mkdir(join(directory, 'backups'), { mode: 0o700 });
  await mkdir(join(directory, 'keys'), { mode: 0o700 });
  const keys = generateKeyPairSync('ed25519');
  await writeFile(
    join(directory, 'keys', 'private.pem'),
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'keys', 'public.pem'),
    keys.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o600 },
  );
  await docker([
    'build',
    '-f',
    'deploy/Dockerfile.operations',
    '-t',
    'orbit-operations-drill:local',
    '.',
  ]);
  const env = {
    ...process.env,
    BACKUP_DATABASE_URL: `postgresql://postgres:local-restore-fixture-only@database/${dbName!.name}`,
    RESTORE_DATABASE_URL: `postgresql://postgres:local-restore-fixture-only@database/${restore}`,
    BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    BACKUP_SIGNING_KEY_FILE: '/keys/private.pem',
    BACKUP_VERIFY_KEY_FILE: '/keys/public.pem',
    DEPLOYMENT_REGION: 'eu',
  };
  const options = [
    'run',
    '--rm',
    '--network',
    network,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--tmpfs',
    '/tmp',
    '--user',
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '-v',
    join(directory, 'backups') + ':/backup',
    '-v',
    join(directory, 'keys') + ':/keys:ro',
    ...[
      'BACKUP_DATABASE_URL',
      'RESTORE_DATABASE_URL',
      'BACKUP_ENCRYPTION_KEY',
      'BACKUP_SIGNING_KEY_FILE',
      'BACKUP_VERIFY_KEY_FILE',
      'DEPLOYMENT_REGION',
    ].flatMap((key) => ['-e', key]),
    'orbit-operations-drill:local',
  ];
  await docker([...options, '/ops/backup.mjs', '/backup'], env);
  const manifest = (await readdir(join(directory, 'backups'))).find((p) =>
    p.endsWith('.manifest.json'),
  )!;
  const result = JSON.parse(
    await docker([...options, '/ops/restore.mjs', '/backup/' + manifest], env),
  );
  assert.equal(result.quarantined, true);
  assert.equal(result.activationAllowed, false);
  const restoredUrl = new URL(url);
  restoredUrl.pathname = '/' + restore;
  const restored = await database({ url: restoredUrl.toString() });
  try {
    const [row] = await restored.query('SELECT body FROM messages WHERE id=$1', [
      message.json().id,
    ]);
    assert.equal(row?.body, 'Synthetic recovery acceptance evidence');
    const [versions] = await restored.query('SELECT count(*)::int total FROM schema_migrations');
    assert.equal(Number(versions!.total), 77);
  } finally {
    await restored.close();
  }
  const ciphertext = join(directory, 'backups', manifest.replace('.manifest.json', '.pgdump.enc')),
    bytes = await readFile(ciphertext);
  bytes[30] = bytes[30]! ^ 1;
  await writeFile(ciphertext, bytes);
  const tamperTarget = restore + '_tamper';
  await admin.query(`CREATE DATABASE ${tamperTarget}`);
  try {
    await assert.rejects(
      () =>
        docker([...options, '/ops/restore.mjs', '/backup/' + manifest], {
          ...env,
          RESTORE_DATABASE_URL: env.RESTORE_DATABASE_URL.replace(restore, tamperTarget),
        }),
      /checksum failed/,
    );
    const empty = await database({ url: new URL('/' + tamperTarget, url).toString() });
    try {
      assert.equal(
        Number(
          (
            await empty.query(
              "SELECT count(*) total FROM information_schema.tables WHERE table_schema='public'",
            )
          )[0]!.total,
        ),
        0,
      );
    } finally {
      await empty.close();
    }
  } finally {
    await admin.query(`DROP DATABASE ${tamperTarget} WITH(FORCE)`);
  }
  console.log(
    JSON.stringify({
      encryptedBackup: true,
      signedManifest: true,
      restoreVerified: true,
      tamperRejected: true,
      migrations: 77,
      postgresGovernanceTests: 33,
      activationAllowed: false,
      elapsedMs: Date.now() - started,
    }),
  );
} finally {
  await f?.close();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${restore} WITH(FORCE)`);
    await admin.close();
  }
  await docker(['rm', '-f', container]).catch(() => {});
  await docker(['network', 'rm', network]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
