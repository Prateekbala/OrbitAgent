import { defineAgent, defineDynamic } from 'eve';
import { wrapLanguageModel } from 'ai';
import { agentConfiguration } from '@ao/contracts/agents';
import { defaultAgentModel } from '@ao/models/configuration';
import { selectedModel } from './models.js';
const model = process.env.AGENT_MODEL ?? defaultAgentModel;
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
          : selected.startsWith('groq/')
            ? { model: wrapped, modelContextWindowTokens: 131072 }
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
