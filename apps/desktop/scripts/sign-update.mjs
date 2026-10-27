import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
const [artifact, version, platform, architecture, origin, output] = process.argv.slice(2);
if (
  !artifact ||
  !version ||
  !platform ||
  !architecture ||
  !origin ||
  !output ||
  !process.env.ORBIT_RELEASE_KEY_FILE
)
  throw new Error(
    'Provide artifact, version, platform, architecture, HTTPS release origin, output directory, and ORBIT_RELEASE_KEY_FILE.',
  );
const url = new URL(origin);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
  throw new Error('A trusted HTTPS release address is required.');
if (
  !/^\d+\.\d+\.\d+$/.test(version) ||
  !['darwin', 'win32'].includes(platform) ||
  !['arm64', 'x64'].includes(architecture)
)
  throw new Error('Invalid release target.');
const bytes = await readFile(artifact),
  key = createPrivateKey(await readFile(process.env.ORBIT_RELEASE_KEY_FILE));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 signing key is required.');
const payload = Buffer.from(
  JSON.stringify({
    version,
    platform,
    architecture,
    expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(),
    artifact: new URL(encodeURIComponent(basename(artifact)), url.href.replace(/\/?$/, '/')).href,
    sha512: createHash('sha512').update(bytes).digest('base64'),
  }),
);
await writeFile(join(output, 'release.json'), payload, { flag: 'wx', mode: 0o644 });
await writeFile(join(output, 'release.json.sig'), sign(null, payload, key).toString('base64'), {
  flag: 'wx',
  mode: 0o644,
});
console.log('Signed release manifest written. No release was published.');
