import { z } from 'zod';
const id = z.uuid().transform((v) => v.toLowerCase()),
  version = z.number().int().positive().max(2147483646);
const date = z.iso.date().refine((v) => v >= '0001-01-01' && v <= '9999-12-31');
export const projectStates = ['planned', 'active', 'paused', 'completed', 'archived'] as const;
export const milestoneStates = ['planned', 'active', 'completed', 'cancelled'] as const;
export const labelColors = ['sage', 'blue', 'amber', 'rose', 'violet', 'slate'] as const;
export const projectInput = z
  .object({
    clientId: id,
    name: z.string().trim().min(2).max(160),
    description: z.string().trim().max(12000).default(''),
    conversationId: id.optional(),
    ownerId: id.optional(),
    status: z.enum(projectStates).default('planned'),
    startDate: date.nullable().default(null),
    targetDate: date.nullable().default(null),
  })
  .strict()
  .refine(
    (v) => !v.startDate || !v.targetDate || v.startDate <= v.targetDate,
    'Target date must follow the start date.',
  );
export const projectUpdate = z
  .object({
    version,
    name: z.string().trim().min(2).max(160).optional(),
    description: z.string().trim().max(12000).optional(),
    ownerId: id.optional(),
    status: z.enum(projectStates).optional(),
    startDate: date.nullable().optional(),
    targetDate: date.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, 'Choose a project field.');
export const milestoneInput = z
  .object({
    clientId: id,
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(12000).default(''),
    status: z.enum(milestoneStates).default('planned'),
    dueDate: date.nullable().default(null),
  })
  .strict();
export const milestoneUpdate = z
  .object({
    version,
    title: z.string().trim().min(2).max(160).optional(),
    description: z.string().trim().max(12000).optional(),
    status: z.enum(milestoneStates).optional(),
    dueDate: date.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, 'Choose a milestone field.');
export const labelInput = z
  .object({
    clientId: id,
    name: z.string().trim().min(1).max(50),
    color: z.enum(labelColors).default('sage'),
  })
  .strict();
export const labelUpdate = z
  .object({
    version,
    name: z.string().trim().min(1).max(50).optional(),
    color: z.enum(labelColors).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, 'Choose a label field.');
export const projectQuery = z
  .object({
    q: z.string().trim().max(200).default(''),
    status: z.enum(projectStates).optional(),
    conversationId: id.optional(),
    workspaceOnly: z.enum(['true']).optional(),
    after: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict()
  .refine((v) => !v.conversationId || !v.workspaceOnly, 'Choose one audience.');
export const organizationPageQuery = z
  .object({ after: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })
  .strict();
export const labelQuery = z
  .object({
    q: z.string().trim().max(50).default(''),
    archived: z.enum(['true', 'false', 'all']).default('false'),
    after: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export interface Project {
  id: string;
  name: string;
  description: string;
  status: (typeof projectStates)[number];
  conversation_id: string | null;
  owner_id: string;
  owner_name: string;
  created_by: string;
  version: number;
  start_date: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  task_count: number;
  completed_count: number;
  cancelled_count: number;
  overdue_count: number;
}
export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: (typeof milestoneStates)[number];
  due_date: string | null;
  version: number;
  task_count: number;
  completed_count: number;
  cancelled_count: number;
}
export interface WorkLabel {
  id: string;
  name: string;
  color: (typeof labelColors)[number];
  archived: boolean;
  created_by: string;
  version: number;
}
export type TaskLabelRef = Pick<WorkLabel, 'id' | 'name' | 'color' | 'archived'>;
export interface ProjectDetails {
  project: Project;
  can_manage: boolean;
}
export interface ProjectPage {
  items: Project[];
  next_after: string | null;
}
export interface MilestonePage {
  items: Milestone[];
  next_after: string | null;
}
export interface LabelPage {
  items: WorkLabel[];
  next_after: string | null;
}
