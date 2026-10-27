import { z } from 'zod';
export const sourceKind = z.enum([
  'message',
  'knowledge',
  'task',
  'file',
  'document',
  'transcript',
  'memory',
]);
export type SourceKind = z.infer<typeof sourceKind>;
export const sourceReference = z
  .object({ kind: sourceKind, id: z.uuid(), version: z.number().int().positive() })
  .strict();
export type SourceReference = z.infer<typeof sourceReference>;
export const retrievalQuery = z
  .object({
    q: z.string().trim().min(1).max(500),
    kinds: z.array(sourceKind).min(1).max(7).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    semantic: z.boolean().default(false),
  })
  .strict();
export const answerQuery = retrievalQuery.extend({
  answerMode: z.enum(['extractive', 'model']).default('extractive'),
});
export const memoryInput = z
  .object({
    agentId: z.uuid(),
    boundary: z.enum(['private', 'conversation', 'workspace']),
    conversationId: z.uuid().optional(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
    sources: z.array(sourceReference).min(1).max(20),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (v) => (v.boundary === 'conversation') === Boolean(v.conversationId),
    'Conversation memory requires exactly one conversation.',
  );
export const memoryCorrection = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
    reason: z.string().trim().min(1).max(1000),
    sources: z.array(sourceReference).min(1).max(20),
  })
  .strict();
export const transcriptInput = z
  .object({
    conversationId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(200000),
    language: z.string().max(35).default('und'),
    consentReference: z.string().trim().min(10).max(1000),
    retainedUntil: z.iso.datetime(),
    clientId: z.uuid(),
  })
  .strict();
export interface RetrievalHit extends SourceReference {
  title: string;
  excerpt: string;
  citation: string;
  score: number;
  freshness: 'current' | 'stale';
  conflict: boolean;
  indexedAt: string;
}
export interface RetrievalResult {
  items: RetrievalHit[];
  contextId: string;
  mode: 'lexical' | 'hybrid';
  truncated: boolean;
  indicators: { missingEvidence: boolean; staleEvidence: boolean; conflictingEvidence: boolean };
}
