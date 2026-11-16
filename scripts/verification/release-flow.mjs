import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function run(args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  const forward = () => child.kill('SIGTERM');
  process.once('SIGTERM', forward);
  process.once('SIGINT', forward);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    if (code !== 0) throw new Error('Release flow verification failed.');
  } finally {
    process.off('SIGTERM', forward);
    process.off('SIGINT', forward);
  }
}
try {
  await run(['node_modules/next/dist/bin/next', 'build', 'apps/web', '--webpack']);
  await run(['node_modules/@playwright/test/cli.js', 'test', 'tests/e2e/release-flow.spec.ts'], {
    ...process.env,
    CI: '1',
    PLAYWRIGHT_PORT: process.env.PLAYWRIGHT_PORT || '3100',
  });
} catch {
  process.exitCode = 1;
}
