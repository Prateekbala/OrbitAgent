import { spawnSync } from 'node:child_process';
const result = spawnSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
  encoding: 'utf8',
});
if (result.status !== 0)
  throw new Error(result.stderr || 'Unable to resolve native configuration.');
const config = JSON.parse(result.stdout);
if (
  config.updates?.enabled !== false ||
  config.android?.allowBackup !== false ||
  config.ios?.infoPlist?.NSAppTransportSecurity?.NSAllowsArbitraryLoads !== false
)
  throw new Error('Unsafe native release configuration.');
const url = new URL(config.extra.origin);
if (url.protocol !== 'https:') throw new Error('A pinned HTTPS app origin is required.');
console.log(
  'Mobile configuration verified. Device build and signing are separate qualification steps.',
);
