import { z } from 'zod';
import { delegationInput } from '@ao/contracts/agents';
import { connectionAction, codeAction, formAction, type ToolName } from '@ao/contracts/tools';
const taskParameters = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(12000),
    priority: z.enum(['low', 'normal', 'high']),
  })
  .strict();
const knowledgeParameters = z
  .object({ title: z.string().trim().min(2).max(200), body: z.string().trim().min(1).max(50000) })
  .strict();
const readParameters = z.object({ query: z.string().trim().max(200).default('') }).strict();
export const toolProposal = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('read_tasks'), parameters: readParameters }).strict(),
  z.object({ tool: z.literal('read_knowledge'), parameters: readParameters }).strict(),
  z.object({ tool: z.literal('connection_action'), parameters: connectionAction }).strict(),
  z.object({ tool: z.literal('execute_code'), parameters: codeAction }).strict(),
  z.object({ tool: z.literal('interactive_form'), parameters: formAction }).strict(),
  z.object({ tool: z.literal('create_task'), parameters: taskParameters }).strict(),
  z.object({ tool: z.literal('save_knowledge'), parameters: knowledgeParameters }).strict(),
  z
    .object({
      tool: z.literal('delegate_agent'),
      parameters: delegationInput.omit({ requestKey: true }),
    })
    .strict(),
]);
export const agentOutput = z
  .object({
    reply: z.string().trim().min(1).max(12000),
    meaningfulChange: z
      .boolean()
      .optional()
      .describe(
        'For proactive checks, set false when current evidence shows no material change worth publishing. Never invent a change.',
      ),
    proposals: z.array(toolProposal).max(4),
  })
  .strict();
export type AgentOutput = z.infer<typeof agentOutput>;
export type ToolProposal = z.infer<typeof toolProposal>;
export const runInput = z
  .object({
    agentId: z.uuid(),
    conversationId: z.uuid(),
    prompt: z.string().trim().min(1).max(12000),
    requestKey: z.uuid(),
  })
  .strict();
export const approvalInput = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().max(1000).default(''),
  })
  .strict();
export interface AgentRun {
  id: string;
  agent_name: string;
  conversation_id: string;
  channel_name: string;
  prompt: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_approval'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'outcome_unknown';
  error_code: string | null;
  created_at: string;
  updated_at: string;
}
export interface ToolInvocation {
  id: string;
  run_id: string;
  agent_name: string;
  channel_name: string;
  tool_name: ToolName;
  parameters: Record<string, string | number>;
  action_digest: string;
  authorization_snapshot?: Record<string, unknown>;
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'succeeded'
    | 'cancelled'
    | 'failed'
    | 'executing'
    | 'outcome_unknown';
  expires_at: string;
  result: Record<string, unknown> | null;
  error_code: string | null;
}
