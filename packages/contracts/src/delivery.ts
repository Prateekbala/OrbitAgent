import { z } from 'zod';

export const deliveryPreferences = z
  .object({
    push: z.boolean().default(false),
    email: z.enum(['off', 'immediate', 'hourly', 'daily']).default('off'),
    timezone: z
      .string()
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, 'Use an IANA timezone.')
      .default('UTC'),
    quietStart: z.number().int().min(0).max(1439).nullable().default(null),
    quietEnd: z.number().int().min(0).max(1439).nullable().default(null),
    batchMinutes: z.number().int().min(0).max(60).default(1),
    minimumPriority: z.enum(['normal', 'high']).default('normal'),
    escalationMinutes: z.number().int().min(5).max(1440).nullable().default(null),
    deviceRouting: z.enum(['all', 'most_recent']).default('most_recent'),
  })
  .strict()
  .refine(
    (v) =>
      (v.quietStart === null) === (v.quietEnd === null) &&
      (v.quietStart === null || v.quietStart !== v.quietEnd),
    { message: 'Set two different quiet-hour boundaries.' },
  );
export const deviceRegistration = z
  .object({
    clientId: z.uuid(),
    name: z.string().trim().min(1).max(80),
    platform: z.enum(['browser', 'desktop', 'ios', 'android']),
    subscription: z
      .object({
        endpoint: z.url().max(2048),
        keys: z
          .object({
            p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
            auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
          })
          .strict(),
      })
      .strict()
      .optional(),
    token: z.string().min(16).max(4096).optional(),
  })
  .strict()
  .refine(
    (v) =>
      ['browser', 'desktop'].includes(v.platform)
        ? Boolean(v.subscription) && !v.token
        : Boolean(v.token) && !v.subscription,
    { message: 'Use a web push subscription or a native device token.' },
  );
export const scopedDeliveryPreference = z
  .object({
    scope: z.enum(['conversation', 'thread', 'agent']),
    resourceId: z.uuid(),
    mode: z.enum(['default', 'muted', 'high']),
  })
  .strict();
export type DeliveryPreferences = z.infer<typeof deliveryPreferences>;
