import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
  createPrivateKey,
  sign,
} from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { postgresEnvironment, postgresCommand } from './postgres.mjs';
const directory = process.argv[2];
if (
  !directory ||
  !process.env.BACKUP_DATABASE_URL ||
  !process.env.BACKUP_ENCRYPTION_KEY ||
  !process.env.BACKUP_SIGNING_KEY_FILE
)
  throw new Error('Set backup connection, encryption/signing inputs and an output directory.');
const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'base64');
if (key.length !== 32 || key.toString('base64') !== process.env.BACKUP_ENCRYPTION_KEY)
  throw new Error('Use a canonical base64 32-byte backup key.');
const signing = createPrivateKey(await readFile(process.env.BACKUP_SIGNING_KEY_FILE));
if (signing.asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 backup signing key.');
const days = Number(process.env.BACKUP_RETENTION_DAYS ?? 35);
if (!Number.isInteger(days) || days < 1 || days > 365)
  throw new Error('Backup retention must be 1–365 days.');
await mkdir(directory, { recursive: true, mode: 0o700 });
const id = randomUUID(),
  path = join(directory, id + '.pgdump.enc'),
  iv = randomBytes(12),
  cipher = createCipheriv('aes-256-gcm', key, iv);
cipher.setAAD(Buffer.from(id));
const { child, completed } = postgresCommand(
  'pg_dump',
  ['--format=custom', '--no-owner'],
  postgresEnvironment(process.env.BACKUP_DATABASE_URL),
);
try {
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  output.write(Buffer.concat([Buffer.from('ORBITBACKUP1'), iv]));
  await pipeline(child.stdout, cipher, output);
  await completed;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, cipher.getAuthTag());
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  const manifest = {
    id,
    format: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
    region: process.env.DEPLOYMENT_REGION ?? 'unqualified',
    sha256: hash.digest('hex'),
    encryption: 'aes-256-gcm',
    keyId: createHash('sha256').update(key).digest('hex').slice(0, 24),
  };
  const payload = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(directory, id + '.manifest.json'), payload, { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, id + '.sig'), sign(null, payload, signing).toString('base64'), {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify({ id, encrypted: true, signed: true, expiresAt: manifest.expiresAt }));
} catch (error) {
  child.kill();
  await completed.catch(() => {});
  await unlink(path).catch(() => {});
  throw error;
}
