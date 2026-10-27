import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
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
export function languageModel(model: string) {
  return model.startsWith('ollama/') ? ollama().chatModel(localId(model)) : model;
}
export function embeddingModel(model: string) {
  return model.startsWith('ollama/') ? ollama().embeddingModel(localId(model)) : model;
}
