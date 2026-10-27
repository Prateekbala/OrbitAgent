import { z } from 'zod';
export const usageCategories = ['models', 'tools', 'runtime', 'storage', 'media'] as const;
export const billingBudget = z
  .object({
    version: z.number().int().positive(),
    budgetMicros: z
      .string()
      .regex(/^\d{1,15}$/)
      .nullable(),
    warningPercent: z.number().int().min(1).max(99),
  })
  .strict();
export const trialInput = z.object({ clientId: z.uuid() }).strict();
export const usageReservation = z
  .object({
    category: z.enum(usageCategories),
    reference: z.uuid(),
    units: z.string().regex(/^\d{1,15}$/),
    costMicros: z.string().regex(/^\d{1,15}$/),
  })
  .strict();
export interface BillingSummary {
  organizationId: string;
  mode: 'self_hosted' | 'managed';
  status: string;
  plan: string;
  version: number;
  trialEndsAt: string | null;
  periodStart: string;
  periodEnd: string;
  seats: number;
  seatLimit: number;
  budgetMicros: string | null;
  warningPercent: number;
  spentMicros: string;
  reservedMicros: string;
  forecastMicros: string;
  warnings: string[];
  usage: { category: string; units: string; reservedUnits: string; costMicros: string }[];
  allowances: Record<string, number>;
  entitlements: Record<string, boolean>;
  checkoutAvailable: boolean;
}
