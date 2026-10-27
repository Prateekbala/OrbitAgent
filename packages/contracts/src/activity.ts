import { z } from 'zod';
const id = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const presenceHeartbeat = z
  .object({ clientId: id, revision, state: z.enum(['active', 'away']) })
  .strict();
export const presencePreference = z
  .object({ mode: z.enum(['automatic', 'away', 'invisible']) })
  .strict();
export const presenceLeave = z.object({ clientId: id }).strict();
export const typingInput = z
  .object({ clientId: id, revision, threadId: id.optional(), active: z.boolean() })
  .strict();
export const activitySnapshot = z.object({
  presence_complete: z.boolean().optional(),
  sampled_at: z.string().optional(),
  presence_lease_ms: z.number().int().positive().optional(),
  own_mode: z.enum(['automatic', 'away', 'invisible']),
  presence: z.array(z.object({ membership_id: id, state: z.enum(['online', 'away']) })).max(1000),
  typing: z
    .array(
      z.object({
        membership_id: id,
        name: z.string(),
        conversation_id: id,
        thread_id: id.nullable(),
        expires_in_ms: z.number().min(0).max(8000),
      }),
    )
    .max(100),
});
export type ActivitySnapshot = z.infer<typeof activitySnapshot>;
export type PresenceMode = z.infer<typeof presencePreference>['mode'];
export type PresenceState = 'online' | 'away' | 'offline' | 'unknown';
