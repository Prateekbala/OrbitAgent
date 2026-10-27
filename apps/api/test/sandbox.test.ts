import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Writable } from 'node:stream';
const boundary = vi.hoisted(() => ({ create: vi.fn(), stop: vi.fn(), run: vi.fn() }));
vi.mock('@vercel/sandbox', () => ({ Sandbox: { create: boundary.create } }));
import { sandboxExecutor } from '../src/tools/sandbox.js';
afterEach(() => vi.resetAllMocks());
describe('isolated execution adapter', () => {
  it('bounds output and tears down the microVM after a nonzero command exit', async () => {
    boundary.stop.mockResolvedValue(undefined);
    boundary.create.mockResolvedValue({ runCommand: boundary.run, stop: boundary.stop });
    boundary.run.mockImplementation(
      async ({ stdout, stderr }: { stdout: Writable; stderr: Writable }) => {
        stdout.write(Buffer.alloc(100000, 65));
        stderr.write(Buffer.from('error'));
        return { exitCode: 7 };
      },
    );
    const result = await sandboxExecutor(true)({
      language: 'javascript',
      code: 'fixture program',
      timeoutSeconds: 5,
    });
    expect(result.exitCode).toBe(7);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      24000,
    );
    expect(boundary.stop).toHaveBeenCalledOnce();
    expect(boundary.create.mock.calls[0]?.[0]).toMatchObject({
      persistent: false,
      networkPolicy: 'deny-all',
      resources: { vcpus: 1 },
    });
    expect(boundary.create.mock.calls[0]?.[0].env).toBeUndefined();
  });
  it('stops the microVM when command observation fails and refuses disabled execution', async () => {
    boundary.stop.mockResolvedValue(undefined);
    boundary.create.mockResolvedValue({ runCommand: boundary.run, stop: boundary.stop });
    boundary.run.mockRejectedValue(new Error('Observation interrupted'));
    await expect(
      sandboxExecutor(true)({ language: 'shell', code: 'fixture program', timeoutSeconds: 5 }),
    ).rejects.toThrow('interrupted');
    expect(boundary.stop).toHaveBeenCalledOnce();
    boundary.create.mockClear();
    await expect(
      sandboxExecutor(false)({ language: 'python', code: 'fixture program', timeoutSeconds: 5 }),
    ).rejects.toThrow('operator');
    expect(boundary.create).not.toHaveBeenCalled();
  });
});
