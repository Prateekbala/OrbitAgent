import { createDecipheriv, createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, open, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { postgresEnvironment, postgresCommand } from './postgres.mjs';
const manifestPath = process.argv[2];
if (
  !manifestPath ||
  !process.env.RESTORE_DATABASE_URL ||
  !process.env.BACKUP_ENCRYPTION_KEY ||
  !process.env.BACKUP_VERIFY_KEY_FILE
)
  throw new Error('Set restore connection, decryption/verification inputs and a manifest.');
const payload = await readFile(manifestPath);
if (payload.length > 8192) throw new Error('Invalid backup manifest.');
const manifest = JSON.parse(payload),
  publicKey = createPublicKey(await readFile(process.env.BACKUP_VERIFY_KEY_FILE));
const signature = await readFile(manifestPath.replace('.manifest.json', '.sig'), 'utf8');
if (
  publicKey.asymmetricKeyType !== 'ed25519' ||
  !verify(null, payload, publicKey, Buffer.from(signature, 'base64')) ||
  manifest.format !== 1 ||
  !/^[a-f0-9-]{36}$/.test(manifest.id) ||
  !/^[a-f0-9]{64}$/.test(manifest.sha256)
)
  throw new Error('Backup signature or manifest is invalid.');
const environment = postgresEnvironment(process.env.RESTORE_DATABASE_URL);
if (!/^orbit_restore_[a-z0-9_]+$/.test(environment.PGDATABASE))
  throw new Error('Restore only into a quarantined orbit_restore_* database.');
const check = postgresCommand(
  'psql',
  [
    '--no-psqlrc',
    '--tuples-only',
    '--command',
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
  ],
  environment,
);
let rows = '';
check.child.stdout.on('data', (v) => (rows += String(v)));
await check.completed;
if (Number(rows.trim()) !== 0) throw new Error('The quarantine database must be empty.');
const path = join(dirname(manifestPath), manifest.id + '.pgdump.enc'),
  hash = createHash('sha256');
for await (const part of createReadStream(path)) hash.update(part);
if (hash.digest('hex') !== manifest.sha256) throw new Error('Encrypted backup checksum failed.');
const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'base64');
if (
  key.length !== 32 ||
  createHash('sha256').update(key).digest('hex').slice(0, 24) !== manifest.keyId
)
  throw new Error('The backup decryption key is unavailable.');
const file = await open(path, 'r'),
  size = (await stat(path)).size,
  header = Buffer.alloc(24),
  tag = Buffer.alloc(16);
await file.read(header, 0, 24, 0);
await file.read(tag, 0, 16, size - 16);
await file.close();
if (header.subarray(0, 12).toString() !== 'ORBITBACKUP1') throw new Error('Unknown backup format.');
const directory = await mkdtemp(join(tmpdir(), 'orbit-restore-')),
  plain = join(directory, 'authenticated.pgdump');
try {
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(12));
  decipher.setAAD(Buffer.from(manifest.id));
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(path, { start: 24, end: size - 17 }),
    decipher,
    createWriteStream(plain, { flags: 'wx', mode: 0o600 }),
  );
  const restore = postgresCommand(
    'pg_restore',
    ['--no-owner', '--exit-on-error', '--dbname', environment.PGDATABASE, plain],
    environment,
    ['ignore', 'ignore', 'pipe'],
  );
  await restore.completed;
  console.log(
    JSON.stringify({
      backupId: manifest.id,
      restored: true,
      quarantined: true,
      activationAllowed: false,
      requires: [
        'deletion-journal-replay',
        'identity-and-provider-reconciliation',
        'restore-and-failover-acceptance',
      ],
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
