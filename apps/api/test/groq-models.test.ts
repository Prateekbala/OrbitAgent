import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, Output, streamText } from 'ai';
import { z } from 'zod';
import { agentOutput } from '@ao/contracts';
import { embeddingModel, languageModel, transcriptionModel } from '@ao/models';
import { selectedModel } from '../../managed-agents/agent/models.js';
import { configuredAnswerSynthesizer } from '../src/retrieval/answers.js';
import { configuredEmbeddings } from '../src/retrieval/embeddings.js';
import { configuredTextExtractor } from '../src/retrieval/extraction.js';
import { transcribeAudio } from '../src/calls/transcription.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const model = 'groq/openai/gpt-oss-120b';
const secret = 'synthetic-groq-api-key';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(content = '{"reply":"Reviewed reply","proposals":[]}', finishReason = 'stop') {
  vi.stubEnv('GROQ_API_KEY', secret);
  vi.stubEnv('AI_GATEWAY_API_KEY', 'must-not-be-sent');
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + secret);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.tools).toBeUndefined();
    expect(body.stream).not.toBe(true);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(false);
    expect(String(init?.body)).not.toContain(secret);
    expect(String(init?.body)).not.toContain('must-not-be-sent');
    return Response.json({
      id: 'groq-fixture',
      created: 1,
      model: 'openai/gpt-oss-120b',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    });
  });
  vi.stubGlobal('fetch', request);
  return request;
}

describe('direct Groq model routing', () => {
  it('uses the Groq endpoint for structured generation and preserves total billed tokens', async () => {
    const request = setup('{"reply":"Reviewed reply"}');
    const result = await generateText({
      model: languageModel(model),
      prompt: 'Reply',
      output: Output.object({ schema: z.object({ reply: z.string() }) }),
      maxRetries: 0,
    });
    expect(result.output.reply).toBe('Reviewed reply');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(30);
    expect(result.usage.outputTokenDetails.reasoningTokens).toBe(10);
    expect(request).toHaveBeenCalledOnce();
  });

  it('adapts one non-streaming JSON reply into Eve’s approved proposal protocol', async () => {
    const request = setup();
    const result = streamText({
      model: selectedModel(model, 0),
      tools: { eve__reply: { inputSchema: agentOutput } },
      prompt: 'Reply',
      maxRetries: 0,
    });
    expect((await result.toolCalls)[0]?.input).toEqual({ reply: 'Reviewed reply', proposals: [] });
    expect(await result.finishReason).toBe('tool-calls');
    expect((await result.usage).outputTokens).toBe(30);
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects malformed, truncated or unauthorized proposals without repair calls', async () => {
    for (const [content, finish] of [
      ['not JSON', 'stop'],
      ['{"reply":"Incomplete","proposals":[]}', 'length'],
      [
        '{"reply":"Proposal","proposals":[{"tool":"read_tasks","parameters":{"query":""}}]}',
        'stop',
      ],
    ]) {
      const request = setup(content!, finish);
      await expect(
        generateText({
          model: selectedModel(model, 0),
          tools: { eve__reply: { inputSchema: agentOutput } },
          prompt: 'Reply',
          maxRetries: 0,
        }),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    }
    const request = setup();
    await expect(
      generateText({
        model: selectedModel(model, 0),
        tools: { extra: { inputSchema: z.object({}) } },
        prompt: 'Reply',
        maxRetries: 0,
      }),
    ).rejects.toThrow('STRUCTURED_REPLY_TOOL_REQUIRED');
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts the namespaced Groq model for cited answers and sanitizes provider failures', async () => {
    const request = setup('{"claims":[],"missingEvidence":true,"conflictingEvidence":false}');
    const synthesizer = configuredAnswerSynthesizer(model)!;
    expect(
      await synthesizer.synthesize({
        query: 'What changed?',
        evidence: [],
        signal: AbortSignal.timeout(1000),
      }),
    ).toEqual({ claims: [], missingEvidence: true, conflictingEvidence: false });
    expect(request).toHaveBeenCalledOnce();
    const failure = vi.fn(async () => {
      throw new Error(secret);
    });
    vi.stubGlobal('fetch', failure);
    await expect(
      synthesizer.synthesize({
        query: 'Question',
        evidence: [],
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow('Provider diagnostics were withheld');
    expect(failure).toHaveBeenCalledOnce();
  });

  it('fails before dispatch for missing keys, unsupported models, embeddings and OCR', () => {
    const request = setup();
    vi.stubEnv('GROQ_API_KEY', '');
    expect(() => languageModel(model)).toThrow('GROQ_API_KEY');
    expect(() => languageModel('groq/another-model')).toThrow('Only groq/');
    expect(() => transcriptionModel('groq/another-model')).toThrow('Only groq/');
    expect(() => embeddingModel(model)).toThrow('embedding');
    expect(() => configuredEmbeddings(model)).toThrow('embedding');
    expect(() => configuredTextExtractor(model)).toThrow('text-only');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('explicit Whisper transcription', () => {
  const audio = Buffer.alloc(100);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(92, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(56, 40);

  it('uses the Whisper endpoint only after opt-in and returns bounded transcript data', async () => {
    vi.stubEnv('GROQ_API_KEY', secret);
    vi.stubEnv('TRANSCRIPTION_ENABLED', 'true');
    vi.stubEnv('TRANSCRIPTION_MODEL', 'groq/whisper-large-v3-turbo');
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + secret);
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('whisper-large-v3-turbo');
      expect(form.get('response_format')).toBe('verbose_json');
      expect(form.getAll('timestamp_granularities[]')).toEqual(['segment']);
      expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(audio);
      return Response.json({
        text: 'A reviewed recording.',
        language: 'en',
        duration: 1,
        x_groq: { id: 'local-fixture' },
      });
    });
    vi.stubGlobal('fetch', request);
    expect(await transcribeAudio(audio, AbortSignal.timeout(1000))).toEqual({
      model: 'groq/whisper-large-v3-turbo',
      text: 'A reviewed recording.',
      language: 'en',
      durationInSeconds: 1,
      segments: [],
    });
    expect(request).toHaveBeenCalledOnce();
    vi.stubEnv('TRANSCRIPTION_ENABLED', 'false');
    await expect(transcribeAudio(audio, AbortSignal.timeout(1000))).rejects.toThrow(
      'Enable transcription',
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects unsupported input and never retries ambiguous provider failures', async () => {
    vi.stubEnv('GROQ_API_KEY', secret);
    vi.stubEnv('TRANSCRIPTION_ENABLED', 'true');
    const request = vi.fn(async () => {
      throw new Error(secret);
    });
    vi.stubGlobal('fetch', request);
    await expect(transcribeAudio(Buffer.alloc(0), AbortSignal.timeout(1000))).rejects.toThrow(
      '25 MiB',
    );
    await expect(
      transcribeAudio(Buffer.from('Not audio'), AbortSignal.timeout(1000)),
    ).rejects.toThrow('supported');
    expect(request).not.toHaveBeenCalled();
    await expect(transcribeAudio(audio, AbortSignal.timeout(1000))).rejects.toThrow(
      'No automatic retry',
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it('saves operator transcripts privately without printing speech or credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbit-speech-cli-'));
    const execute = promisify(execFile);
    try {
      const input = join(directory, 'speech.wav');
      const preload = join(directory, 'provider.mjs');
      await writeFile(input, audio);
      await writeFile(
        preload,
        "globalThis.fetch = async (url) => { if (String(url) !== 'https://api.groq.com/openai/v1/audio/transcriptions') throw new Error('Unexpected endpoint'); return Response.json({text:'Private fixture speech',duration:1,x_groq:{id:'synthetic'}}); };\n",
      );
      const entry = fileURLToPath(new URL('../src/calls/transcribe-audio.ts', import.meta.url));
      const result = await execute(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--import', preload, entry, input],
        {
          cwd: directory,
          env: {
            ...process.env,
            TRANSCRIPTION_ENABLED: 'true',
            TRANSCRIPTION_MODEL: 'groq/whisper-large-v3-turbo',
            GROQ_API_KEY: secret,
          },
        },
      );
      expect(result.stdout).not.toContain('Private fixture speech');
      expect(result.stdout + result.stderr).not.toContain(secret);
      const destination = join(directory, '.data/transcripts');
      expect((await stat(destination)).mode & 0o777).toBe(0o700);
      const files = await readdir(destination);
      expect(files).toHaveLength(1);
      const path = join(destination, files[0]!);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8')).text).toBe('Private fixture speech');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
