import { it, expect } from 'vitest';
import { agentConfiguration } from '@ao/contracts/agents';
import { randomUUID } from 'node:crypto';
import { customerModelGenerator } from '../src/model-broker/app.js';
it('uses the real provider adapter with a private header, bounded structured output and no retry', async () => {
  const secret = 'sk-private-fixture-key-not-for-real-use';
  let calls = 0;
  const generate = customerModelGenerator(async (url, init) => {
    calls++;
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + secret);
    expect(init?.redirect).toBe('error');
    expect(String(init?.body)).not.toContain(secret);
    expect(JSON.parse(String(init?.body)).max_tokens).toBe(8000);
    return new Response(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        created: 1,
        model: 'fixture-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({ reply: 'Private account response', proposals: [] }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const configuration = agentConfiguration.parse({
    instructions: 'Use only authorized evidence.',
    model: 'openai/fixture-model',
  });
  const result = await generate(
    secret,
    {
      runId: randomUUID(),
      instructions: configuration.instructions,
      prompt: 'Summarize this discussion.',
      context: '[]',
      configuration,
    },
    AbortSignal.timeout(5000),
  );
  expect(result.output.reply).toBe('Private account response');
  expect(calls).toBe(1);
  expect(JSON.stringify(result)).not.toContain(secret);
  let failures = 0;
  const unavailable = customerModelGenerator(async () => {
    failures++;
    return new Response('Unavailable', { status: 503 });
  });
  await expect(
    unavailable(
      secret,
      {
        runId: randomUUID(),
        instructions: configuration.instructions,
        prompt: 'Summarize.',
        context: '[]',
        configuration,
      },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow();
  expect(failures).toBe(1);
});
