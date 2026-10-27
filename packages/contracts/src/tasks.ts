import type { TaskLabelRef } from './projects.js';
import { z } from 'zod';
const id = z.uuid().transform((value) => value.toLowerCase());
const calendarDate = z.iso
  .date()
  .refine((value) => value >= '0001-01-01', 'Choose a year from 1 through 9999.');
const version = z.number().int().positive().max(2147483647);
export const taskStates = [
  'proposed',
  'queued',
  'active',
  'blocked',
  'awaiting_approval',
  'awaiting_review',
  'completed',
  'failed',
  'cancelled',
] as const;
export const taskMoves: Record<
  (typeof taskStates)[number],
  readonly (typeof taskStates)[number][]
> = {
  proposed: ['queued', 'cancelled'],
  queued: ['active', 'cancelled'],
  active: ['blocked', 'awaiting_approval', 'awaiting_review', 'failed', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  awaiting_approval: ['active', 'blocked', 'cancelled'],
  awaiting_review: ['completed', 'queued', 'cancelled'],
  failed: ['queued', 'cancelled'],
  completed: [],
  cancelled: [],
};
export const taskLabels: Record<(typeof taskStates)[number], string> = {
  proposed: 'Proposed',
  queued: 'Queued',
  active: 'In progress',
  blocked: 'Blocked',
  awaiting_approval: 'Needs approval',
  awaiting_review: 'In review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export const taskInput = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(12000).default(''),
    assigneeId: id.optional(),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
    conversationId: id.optional(),
    parentId: id.optional(),
    dueDate: calendarDate.optional(),
    projectId: id.optional(),
    milestoneId: id.optional(),
    labelIds: z
      .array(id)
      .max(20)
      .refine((v) => new Set(v).size === v.length, 'Choose each label once.')
      .transform((v) => v.sort())
      .optional(),
    clientId: id.optional(),
  })
  .strict();
export const taskUpdate = z
  .object({
    version,
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(12000).optional(),
    assigneeId: id.nullable().optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    dueDate: calendarDate.nullable().optional(),
    parentId: id.nullable().optional(),
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
  .refine((value) => Object.keys(value).length > 1, 'Choose a field to update.');
export const taskTransition = z
  .object({ state: z.enum(taskStates), version, evidence: z.string().trim().max(2000).default('') })
  .strict();
export const taskDependency = z.object({ version, dependsOnId: id }).strict();
export const taskVersion = z.object({ version }).strict();
export const taskListQuery = z
  .object({
    q: z.string().trim().max(200).default(''),
    projectId: id.optional(),
    milestoneId: id.optional(),
    labelId: id.optional(),
    noProject: z.enum(['true']).optional(),
    state: z.enum(taskStates).optional(),
    assigneeId: id.optional(),
    unassigned: z.enum(['true']).optional(),
    conversationId: id.optional(),
    workspaceOnly: z.enum(['true']).optional(),
    parentId: id.optional(),
    roots: z.enum(['true']).optional(),
    overdue: z.enum(['true']).optional(),
    asOf: calendarDate.optional(),
    dueFrom: calendarDate.optional(),
    dueThrough: calendarDate.optional(),
    sort: z.enum(['newest', 'due', 'priority']).default('newest'),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(2048).optional(),
  })
  .strict()
  .refine((q) => !q.assigneeId || !q.unassigned, 'Choose an assignee or unassigned.')
  .refine((q) => !q.projectId || !q.noProject, 'Choose a project or unassigned projects.')
  .refine((q) => !q.parentId || !q.roots, 'Choose a parent or root tasks.')
  .refine(
    (q) => !q.dueFrom || !q.dueThrough || q.dueFrom <= q.dueThrough,
    'Choose a valid date range.',
  )
  .refine((q) => !q.workspaceOnly || !q.conversationId, 'Choose one audience filter.');
export const taskPageQuery = z
  .object({
    before: z.coerce.number().int().positive().max(2147483647).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const taskRelationQuery = z
  .object({
    kind: z.enum(['subtasks', 'dependencies', 'dependents']),
    after: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const taskCommentInput = z
  .object({ body: z.string().trim().min(1).max(12000), clientId: id })
  .strict();
export const taskCommentEdit = z
  .object({ body: z.string().trim().min(1).max(12000), version })
  .strict();
export interface Task {
  start_date?: string | null;
  estimate?: number | null;
  is_collaborator?: boolean;
  id: string;
  title: string;
  description: string;
  state: (typeof taskStates)[number];
  priority: 'low' | 'normal' | 'high';
  assignee_id: string | null;
  assignee_name: string | null;
  created_by: string | null;
  creator_name: string | null;
  parent_id: string | null;
  conversation_id: string | null;
  due_date: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  subtask_count: number;
  closed_subtask_count: number;
  dependency_count: number;
  unresolved_dependency_count: number;
  comment_count: number;
  attachment_count: number;
  project_id: string | null;
  project_name: string | null;
  milestone_id: string | null;
  milestone_title: string | null;
  labels: TaskLabelRef[];
}
export interface TaskPage {
  items: Task[];
  next_cursor: string | null;
}
export interface TaskRelations {
  items: Task[];
  next_after: string | null;
}
export interface TaskDetails {
  task: Task;
  parent: Task | null;
  can_manage: boolean;
}
export interface TaskComment {
  id: string;
  task_id: string;
  author_id: string;
  author_name: string;
  author_kind: 'human' | 'agent';
  body: string;
  sequence: number;
  version: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}
export interface TaskComments {
  items: TaskComment[];
  next_before: number | null;
}
export interface TaskTransitionRecord {
  id: string;
  actor_name: string;
  from_state: Task['state'];
  to_state: Task['state'];
  evidence: string;
  created_at: string;
  sequence: number;
}
export interface TaskHistory {
  items: TaskTransitionRecord[];
  next_before: number | null;
}
