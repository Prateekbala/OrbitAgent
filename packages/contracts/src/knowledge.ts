import { z } from 'zod';
export const knowledgeKinds = [
  'page',
  'dictionary',
  'decision',
  'procedure',
  'project_context',
  'summary',
  'journal',
] as const;
export const knowledgeGovernance = z
  .object({
    version: z.number().int().positive(),
    ownerId: z.uuid(),
    kind: z.enum(knowledgeKinds),
    reviewers: z.array(z.uuid()).max(20),
    freshUntil: z.iso.datetime().nullable(),
    state: z.enum(['active', 'archived']),
    supersededBy: z.uuid().nullable(),
  })
  .strict()
  .refine((v) => new Set(v.reviewers).size === v.reviewers.length, 'Reviewers must be unique.');
export const sourceInput = z
  .object({ type: z.enum(['page', 'message']), id: z.uuid(), version: z.number().int().positive() })
  .strict();
export const knowledgeComment = z
  .object({
    clientId: z.uuid(),
    body: z.string().trim().min(1).max(5000),
    anchor: z.string().max(200).default(''),
  })
  .strict();
export const knowledgeSync = z
  .object({
    generation: z.uuid(),
    update: z
      .string()
      .min(4)
      .max(350000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export const knowledgeSchedule = z
  .object({
    enabled: z.boolean(),
    intervalDays: z.number().int().min(1).max(365),
    sourceIds: z.array(z.uuid()).min(1).max(20),
  })
  .strict();
export interface KnowledgeGovernance {
  page_id: string;
  owner_id: string;
  owner_name: string;
  kind: (typeof knowledgeKinds)[number];
  state: 'active' | 'archived' | 'deleted';
  review_epoch: number;
  review_state: 'draft' | 'in_review' | 'approved' | 'stale' | 'contradicted';
  version: number;
  fresh_until: string | null;
  superseded_by: string | null;
  blocked: boolean;
  reviewers: { member_id: string; name: string }[];
  sources: {
    id: string;
    source_page_id: string | null;
    source_message_id: string | null;
    source_version: number;
    stale: boolean;
  }[];
  comments: {
    id: string;
    body: string;
    anchor: string;
    author_id: string;
    author_name: string;
    resolved_at: string | null;
    created_at: string;
  }[];
  proposals: {
    id: string;
    title: string;
    body: string;
    base_version: number;
    status: string;
    created_at: string;
  }[];
  schedule: {
    enabled: boolean;
    interval_days: number;
    source_ids: string[];
    next_at: string;
  } | null;
}
export interface KnowledgeSyncState {
  generation: string;
  update: string;
  version: number;
  title: string;
  body: string;
}
