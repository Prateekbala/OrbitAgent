import { z } from 'zod';

import { toolNames } from '@ao/contracts/tools';
export const agentTools = toolNames;
export const agentSkills = ['planning', 'research', 'verification'] as const;
export const executionLimits = z
  .object({
    maxSeconds: z.number().int().min(10).max(86400).default(300),
    maxInputTokens: z.number().int().min(1000).max(200000).default(60000),
    maxOutputTokens: z.number().int().min(100).max(16000).default(8000),
    maxTools: z.number().int().min(0).max(4).default(4),
    reservationMicros: z.number().int().min(1).max(100000000).default(500000),
  })
  .strict();
export const agentConfiguration = z
  .object({
    instructions: z.string().trim().min(3).max(12000),
    model: z.string().trim().min(1).max(150).default('operator_default'),
    tools: z
      .array(z.enum(agentTools))
      .max(agentTools.length)
      .default(['create_task', 'save_knowledge']),
    skills: z.array(z.enum(agentSkills)).max(3).default([]),
    activation: z.enum(['mentions', 'manual', 'disabled']).default('mentions'),
    conversationIds: z.array(z.uuid()).max(100).default([]),
    limits: executionLimits.default(() => executionLimits.parse({})),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ['tools', 'skills', 'conversationIds'] as const)
      if (new Set(value[key]).size !== value[key].length)
        context.addIssue({ code: 'custom', path: [key], message: 'Choose each value once.' });
  });
export type AgentConfiguration = z.infer<typeof agentConfiguration>;
export const credentialScopes = [
  'inbox.read',
  'inbox.work',
  'messages.read',
  'messages.write',
  'tasks.read',
  'tasks.write',
  'knowledge.read',
  'files.read',
  'search.read',
] as const;
export const credentialInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    scopes: z.array(z.enum(credentialScopes)).min(1).max(credentialScopes.length),
    conversationIds: z.array(z.uuid()).max(100).default([]),
    expiresInDays: z.number().int().min(1).max(90).default(30),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ['scopes', 'conversationIds'] as const)
      if (new Set(value[key]).size !== value[key].length)
        context.addIssue({ code: 'custom', path: [key], message: 'Choose each value once.' });
  });
export const inboxLeaseInput = z
  .object({ leaseSeconds: z.number().int().min(15).max(900).default(120) })
  .strict();
export const inboxResultInput = z
  .object({
    leaseToken: z.uuid(),
    fence: z.number().int().positive(),
    outcome: z.enum(['completed', 'retry', 'failed']),
    summary: z.string().trim().min(1).max(2000),
  })
  .strict();
export const executionPolicyInput = z
  .object({
    version: z.number().int().positive(),
    budgetMicros: z.number().int().min(0).max(1000000000000),
    maxOpenRuns: z.number().int().min(1).max(500),
    maxConcurrentRuns: z.number().int().min(1).max(32),
    maxAgentConcurrent: z.number().int().min(1).max(8),
    maxRequesterConcurrent: z.number().int().min(1).max(16),
    maxDelegationDepth: z.number().int().min(0).max(5),
    maxDelegationChildren: z.number().int().min(0).max(20),
  })
  .strict();
export const delegationInput = z
  .object({
    requestKey: z.uuid(),
    agentId: z.uuid(),
    ownerId: z.uuid(),
    verifierId: z.uuid(),
    taskId: z.uuid().optional(),
    prompt: z.string().trim().min(3).max(12000),
    outputContract: z.string().trim().min(10).max(4000),
    stopCondition: z.string().trim().min(5).max(2000),
    deadline: z.iso.datetime(),
    budgetMicros: z.number().int().min(1).max(100000000),
  })
  .strict();
export interface AgentRevision {
  id: string;
  revision: number;
  configuration: AgentConfiguration;
  created_at: string;
  created_by: string;
}
export interface AgentCredential {
  id: string;
  name: string;
  scopes: string[];
  conversation_ids: string[];
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}
export interface AgentDetail {
  id: string;
  version: number;
  revision: number;
  owner_id: string | null;
  status: string;
  configuration: AgentConfiguration;
  credentials: AgentCredential[];
  health: {
    last_seen_at: string | null;
    open_runs: number;
    pending_deliveries: number;
    dead_letters: number;
  };
  runtime: { configured: boolean; capabilities: Record<string, unknown> };
}
