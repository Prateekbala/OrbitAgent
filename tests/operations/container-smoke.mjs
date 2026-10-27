import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile),
  name = 'orbit-api-smoke-' + randomUUID();
const docker = async (args) =>
  (await exec('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
try {
  await docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--tmpfs',
    '/tmp:uid=1000,gid=1000,mode=0700',
    '--tmpfs',
    '/app/.data:uid=1000,gid=1000,mode=0700',
    '-e',
    'NODE_ENV=development',
    '-e',
    'PROCESS_ROLE=api',
    process.argv[2] ?? 'orbit-enterprise-api:local',
  ]);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await docker([
        'exec',
        name,
        'node',
        '-e',
        "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ]);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready)
    throw new Error('API container did not become ready. Inspect the isolated local image.');
  const uid = await docker(['exec', name, 'id', '-u']);
  if (uid === '0') throw new Error('API process must not run as root.');
  console.log(
    JSON.stringify({
      apiContainerReady: true,
      nonRoot: true,
      readOnly: true,
      externalNetwork: false,
      productionProviderQualified: false,
    }),
  );
} finally {
  await docker(['rm', '-f', name]).catch(() => {});
}
