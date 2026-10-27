import { z } from 'zod';
const uuid = z.uuid();
export const permissions = [
  'messages.read',
  'messages.write',
  'tasks.read',
  'tasks.write',
  'knowledge.read',
  'knowledge.write',
  'files.read',
  'files.write',
  'projects.read',
  'projects.write',
  'people.read',
  'people.manage',
  'agents.read',
  'agents.manage',
  'execution.read',
  'execution.manage',
  'workspace.manage',
] as const;
export type Permission = (typeof permissions)[number];
export const servicePermissions = [
  'messages.read',
  'messages.write',
  'tasks.read',
  'tasks.write',
  'knowledge.read',
  'knowledge.write',
  'files.read',
  'files.write',
  'projects.read',
  'people.read',
] as const;
export const permissionOverrides = z.partialRecord(z.enum(permissions), z.boolean());
export const profileInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    timeZone: z
      .string()
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, 'Choose a valid time zone.'),
    locale: z.enum(['en', 'en-GB', 'fr', 'de', 'es', 'hi', 'ja']),
  })
  .strict();
export const securityProof = z
  .object({ password: z.string().min(1).max(128), code: z.string().trim().max(64).optional() })
  .strict();
export const changePasswordInput = securityProof.extend({
  newPassword: z.string().min(12).max(128),
});
export const changeEmailInput = securityProof.extend({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
});
export const mfaCode = z.object({ code: z.string().trim().min(6).max(64) }).strict();
export const organizationInput = z.object({ name: z.string().trim().min(2).max(80) }).strict();
export const regions = ['global', 'us', 'eu', 'in', 'ap'] as const;
export const organizationPolicyInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    allowedDomains: z
      .array(
        z
          .string()
          .toLowerCase()
          .max(253)
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
      )
      .max(50),
    allowedRegions: z.array(z.enum(regions)).min(1).max(5),
    requireMfa: z.boolean(),
    requireSso: z.boolean(),
    sessionHours: z.number().int().min(1).max(168),
    version: z.number().int().positive(),
  })
  .strict();
export const workspaceCreateInput = organizationInput.extend({ region: z.enum(regions) });
export const organizationMemberInput = z
  .object({
    accountId: uuid,
    role: z.enum(['admin', 'member']).optional(),
    workspaceIds: z.array(uuid).max(100).default([]),
  })
  .strict();
export const offboardInput = z
  .object({ successorId: uuid.optional(), version: z.number().int().positive() })
  .strict();
export const accessInput = z
  .object({
    accessType: z.enum(['member', 'guest']),
    permissions: permissionOverrides,
    conversationIds: z.array(uuid).max(100),
    version: z.number().int().positive(),
  })
  .strict();
export const serviceAccountInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    permissions: z.array(z.enum(servicePermissions)).min(1).max(servicePermissions.length),
    conversationIds: z.array(uuid).min(1).max(100),
    expiresInDays: z.number().int().min(1).max(365).default(90),
  })
  .strict();
export const credentialInput = z
  .object({
    label: z.string().trim().min(2).max(80),
    expiresInDays: z.number().int().min(1).max(365).default(90),
  })
  .strict();
export const providerInput = z.discriminatedUnion('protocol', [
  z
    .object({
      protocol: z.literal('oidc'),
      name: z.string().trim().min(2).max(80),
      issuer: z.url().max(2000),
      clientId: z.string().min(1).max(500),
      clientSecret: z.string().min(1).max(4000),
      workspaceId: uuid,
      jitProvisioning: z.boolean().default(false),
      enabled: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      protocol: z.literal('saml'),
      name: z.string().trim().min(2).max(80),
      entryPoint: z.url().max(2000),
      issuer: z.string().min(1).max(1000),
      idpCert: z.string().min(100).max(16000),
      workspaceId: uuid,
      jitProvisioning: z.boolean().default(false),
      enabled: z.boolean().default(true),
    })
    .strict(),
]);
export interface AccountProfile {
  id: string;
  email: string;
  name: string;
  time_zone: string;
  locale: string;
  mfa_enabled: boolean;
  pending_email: string | null;
}
export interface AccountSession {
  id: string;
  current: boolean;
  workspace_name: string;
  user_agent: string;
  ip_address: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  authentication_method: string;
  mfa_verified_at: string | null;
}
export interface Organization {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  allowed_domains: string[];
  allowed_regions: string[];
  require_mfa: boolean;
  require_sso: boolean;
  session_hours: number;
  version: number;
}
export interface OrganizationMember {
  account_id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  status: 'active' | 'suspended';
  version: number;
}
export interface OrganizationWorkspace {
  id: string;
  name: string;
  region: string;
  membership_id: string | null;
}
export interface IdentityProvider {
  id: string;
  name: string;
  protocol: 'oidc' | 'saml';
  enabled: boolean;
  version: number;
  configuration: Record<string, string | boolean>;
}
