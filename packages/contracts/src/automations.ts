import { z } from 'zod';
const uuid = z.uuid();
const version = z.number().int().positive().max(2147483646);
const timezone = z
  .string()
  .max(100)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, 'Choose an IANA timezone.');
export const automationDefinition = z
  .object({
    conversationId: uuid,
    trigger: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('schedule'),
          cron: z.string().trim().min(9).max(120),
          timezone,
          dst: z.enum(['skip_gap', 'shift_gap']).default('skip_gap'),
          missed: z.enum(['skip', 'coalesce', 'catch_up']).default('coalesce'),
          catchUpLimit: z.number().int().min(1).max(10).default(3),
          graceSeconds: z.number().int().min(60).max(86400).default(300),
        })
        .strict(),
      z
        .object({
          kind: z.literal('event'),
          events: z
            .array(
              z.enum([
                'message.created',
                'message.updated',
                'task.created',
                'task.updated',
                'task.transitioned',
                'task.comment_created',
                'knowledge.created',
                'knowledge.updated',
                'connection.resource_imported',
              ]),
            )
            .min(1)
            .max(9),
          ignoreOwner: z.boolean().default(false),
        })
        .strict(),
    ]),
    action: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('agent'),
          agentId: uuid,
          agentRevision: version,
          prompt: z.string().trim().min(1).max(12000),
        })
        .strict(),
      z
        .object({
          kind: z.literal('workflow'),
          templateId: uuid,
          revision: version,
          sourceTaskId: uuid.optional(),
          projectId: uuid.optional(),
        })
        .strict(),
    ]),
    overlap: z.enum(['skip', 'queue']).default('skip'),
    concurrency: z.number().int().min(1).max(10).default(1),
    maxDailySpendMicros: z.number().int().min(0).max(1_000_000_000_000).default(5_000_000),
    maxRunsPerDay: z.number().int().min(1).max(1440).default(24),
    timeoutMinutes: z.number().int().min(1).max(10080).default(60),
    escalationMemberId: uuid.optional(),
    participation: z
      .object({
        enabled: z.boolean().default(true),
        onlyMeaningfulChanges: z.boolean().default(true),
        cooldownMinutes: z.number().int().min(0).max(10080).default(30),
        maxPublicationsPerDay: z.number().int().min(1).max(100).default(12),
        quietHours: z
          .object({
            timezone,
            startHour: z.number().int().min(0).max(23),
            endHour: z.number().int().min(0).max(23),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({
        enabled: true,
        onlyMeaningfulChanges: true,
        cooldownMinutes: 30,
        maxPublicationsPerDay: 12,
      }),
  })
  .strict();
export const automationCreate = z
  .object({
    clientId: uuid,
    name: z.string().trim().min(2).max(120),
    definition: automationDefinition,
  })
  .strict();
export const automationRevision = automationCreate.omit({ clientId: true }).extend({ version });
export const automationControl = z
  .object({ version, action: z.enum(['pause', 'resume', 'archive']) })
  .strict();
export const automationReplay = z
  .object({ clientId: uuid, reason: z.string().trim().min(3).max(1000) })
  .strict();
export const automationTransfer = z.object({ version, membershipId: uuid }).strict();
export type AutomationDefinition = z.infer<typeof automationDefinition>;
