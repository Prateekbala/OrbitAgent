import { z } from 'zod';
const id = z.uuid();
const key = z.string().trim().min(1).max(200);
export const migrationProvider = z.enum(['slack', 'teams', 'discord']);
export const importedFile = z
  .object({
    sourceId: key,
    name: z.string().max(255),
    fileId: id.optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();
export const migrationRecord = z
  .object({
    id: key,
    channelId: key,
    authorId: key,
    authorName: z.string().trim().min(1).max(160),
    timestamp: z.iso.datetime({ offset: true }),
    revision: z.string().min(1).max(100),
    body: z.string().max(12000),
    threadId: key.optional(),
    deleted: z.boolean().default(false),
    reactions: z
      .array(
        z
          .object({
            emoji: z.string().min(1).max(100),
            count: z.number().int().nonnegative(),
            authorIds: z.array(key).max(1000).default([]),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    files: z.array(importedFile).max(10).default([]),
    unsupported: z.array(z.string().max(200)).max(30).default([]),
    echoActionId: id.optional(),
  })
  .strict()
  .refine((v) => v.deleted || v.body.length > 0 || v.files.length > 0, 'Provide text or a file.');
export type MigrationRecord = z.infer<typeof migrationRecord>;
export const migrationCreate = z
  .object({
    clientId: id,
    name: z.string().trim().min(1).max(100),
    provider: migrationProvider,
    sourceWorkspaceId: key,
    mode: z.enum(['import', 'inbound', 'bidirectional']).default('import'),
    conflictOwner: z.enum(['source', 'local', 'manual']).default('manual'),
  })
  .strict();
export const migrationMappings = z
  .object({
    version: z.number().int().positive(),
    channels: z
      .array(
        z
          .object({
            sourceId: key,
            conversationId: id,
            visibility: z.enum(['public', 'private']),
            authorized: z.literal(true),
            acknowledgeAudienceExpansion: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    identities: z
      .array(
        z
          .object({ sourceId: key, name: z.string().min(1).max(160), membershipId: id.nullable() })
          .strict(),
      )
      .max(1000)
      .default([]),
  })
  .strict();
export const migrationBatch = z
  .object({
    clientId: id,
    cursor: z.string().max(2000).nullable().default(null),
    complete: z.boolean().default(false),
    records: z.array(migrationRecord).max(100),
  })
  .strict();
export const migrationControl = z
  .object({
    version: z.number().int().positive(),
    action: z.enum(['start', 'pause', 'disconnect']),
  })
  .strict();
export const migrationResolve = z
  .object({ action: z.enum(['source', 'local', 'omit']), version: z.number().int().positive() })
  .strict();
export const sharedPolicy = z
  .object({
    history: z.enum(['join_time', 'retained']).default('join_time'),
    retentionDays: z.number().int().min(1).max(3650),
    export: z.boolean().default(false),
    recording: z.literal(false).default(false),
    agents: z.boolean().default(false),
  })
  .strict();
export type SharedPolicy = z.infer<typeof sharedPolicy>;
export const sharedInvite = z
  .object({
    conversationId: id,
    organizationId: id,
    policy: sharedPolicy,
    expiresInDays: z.number().int().min(1).max(30).default(7),
  })
  .strict();
export const sharedAccept = z
  .object({
    token: z.string().min(40).max(100),
    policy: sharedPolicy,
    membershipIds: z.array(id).min(1).max(100),
  })
  .strict();
export const sharedParticipants = z
  .object({ version: z.number().int().positive(), membershipIds: z.array(id).max(100) })
  .strict();
