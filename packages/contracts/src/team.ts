import { z } from 'zod';
export const invitationInput = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    role: z.enum(['admin', 'member']).default('member'),
    accessType: z.enum(['member', 'guest']).default('member'),
    conversationIds: z.array(z.uuid()).max(100).default([]),
  })
  .strict();
export const invitationToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const invitationAcceptance = z
  .object({
    token: invitationToken,
    name: z.string().trim().min(1).max(80).optional(),
    password: z.string().min(12).max(128).optional(),
  })
  .strict();
export const memberUpdate = z
  .object({
    role: z.enum(['owner', 'admin', 'member']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    version: z.number().int().positive(),
  })
  .strict()
  .refine((value) => Boolean(value.role || value.status), 'Choose a role or access change.');
export interface TeamMember {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  role: 'owner' | 'admin' | 'member';
  status: 'active' | 'suspended';
  version: number;
  access_type?: 'member' | 'guest' | 'service';
  permissions?: Partial<Record<import('./identity.js').Permission, boolean>>;
  account_id?: string | null;
}
export interface Invitation {
  delivery_status?:
    'queued' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'outcome_unknown' | null;
  delivery_error?: string | null;
  id: string;
  email: string;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'revoked';
  expires_at: string;
  created_at: string;
}
export interface WorkspaceMembership {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
}
