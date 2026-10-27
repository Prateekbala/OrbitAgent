import { describe, expect, it, vi } from 'vitest';
import { EveRuntime } from '../src/execution/runtime.js';
const boundary = vi.hoisted(() => ({ result: vi.fn() }));
vi.mock('eve/client', () => ({
  Client: class {
    sessions = { attach: () => ({ send: async () => ({ result: boundary.result }) }) };
  },
}));
const output = { reply: 'Verified local result.', proposals: [] };
const request = { runId: 'synthetic-run', instructions: 'Reply.', prompt: 'Hello', context: '' };
const runtime = () => new EveRuntime('http://127.0.0.1:4100', 'x'.repeat(32));
const settled = [
  { type: 'result.completed', data: { result: output } },
  { type: 'turn.completed', data: {} },
  { type: 'session.waiting', data: { usage: { inputTokens: 100, outputTokens: 20 } } },
];
describe('hosted turn settlement', () => {
  it.each(['waiting', 'completed'])(
    'accepts a validated completed turn in a %s session',
    async (status) => {
      boundary.result.mockResolvedValue({ status, data: output, events: settled });
      expect(
        await runtime().generateDetailed('session', request, AbortSignal.timeout(1000)),
      ).toEqual({
        output,
        usage: { inputTokens: 100, outputTokens: 20, costMicros: null },
      });
    },
  );
  it('rejects input waits and results without turn completion', async () => {
    for (const events of [[], [settled[0]], [settled[1]]]) {
      boundary.result.mockResolvedValue({ status: 'waiting', data: output, events });
      await expect(
        runtime().generate('session', request, AbortSignal.timeout(1000)),
      ).rejects.toThrow('did not complete');
    }
  });
  it('rejects failed or cancelled turns even when an earlier result exists', async () => {
    for (const type of ['session.failed', 'turn.failed', 'turn.cancelled']) {
      boundary.result.mockResolvedValue({
        status: 'waiting',
        data: output,
        events: [...settled, { type }],
      });
      await expect(
        runtime().generate('session', request, AbortSignal.timeout(1000)),
      ).rejects.toThrow('did not complete');
    }
  });
  it('revalidates structured output instead of trusting session status', async () => {
    boundary.result.mockResolvedValue({
      status: 'waiting',
      data: { reply: 'Missing proposals' },
      events: settled,
    });
    await expect(
      runtime().generate('session', request, AbortSignal.timeout(1000)),
    ).rejects.toThrow();
  });
});
