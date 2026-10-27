import { z } from 'zod';
export const publicScopes = [
  'messages.read',
  'messages.write',
  'tasks.read',
  'tasks.write',
  'knowledge.read',
  'knowledge.write',
  'projects.read',
  'execution.read',
  'execution.manage',
  'search.read',
  'events.read',
  'automations.read',
  'automations.write',
] as const;
export const publicGrant = z
  .object({
    scopes: z
      .array(z.enum(publicScopes))
      .min(1)
      .max(publicScopes.length)
      .refine((v) => new Set(v).size === v.length),
    conversationIds: z
      .array(z.uuid())
      .max(100)
      .default([])
      .refine((v) => new Set(v).size === v.length),
    workspaceResources: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => v.conversationIds.length > 0 || v.workspaceResources,
    'Choose at least one audience.',
  );
export const apiKeyCreate = z
  .object({
    name: z.string().trim().min(2).max(100),
    grants: publicGrant,
    expiresInDays: z.number().int().min(1).max(365).default(30),
    audiences: z
      .array(z.enum(['rest', 'mcp']))
      .min(1)
      .max(2)
      .default(['rest', 'mcp']),
  })
  .strict();
export const oauthClientCreate = z
  .object({
    name: z.string().trim().min(2).max(100),
    redirectUris: z
      .array(
        z
          .url()
          .max(2048)
          .refine((v) => {
            const u = new URL(v);
            return (
              !u.username &&
              !u.password &&
              !u.hash &&
              (u.protocol === 'https:' ||
                (u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)))
            );
          }),
      )
      .min(1)
      .max(10),
  })
  .strict();
export const remoteMcpInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    url: z.url().max(2048),
    conversationIds: z.array(z.uuid()).min(1).max(100),
    token: z.string().min(1).max(8000).optional(),
  })
  .strict();
export type PublicGrant = z.infer<typeof publicGrant>;
export type PublicScope = (typeof publicScopes)[number];
