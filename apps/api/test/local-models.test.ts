import { afterEach, describe, it, expect, vi } from 'vitest';
import { configuredEmbeddings } from '../src/retrieval/embeddings.js';
import { languageModel } from '../src/lib/model-provider.js';
import { generateText, Output } from 'ai';
import { z } from 'zod';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('explicit local model routing', () => {
  it('generates structured output on loopback without forwarding gateway credentials', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11435/v1');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'must-not-leave-the-process');
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:11435/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      expect(JSON.parse(String(init?.body)).model).toBe('orbit-chat');
      return Response.json({
        id: 'local-test',
        created: 1,
        model: 'orbit-chat',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"reply":"Local model"}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });
    vi.stubGlobal('fetch', request);
    const result = await generateText({
      model: languageModel('ollama/orbit-chat'),
      prompt: 'Reply locally',
      output: Output.object({ schema: z.object({ reply: z.string() }) }),
      maxRetries: 0,
    });
    expect(result.output.reply).toBe('Local model');
    expect(request).toHaveBeenCalledOnce();
  });
  it('routes embedding batches to the local embedding alias', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe('http://127.0.0.1:11435/v1/embeddings');
        expect(JSON.parse(String(init?.body)).model).toBe('orbit-embeddings');
        return Response.json({
          object: 'list',
          model: 'orbit-embeddings',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        });
      }),
    );
    expect(
      await configuredEmbeddings('ollama/orbit-embeddings')!.embed(
        ['Local evidence'],
        AbortSignal.timeout(1000),
      ),
    ).toEqual([[0.1, 0.2]]);
  });
  it('rejects remote, credentialed and redirected endpoint configuration and unsafe model IDs', () => {
    for (const endpoint of [
      'https://paid.example/v1',
      'http://secret@127.0.0.1:11435/v1',
      'http://127.0.0.1:11435/private',
    ]) {
      vi.stubEnv('OLLAMA_BASE_URL', endpoint);
      expect(() => languageModel('ollama/orbit-chat')).toThrow('loopback');
    }
    vi.stubEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11435/v1');
    expect(() => languageModel('ollama/../../other')).toThrow('identifier');
  });
});
