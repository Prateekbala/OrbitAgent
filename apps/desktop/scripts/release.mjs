import { createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const required =
  process.platform === 'darwin'
    ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
    : ['CSC_LINK', 'CSC_KEY_PASSWORD', 'ORBIT_WINDOWS_PUBLISHER'];
for (const key of required)
  if (!process.env[key]) throw new Error(`Signed release requires ${key}.`);
const config = JSON.parse(await readFile(new URL('../client.json', import.meta.url), 'utf8'));
if (
  !config.origin?.startsWith('https://') ||
  !config.updates?.publicKey ||
  !config.updates?.origin?.startsWith('https://')
)
  throw new Error('A pinned HTTPS app origin and signed update configuration are required.');
if (createPublicKey(config.updates.publicKey).asymmetricKeyType !== 'ed25519')
  throw new Error('An Ed25519 release key is required.');
for (const args of [
  ['run', 'build'],
  ['exec', '--', 'electron-builder', '--publish', 'never'],
]) {
  const result = spawnSync('npm', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
