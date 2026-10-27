import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { CodeExecutor } from './sandbox.js';
import { sqliteProgram } from './sqlite.js';
import { AppError } from '../lib/errors.js';
const exec = promisify(execFile);
export function dockerSandboxExecutor(env: NodeJS.ProcessEnv): CodeExecutor {
  if (!['development', 'test'].includes(env.NODE_ENV ?? ''))
    throw new Error('Docker tool execution is only supported in development or test.');
  const host = env.DOCKER_TOOL_HOST;
  if (!host?.startsWith('unix:///') || host.includes('\n'))
    throw new Error('DOCKER_TOOL_HOST must identify a local Unix Docker socket.');
  const nodeImage = env.DOCKER_TOOL_NODE_IMAGE,
    pythonImage = env.DOCKER_TOOL_PYTHON_IMAGE;
  if (![nodeImage, pythonImage].every((value) => /^sha256:[a-f0-9]{64}$/.test(value ?? '')))
    throw new Error('Docker tool images must be pre-pulled immutable image IDs.');
  let active = 0;
  return async (input) => {
    if (active >= 2)
      throw new AppError(429, 'SANDBOX_BUSY', 'Two local sandboxes are already running.');
    active++;
    const name = 'orbit-tool-' + randomUUID();
    const image =
      input.language === 'javascript' || input.language === 'shell' ? nodeImage! : pythonImage!;
    const command =
      input.language === 'javascript'
        ? ['node', '--max-old-space-size=128', '-']
        : input.language === 'shell'
          ? ['sh', '-s']
          : ['python3', '-I', '-'];
    const program = input.language === 'sqlite' ? sqliteProgram(input.code) : input.code;
    const args = [
      '--host',
      host,
      'run',
      '--name',
      name,
      '--rm',
      '--pull=never',
      '--interactive',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=64',
      '--memory=256m',
      '--memory-swap=256m',
      '--cpus=1',
      '--user=65534:65534',
      '--tmpfs=/tmp:rw,nosuid,noexec,size=32m',
      '--workdir=/tmp',
      image,
      ...command,
    ];
    let timedOut = false,
      bytes = 0,
      truncated = false;
    const output: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    try {
      const result = await new Promise<number>((resolve, reject) => {
        const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, input.timeoutSeconds * 1000);
        for (const kind of ['stdout', 'stderr'] as const)
          child[kind].on('data', (chunk: Buffer) => {
            const remaining = Math.max(0, 24000 - bytes);
            if (remaining > 0) output[kind].push(chunk.subarray(0, remaining));
            bytes += Math.min(remaining, chunk.length);
            if (chunk.length > remaining) truncated = true;
          });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve(code ?? 124);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(program);
      });
      return {
        exitCode: timedOut ? 124 : result,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr:
          Buffer.concat(output.stderr).toString('utf8') +
          (timedOut ? '\nExecution deadline exceeded.' : ''),
        truncated,
      };
    } finally {
      try {
        await exec('docker', ['--host', host, 'rm', '--force', name], {
          timeout: 10000,
          maxBuffer: 4096,
        });
      } catch (error) {
        if (!String((error as { stderr?: string }).stderr ?? '').includes('No such container'))
          throw new AppError(
            503,
            'SANDBOX_CLEANUP_FAILED',
            'Inspect the local Docker sandbox cleanup before retrying.',
          );
      } finally {
        active--;
      }
    }
  };
}
