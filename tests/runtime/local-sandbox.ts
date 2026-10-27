import assert from 'node:assert/strict';
import { dockerSandboxExecutor } from '../../apps/api/src/tools/docker-sandbox.js';
const execute = dockerSandboxExecutor(process.env);
for (const input of [
  {
    language: 'javascript' as const,
    code: 'console.log("local-js"); console.log(process.env.EMAIL_ENCRYPTION_KEY ?? "no-host-secret")',
  },
  { language: 'python' as const, code: 'print("local-python")' },
  { language: 'shell' as const, code: 'echo local-shell; test ! -S /var/run/docker.sock' },
  { language: 'sqlite' as const, code: 'SELECT 40+2 AS answer;' },
]) {
  const result = await execute({ ...input, timeoutSeconds: 10 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert(result.stdout.length > 0);
  if (input.language === 'javascript') assert(result.stdout.includes('no-host-secret'));
  if (input.language === 'sqlite') assert(result.stdout.includes('42'));
}
const network = await execute({
  language: 'python',
  code: 'import socket; s=socket.socket(); s.settimeout(1); s.connect(("1.1.1.1",443))',
  timeoutSeconds: 5,
});
assert.notEqual(network.exitCode, 0);
const bounded = await execute({
  language: 'javascript',
  code: 'console.log("x".repeat(100000))',
  timeoutSeconds: 10,
});
assert(bounded.truncated);
assert(Buffer.byteLength(bounded.stdout) + Buffer.byteLength(bounded.stderr) <= 24000);
const timeout = await execute({
  language: 'python',
  code: 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)',
  timeoutSeconds: 1,
});
assert.equal(timeout.exitCode, 124);
console.log(
  'Docker JavaScript/Python/shell/SQLite, secret isolation, network denial, output bounds and deadline cleanup passed.',
);
