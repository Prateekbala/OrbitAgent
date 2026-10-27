import { sqliteProgram } from './sqlite.js';
import { Sandbox } from '@vercel/sandbox';
import { Writable } from 'node:stream';
import type { z } from 'zod';
import type { codeAction } from '@ao/contracts/tools';
import { AppError } from '../lib/errors.js';
interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export type CodeExecutor = (input: z.infer<typeof codeAction>) => Promise<SandboxResult>;
export function sandboxExecutor(
  enabled: boolean,
  credentials?: { token: string; teamId: string; projectId: string },
): CodeExecutor {
  return async (input) => {
    if (!enabled)
      throw new AppError(
        503,
        'SANDBOX_UNAVAILABLE',
        'The operator must enable and configure isolated execution.',
      );
    const sandbox = await Sandbox.create({
      ...credentials,
      persistent: false,
      networkPolicy: 'deny-all',
      timeout: (input.timeoutSeconds + 5) * 1000,
      resources: { vcpus: 1 },
    });
    let bytes = 0,
      truncated = false;
    const output = { stdout: '', stderr: '' };
    const sink = (key: 'stdout' | 'stderr') =>
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          const remaining = Math.max(0, 24000 - bytes);
          output[key] += chunk.subarray(0, remaining).toString('utf8');
          bytes += Math.min(remaining, chunk.length);
          if (chunk.length > remaining) truncated = true;
          done();
        },
      });
    try {
      const sqlite = sqliteProgram(input.code);
      const command =
        input.language === 'javascript'
          ? (['node', ['--max-old-space-size=128', '-e', input.code]] as const)
          : input.language === 'python'
            ? (['python3', ['-I', '-c', input.code]] as const)
            : input.language === 'shell'
              ? (['bash', ['--noprofile', '--norc', '-c', input.code]] as const)
              : (['python3', ['-I', '-c', sqlite]] as const);
      const result = await sandbox.runCommand({
        cmd: command[0],
        args: [...command[1]],
        cwd: '/vercel/sandbox',
        timeoutMs: input.timeoutSeconds * 1000,
        stdout: sink('stdout'),
        stderr: sink('stderr'),
      });
      return { exitCode: result.exitCode, ...output, truncated };
    } finally {
      await sandbox.stop();
    }
  };
}
