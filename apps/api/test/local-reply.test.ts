import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, simulateStreamingMiddleware, streamText, wrapLanguageModel } from 'ai';
import { agentOutput } from '@ao/contracts';
import { localReplyMiddleware } from '../../managed-agents/agent/local-reply.js';

afterEach(() => vi.unstubAllGlobals());
function setup(content: string, finishReason = 'stop', maxProposals = 4) {
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.tools).toBeUndefined();
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.required).toContain('proposals');
    expect(body.response_format.json_schema.schema.properties.proposals.maxItems).toBe(
      maxProposals,
    );
    return Response.json({
      id: 'local-reply-test',
      created: 1,
      model: 'orbit-chat',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });
  vi.stubGlobal('fetch', request);
  const model = wrapLanguageModel({
    model: createOpenAICompatible({
      name: 'ollama',
      baseURL: 'http://127.0.0.1:11435/v1',
      supportsStructuredOutputs: true,
    }).chatModel('orbit-chat'),
    middleware: [simulateStreamingMiddleware(), localReplyMiddleware(maxProposals)],
  });
  return { model, request };
}
const tools = { eve__reply: { inputSchema: agentOutput } };
describe('local structured agent reply protocol', () => {
  it('returns a validated final reply with one actual model request', async () => {
    const { model, request } = setup('{"reply":"Local reply","proposals":[]}');
    const result = await generateText({ model, tools, prompt: 'Hello', maxRetries: 0 });
    expect(result.toolCalls[0]?.input).toEqual({ reply: 'Local reply', proposals: [] });
    expect(result.finishReason).toBe('tool-calls');
    expect(request).toHaveBeenCalledOnce();
  });
  it('preserves the same single-request protocol through the streaming interface', async () => {
    const { model, request } = setup('{"reply":"Local reply","proposals":[]}');
    const result = streamText({ model, tools, prompt: 'Hello', maxRetries: 0 });
    expect((await result.toolCalls)[0]?.input).toEqual({ reply: 'Local reply', proposals: [] });
    expect(request).toHaveBeenCalledOnce();
  });
  it('rejects malformed, invalid and truncated replies without repair or retries', async () => {
    for (const [content, finish] of [
      ['not JSON', 'stop'],
      ['{"reply":"Local reply"}', 'stop'],
      ['{"reply":"Local reply","proposals":[]}', 'length'],
    ]) {
      const { model, request } = setup(content!, finish);
      await expect(
        generateText({ model, tools, prompt: 'Hello', maxRetries: 0 }),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    }
  });
  it('rejects additional tool authority before calling the provider', async () => {
    const { model, request } = setup('{"reply":"Local reply","proposals":[]}');
    await expect(
      generateText({
        model,
        tools: { ...tools, unexpected: tools.eve__reply },
        prompt: 'Hello',
        maxRetries: 0,
      }),
    ).rejects.toThrow('LOCAL_REPLY_TOOL_REQUIRED');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects proposals above the configured limit even if a provider ignores the schema', async () => {
    const { model, request } = setup(
      '{"reply":"Local reply","proposals":[{"tool":"read_tasks","parameters":{"query":""}}]}',
      'stop',
      0,
    );
    await expect(generateText({ model, tools, prompt: 'Hello', maxRetries: 0 })).rejects.toThrow(
      'LOCAL_PROPOSAL_LIMIT',
    );
    expect(request).toHaveBeenCalledOnce();
  });
});
