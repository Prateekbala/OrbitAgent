import { z } from 'zod';
export const uploadChunkBytes = 1024 * 1024;
export const dlpPolicy = z
  .object({
    version: z.number().int().nonnegative(),
    enabled: z.boolean(),
    requireInspection: z.boolean(),
    detectors: z.array(z.enum(['private_key', 'aws_key', 'credit_card', 'ssn'])).max(4),
    sharing: z.boolean(),
    maxShareHours: z.number().int().min(1).max(168),
  })
  .strict();
export const defaultDlpPolicy = {
  version: 0,
  enabled: false,
  requireInspection: true,
  detectors: ['private_key', 'aws_key'],
  sharing: false,
  maxShareHours: 24,
} as const;
export const fileVersionInput = z
  .object({ fileId: z.uuid(), expectedVersion: z.number().int().positive(), clientId: z.uuid() })
  .strict();
export const fileShareInput = z
  .object({
    recipientIds: z.array(z.uuid()).min(1).max(50),
    expiresInHours: z.number().int().min(1).max(168).default(24),
    maxDownloads: z.number().int().min(1).max(100).default(10),
  })
  .strict();
export const shareProof = z
  .object({ id: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
