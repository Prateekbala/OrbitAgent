import { z } from 'zod';
import type { Message } from './index.js';

export interface MessageHistory {
  items: Message[];
  older: number | null;
  newer: number | null;
}

const uuid = z.uuid().transform((value) => value.toLowerCase());
const position = z.coerce.number().int().positive().max(2147483647);
export const historyQuery = z
  .object({
    threadId: uuid.optional(),
    before: position.optional(),
    after: position.optional(),
    around: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (q) => [q.before, q.after, q.around].filter((v) => v !== undefined).length <= 1,
    'Use only one history position.',
  );

export const advancedSearchQuery = z
  .object({
    q: z.string().trim().max(300).default(''),
    scope: z.enum(['messages', 'knowledge']).default('messages'),
    conversationId: uuid.optional(),
    authorId: uuid.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    attachments: z.enum(['true']).optional(),
    threads: z.enum(['replies', 'main']).optional(),
    sort: z.enum(['relevance', 'newest', 'oldest']).default('relevance'),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(2048).optional(),
  })
  .strict()
  .refine(
    (q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to),
    'The end date must follow the start date.',
  )
  .refine(
    (q) => q.scope === 'messages' || (!q.attachments && !q.threads),
    'Attachment and thread filters apply to messages.',
  );
export type AdvancedSearchQuery = z.infer<typeof advancedSearchQuery>;
export interface SearchResult {
  id: string;
  title: string | null;
  body: string;
  conversation_id: string | null;
  thread_id: string | null;
  author_name: string;
  channel_name: string | null;
  created_at: string;
  version: number;
}
export interface SearchPage {
  items: SearchResult[];
  next_cursor: string | null;
}
export const knowledgeEdit = z
  .object({
    version: position,
    title: z.string().trim().min(2).max(200),
    body: z.string().trim().min(1).max(50000),
    summary: z.string().trim().max(500).default(''),
    clientId: uuid,
  })
  .strict();
export const knowledgeRestore = z
  .object({
    version: position,
    targetVersion: position,
    summary: z.string().trim().max(500).default(''),
    clientId: uuid,
  })
  .strict();
export const versionHistoryQuery = z
  .object({
    before: position.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export interface KnowledgeVersion {
  version: number;
  author_name: string;
  created_at: string;
  summary: string;
  restored_from: number | null;
}
export interface KnowledgeSnapshot extends KnowledgeVersion {
  title: string;
  body: string;
}
export interface KnowledgeHistory {
  items: KnowledgeVersion[];
  next_before: number | null;
}
