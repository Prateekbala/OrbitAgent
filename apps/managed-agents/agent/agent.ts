import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { defineAgent, defineDynamic } from 'eve';
import { gateway } from '@ai-sdk/gateway';
import { simulateStreamingMiddleware, wrapLanguageModel } from 'ai';
import { agentConfiguration } from '@ao/contracts/agents';
import { localReplyMiddleware } from './local-reply.js';
const model = process.env.AGENT_MODEL;
function selectedModel(id: string, maxProposals: number) {
  if (!id.startsWith('ollama/')) return gateway(id);
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
    throw new Error('OLLAMA_BASE_URL must be a loopback HTTP /v1 endpoint.');
  const modelId = id.slice('ollama/'.length);
  if (!/^[a-z0-9._-]+(?::[a-z0-9._-]+)?$/i.test(modelId))
    throw new Error('Invalid local model identifier.');
  const local = createOpenAICompatible({
    name: 'ollama',
    baseURL: endpoint.toString().replace(/\/$/, ''),
    includeUsage: true,
    supportsStructuredOutputs: true,
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
  }).chatModel(modelId);
  return wrapLanguageModel({
    model: local,
    middleware: [simulateStreamingMiddleware(), localReplyMiddleware(maxProposals)],
  });
}

if (!model) throw new Error('Set AGENT_MODEL to an approved model before building the runtime.');
export default defineAgent({
  model: defineDynamic({
    events: {
      'step.started': (_event, ctx) => {
        const message = ctx.messages.find((message) => message.role === 'user');
        const text =
          typeof message?.content === 'string'
            ? message.content
            : Array.isArray(message?.content)
              ? message.content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join('')
              : '';
        const input = JSON.parse(text) as { configuration?: unknown };
        const configuration = agentConfiguration.parse(input.configuration);
        const selected = configuration.model === 'operator_default' ? model : configuration.model;
        const configured = (process.env.AGENT_APPROVED_MODELS ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        const approved = configured.length ? configured : [model];
        if (!approved.includes(selected)) throw new Error('MODEL_NOT_QUALIFIED');
        if (ctx.messages.some((message) => message.role === 'assistant'))
          throw new Error('MODEL_CALL_LIMIT');
        let calls = 0;
        const admit = () => {
          if (++calls > 1) throw new Error('MODEL_CALL_LIMIT');
        };
        const wrapped = wrapLanguageModel({
          model: selectedModel(
            selected,
            configuration.tools.length ? configuration.limits.maxTools : 0,
          ),
          middleware: {
            specificationVersion: 'v4',
            wrapGenerate: async ({ doGenerate }) => {
              admit();
              return doGenerate();
            },
            wrapStream: async ({ doStream }) => {
              admit();
              return doStream();
            },
            transformParams: async ({ params }) => {
              const envelopeBytes = Buffer.byteLength(
                JSON.stringify({
                  prompt: params.prompt,
                  tools: params.tools,
                  responseFormat: params.responseFormat,
                }),
                'utf8',
              );
              if (envelopeBytes + 4096 > configuration.limits.maxInputTokens)
                throw new Error('INPUT_TOKEN_LIMIT');
              return {
                ...params,
                maxOutputTokens: Math.min(
                  params.maxOutputTokens ?? Infinity,
                  configuration.limits.maxOutputTokens,
                ),
              };
            },
          },
        });
        return selected.startsWith('ollama/')
          ? { model: wrapped, modelContextWindowTokens: 16384 }
          : wrapped;
      },
    },
  }),
  defaultTools: false,
  limits: {
    sessionUsage: ({ window }) =>
      window.inputTokens >= 60000 || window.outputTokens >= 8000 || (window.costUsd ?? 0) >= 0.5,
    sessionTimeoutMs: 86400000,
  },
});
