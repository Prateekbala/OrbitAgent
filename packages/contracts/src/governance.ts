import { z } from 'zod';
const names = z
  .array(z.string().trim().min(1).max(150))
  .max(100)
  .refine((v) => new Set(v).size === v.length, 'Duplicate values are not allowed.');
export const governancePolicy = z
  .object({
    version: z.number().int().nonnegative(),
    hostedExecution: z.boolean(),
    agentCreation: z.boolean(),
    models: names,
    tools: names,
    connections: z.boolean(),
    connectionProviders: names,
    internalSharing: z.boolean(),
    externalSharing: z.boolean(),
    recordingModes: z
      .array(z.enum(['no_recording', 'transient_captions', 'retained_recording']))
      .min(1)
      .max(3),
    voiceAgents: z.boolean(),
    exports: z.boolean(),
    supportAccess: z.boolean(),
    byok: z.enum(['optional', 'disabled', 'required']),
    attestedEgress: z.boolean(),
    retentionDays: z.number().int().min(1).max(36500).nullable(),
    backupMaxDays: z.number().int().min(1).max(365),
    analytics: z.boolean(),
  })
  .strict();
export const defaultGovernancePolicy = {
  version: 0,
  hostedExecution: true,
  agentCreation: true,
  models: [],
  tools: [],
  connections: true,
  connectionProviders: [],
  internalSharing: true,
  externalSharing: true,
  recordingModes: ['no_recording', 'transient_captions', 'retained_recording'],
  voiceAgents: true,
  exports: true,
  supportAccess: false,
  byok: 'optional',
  attestedEgress: false,
  retentionDays: null,
  backupMaxDays: 35,
  analytics: false,
} as const;
export const supportGrantInput = z
  .object({
    accountId: z.uuid(),
    workspaceIds: z.array(z.uuid()).min(1).max(50),
    purpose: z.string().trim().min(20).max(1000),
    ticket: z.string().trim().min(3).max(200),
    minutes: z.number().int().min(5).max(120),
  })
  .strict();
export const legalHoldInput = z
  .object({
    workspaceId: z.uuid(),
    conversationId: z.uuid().nullable(),
    reason: z.string().trim().min(20).max(1000),
    reference: z.string().trim().min(3).max(200),
  })
  .strict();
export const auditQuery = z.object({
  after: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(120).optional(),
  workspaceId: z.uuid().optional(),
});
