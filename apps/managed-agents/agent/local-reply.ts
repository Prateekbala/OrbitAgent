import { randomUUID } from 'node:crypto';
import type { LanguageModelMiddleware } from 'ai';
import { agentOutput } from '@ao/contracts';

export function localReplyMiddleware(maxProposals = 4): LanguageModelMiddleware {
  if (!Number.isInteger(maxProposals) || maxProposals < 0 || maxProposals > 4)
    throw new Error('Invalid local proposal limit.');
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => {
      const reply = params.tools?.[0];
      if (params.tools?.length !== 1 || reply?.type !== 'function' || reply.name !== 'eve__reply')
        throw new Error('LOCAL_REPLY_TOOL_REQUIRED');
      const { tools: _tools, toolChoice: _choice, ...options } = params;
      return {
        ...options,
        responseFormat: {
          type: 'json',
          schema: {
            ...reply.inputSchema,
            properties: {
              ...reply.inputSchema.properties,
              proposals: {
                ...reply.inputSchema.properties?.proposals,
                type: 'array',
                maxItems: maxProposals,
              },
            },
          },
        },
        prompt: [
          ...params.prompt,
          {
            role: 'system',
            content:
              'Return your final reply as JSON matching the required response schema. Include reply and proposals. Proposals are requests for control-plane approval, never executed actions.',
          },
        ],
      };
    },
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      if (result.finishReason.unified !== 'stop') throw new Error('LOCAL_REPLY_INCOMPLETE');
      const text = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      const output = agentOutput.parse(JSON.parse(text));
      if (output.proposals.length > maxProposals) throw new Error('LOCAL_PROPOSAL_LIMIT');
      return {
        ...result,
        content: [
          {
            type: 'tool-call',
            toolCallId: randomUUID(),
            toolName: 'eve__reply',
            input: JSON.stringify(output),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: result.finishReason.raw },
      };
    },
  };
}
