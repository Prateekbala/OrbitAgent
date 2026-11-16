import { gateway } from '@ai-sdk/gateway';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';

export function isModelIdentifier(model: string) {
  return /^[a-z0-9_-]+\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i.test(model);
}

function ollama() {
  const endpoint = new URL(process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11435/v1');
  if (
    endpoint.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^\/v1\/?$/.test(endpoint.pathname)
  )
    throw new Error('OLLAMA_BASE_URL must be a credential-free loopback HTTP /v1 endpoint.');
  return createOpenAICompatible({
    name: 'ollama',
    baseURL: endpoint.toString().replace(/\/$/, ''),
    includeUsage: true,
    supportsStructuredOutputs: true,
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
  });
}

function localId(model: string) {
  const id = model.slice('ollama/'.length);
  if (!/^[a-z0-9._-]+(?::[a-z0-9._-]+)?$/i.test(id))
    throw new Error('Invalid local model identifier.');
  return id;
}

function groq() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey?.trim() || /[\r\n]/.test(apiKey))
    throw new Error('GROQ_API_KEY is required and must be valid.');
  return createGroq({
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
  });
}

export function languageModel(model: string) {
  if (model.startsWith('ollama/')) return ollama().chatModel(localId(model));
  if (model.startsWith('groq/')) {
    if (model !== 'groq/openai/gpt-oss-120b')
      throw new Error('Only groq/openai/gpt-oss-120b is configured for Groq text generation.');
    return wrapLanguageModel({
      model: groq().languageModel('openai/gpt-oss-120b'),
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: { groq: { strictJsonSchema: false } } },
      }),
    });
  }
  return gateway(model);
}

export function embeddingModel(model: string) {
  if (model.startsWith('groq/'))
    throw new Error('Configure a dedicated embedding model; GPT-OSS does not produce embeddings.');
  return model.startsWith('ollama/')
    ? ollama().embeddingModel(localId(model))
    : gateway.embeddingModel(model);
}

export function transcriptionModel(model: string) {
  if (model !== 'groq/whisper-large-v3-turbo')
    throw new Error('Only groq/whisper-large-v3-turbo is configured for transcription.');
  return groq().transcription('whisper-large-v3-turbo');
}
