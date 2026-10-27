import { z } from 'zod';
import { knowledgeKinds } from '@ao/contracts/knowledge';

export const id = z.uuid().transform((value) => value.toLowerCase());
export const signUpInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(128),
    workspace: z.string().trim().min(2).max(80),
  })
  .strict();
export const signInInput = signUpInput.pick({ email: true, password: true });
export const channelInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().max(300).default(''),
    visibility: z.enum(['public', 'private']).default('public'),
  })
  .strict();
export const messageInput = z
  .object({
    format: z.enum(['plain', 'markdown']).default('plain'),
    expectedAuthorId: id.optional(),
    expectedMembershipVersion: z.number().int().positive().optional(),
    expectedAccessInterval: id.nullable().optional(),
    body: z.string().trim().max(12000).default(''),
    clientId: id,
    threadId: id.optional(),
    mentionIds: z
      .array(id)
      .max(50)
      .default([])
      .refine((values) => new Set(values).size === values.length, 'Choose each mention once.'),
    attachmentIds: z
      .array(id)
      .max(10)
      .default([])
      .refine((v) => new Set(v).size === v.length, 'Choose each file once.'),
  })
  .strict()
  .refine((v) => Boolean(v.body) || v.attachmentIds.length > 0, 'Add text or a file.');
export const agentInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    role: z.string().trim().min(3).max(1000),
    runtime: z.enum(['external', 'managed']).default('external'),
  })
  .strict();
export const pageInput = z
  .object({
    kind: z.enum(knowledgeKinds).default('page'),
    title: z.string().trim().min(2).max(200),
    body: z.string().trim().min(1).max(50000),
    conversationId: id.optional(),
  })
  .strict();
export interface Member {
  status?: 'active' | 'suspended';
  version?: number;
  id: string;
  name: string;
  kind: 'human' | 'agent';
  role: 'owner' | 'admin' | 'member';
  access_type?: 'member' | 'guest' | 'service';
  permissions?: Partial<Record<import('./identity.js').Permission, boolean>>;
}
export interface Channel {
  access_interval_id?: string | null;
  archived_at?: string | null;
  history_policy?: 'retained' | 'join_time';
  joined?: boolean;
  id: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  unread_count: number;
  kind: 'channel' | 'direct' | 'group';
  peer_id: string | null;
  title: string | null;
  version: number;
}
export interface Message {
  source_attribution?: {
    provider: string;
    authorName: string;
    authorId: string;
    timestamp: string;
    reactions: { emoji: string; count: number; authorIds: string[] }[];
    files: { sourceId: string; name: string; retained: boolean }[];
    unsupported: string[];
  } | null;
  external_organization?: { organizationId: string; organizationName: string } | null;
  format?: 'plain' | 'markdown';
  mentions?: { id: string; name: string; kind: 'human' | 'agent' }[];
  pinned?: boolean;
  saved?: boolean;
  following?: boolean;
  id: string;
  body: string;
  author_id: string;
  author_name: string;
  author_kind: 'human' | 'agent';
  sequence: number;
  created_at: string;
  thread_id: string | null;
  reply_count: number;
  version: number;
  edited_at: string | null;
  deleted_at: string | null;
  reactions: import('./messaging.js').Reaction[];
  read_by: import('./messaging.js').MessageReader[];
  read_count: number;
  attachments: import('./files.js').FileAttachment[];
}
export interface Agent {
  version?: number;
  revision?: number;
  last_seen_at?: string | null;
  id: string;
  membership_id: string;
  name: string;
  instructions: string;
  status: 'active' | 'paused' | 'archived';
  runtime: 'external' | 'managed';
  owner_id?: string | null;
  created_at: string;
}
export interface Page {
  id: string;
  title: string;
  body: string;
  version: number;
  author_name: string;
  editor_name?: string | null;
  conversation_id: string | null;
  updated_at: string;
}
export interface Bootstrap {
  workspace: { id: string; name: string; retrieval_epoch?: string };
  me: Member;
  members: Member[];
  channels: Channel[];
}
export interface AuditEvent {
  id: string;
  action: string;
  actor_name: string;
  created_at: string;
}
export interface ApiError {
  error: { code: string; message: string; requestId: string };
}
export * from './execution.js';
export * from './team.js';

export * from './account.js';
export * from './messaging.js';

export * from './conversations.js';

export * from './files.js';

export * from './notifications.js';
export * from './activity.js';

export * from './content.js';

export * from './tasks.js';

export * from './scheduling.js';

export * from './task-actions.js';

export * from './projects.js';
export * from './identity.js';
