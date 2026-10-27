import { z } from 'zod';
import type { FileAttachment } from './files.js';
import type { Task } from './tasks.js';
const id = z.uuid().transform((v) => v.toLowerCase());
const version = z.number().int().positive().max(2147483646);
const date = z.iso.date().refine((v) => v >= '0001-01-01' && v <= '9999-12-31');
export const taskAttachmentInput = z
  .object({
    fileIds: z
      .array(id)
      .min(1)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length, 'Choose each file once.'),
  })
  .strict();
export const taskAttachmentQuery = z
  .object({ after: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })
  .strict();
export const taskAttachmentVersion = z.object({ version }).strict();
export interface TaskAttachment extends FileAttachment {
  attached_by: string;
  attached_by_name: string;
  attached_at: string;
  version: number;
}
export interface TaskAttachmentPage {
  items: TaskAttachment[];
  next_after: string | null;
}
const targets = z
  .array(z.object({ id, version, evidence: z.string().trim().max(2000).optional() }).strict())
  .min(1)
  .max(50)
  .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, 'Choose each task once.');
const patch = z
  .object({
    assigneeId: id.nullable().optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    dueDate: date.nullable().optional(),
    projectId: id.nullable().optional(),
    milestoneId: id.nullable().optional(),
    labelIds: z
      .array(id)
      .max(20)
      .refine((v) => new Set(v).size === v.length, 'Choose each label once.')
      .transform((v) => v.sort())
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Choose a field to update.');
export const taskBulkInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update'), clientId: id, targets, patch }).strict(),
  z
    .object({
      action: z.literal('transition'),
      clientId: id,
      targets,
      state: z.enum([
        'proposed',
        'queued',
        'active',
        'blocked',
        'awaiting_approval',
        'awaiting_review',
        'completed',
        'failed',
        'cancelled',
      ]),
    })
    .strict(),
]);
export const taskBulkPreview = z
  .object({
    ids: z
      .array(id)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'Choose each task once.'),
  })
  .strict();
export interface TaskBulkResult {
  items: { id: string; version: number }[];
  replayed: boolean;
}
export interface TaskBulkPreviewResult {
  items: Task[];
}
