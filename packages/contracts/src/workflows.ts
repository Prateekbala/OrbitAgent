import { z } from 'zod';
import { taskStates } from '@ao/contracts/tasks';
const id = z.uuid().transform((v) => v.toLowerCase());
export const revision = z.number().int().min(1).max(2147483646);
export const workPage = z
  .object({ after: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })
  .strict();
export const taskParticipantInput = z
  .object({
    version: revision,
    membershipId: id,
    role: z.enum(['watcher', 'collaborator']),
    remove: z.boolean().default(false),
  })
  .strict();
export const criterionInput = z
  .object({
    version: revision,
    text: z.string().trim().min(1).max(2000),
    required: z.boolean().default(true),
  })
  .strict();
export const criterionReview = z
  .object({
    version: revision,
    accepted: z.boolean(),
    evidence: z.string().trim().max(4000).default(''),
    artifactId: id.nullable().default(null),
  })
  .strict()
  .refine((v) => !v.accepted || v.evidence.length > 0, 'Verification evidence is required.');
export const artifactInput = z
  .object({
    clientId: id,
    kind: z.enum(['link', 'file', 'decision', 'test_result', 'document']),
    title: z.string().trim().min(1).max(200),
    url: z
      .url()
      .max(4000)
      .refine((v) => /^https?:\/\//i.test(v))
      .optional(),
    fileId: id.optional(),
    details: z.string().trim().max(12000).default(''),
    outcome: z.enum(['proposed', 'passed', 'failed']).default('proposed'),
  })
  .strict()
  .refine((v) => v.kind !== 'file' || Boolean(v.fileId), 'Choose a task attachment.');
export const sourceInput = z
  .object({ messageId: id, kind: z.enum(['discussion', 'decision']).default('discussion') })
  .strict();
export const taskRunInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), runId: id }).strict(),
  z
    .object({
      action: z.literal('start'),
      agentId: id,
      prompt: z.string().trim().min(1).max(12000),
      clientId: id,
    })
    .strict(),
]);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const target = z.string().regex(/^(source|[a-z][a-z0-9_]{0,39})$/);
const createStep = z
  .object({
    key,
    type: z.literal('create_task'),
    title: z.string().trim().min(3).max(200),
    description: z.string().max(12000).default(''),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
    assigneeId: id.optional(),
    dueDays: z.number().int().min(0).max(366).optional(),
    businessCalendarId: id.optional(),
    parentStep: key.optional(),
    criteria: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
  })
  .strict();
export const workflowStep = z.discriminatedUnion('type', [
  createStep,
  z
    .object({
      key,
      type: z.literal('transition_task'),
      target,
      state: z.enum(['queued', 'active', 'blocked', 'awaiting_review', 'cancelled']),
      evidence: z.string().max(2000).default(''),
    })
    .strict(),
  z
    .object({
      key,
      type: z.literal('wait_for_task'),
      target,
      states: z.array(z.enum(taskStates)).min(1).max(9),
    })
    .strict(),
  z
    .object({ key, type: z.literal('approval'), instructions: z.string().trim().min(1).max(4000) })
    .strict(),
  z
    .object({
      key,
      type: z.literal('run_agent'),
      target,
      agentId: id,
      prompt: z.string().trim().min(1).max(12000),
    })
    .strict(),
]);
export const templateDefinition = z
  .object({
    steps: z.array(workflowStep).min(1).max(50),
    timeoutMinutes: z.number().int().min(1).max(10080).default(1440),
    escalationMemberId: id.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const previous = new Set<string>(),
      seen = new Set<string>();
    for (const [index, step] of v.steps.entries()) {
      if (seen.has(step.key) || step.key === 'source')
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'key'],
          message: 'Step keys must be unique and cannot be source.',
        });
      const reference =
        'target' in step ? step.target : 'parentStep' in step ? step.parentStep : undefined;
      if (reference && reference !== 'source' && !previous.has(reference))
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index],
          message: 'Reference an earlier create-task step.',
        });
      seen.add(step.key);
      if (step.type === 'create_task') previous.add(step.key);
    }
  });
export const templateInput = z
  .object({
    clientId: id,
    name: z.string().trim().min(2).max(160),
    kind: z.enum(['task', 'workflow']),
    conversationId: id.optional(),
    definition: templateDefinition,
  })
  .strict();
export const templateRevision = z
  .object({
    version: revision,
    name: z.string().trim().min(2).max(160),
    definition: templateDefinition,
  })
  .strict();
export const templatePublish = z
  .object({ version: revision, revision: revision, archived: z.boolean().default(false) })
  .strict();
export const workflowStart = z
  .object({
    clientId: id,
    revision: revision,
    sourceTaskId: id.optional(),
    projectId: id.optional(),
  })
  .strict();
export const triggerInput = z
  .object({
    clientId: id,
    templateId: id,
    revision: revision,
    event: z.enum(['task.created', 'task.updated', 'task.transitioned', 'task.comment_created']),
    state: z.enum(taskStates).optional(),
    projectId: id.optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const workflowDecision = z
  .object({ version: revision, approve: z.boolean(), evidence: z.string().trim().min(1).max(4000) })
  .strict();
export const replayInput = z.object({ clientId: id, version: revision }).strict();
export const taskPlanInput = z
  .object({
    version: revision,
    startDate: z.iso.date().nullable(),
    estimate: z.number().min(0).max(100000).nullable(),
  })
  .strict();
export const portfolioInput = z
  .object({
    clientId: id,
    name: z.string().trim().min(2).max(160),
    conversationId: id.optional(),
    projectIds: z
      .array(id)
      .max(200)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const portfolioUpdate = z
  .object({
    version: revision,
    name: z.string().trim().min(2).max(160),
    projectIds: z
      .array(id)
      .max(200)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const businessCalendarInput = z
  .object({
    version: z.number().int().min(0).max(2147483646),
    name: z.string().trim().min(2).max(160),
    timeZone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((v) => new Set(v).size === v.length),
    holidays: z
      .array(z.iso.date())
      .max(3660)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof templateDefinition>;
export type WorkflowStep = z.infer<typeof workflowStep>;
export interface BusinessCalendar {
  id: string;
  name: string;
  time_zone: string;
  weekdays: number[];
  holidays: string[];
  version: number;
}
export interface WorkTemplate {
  id: string;
  name: string;
  kind: 'task' | 'workflow';
  conversation_id: string | null;
  created_by: string;
  version: number;
  latest_revision: number;
  published_revision: number | null;
  archived: boolean;
  definition?: WorkflowDefinition;
}
export interface WorkflowRun {
  id: string;
  template_id: string;
  template_name: string;
  template_revision: number;
  source_task_id: string | null;
  project_id: string | null;
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  next_step: number;
  version: number;
  error_code: string | null;
  escalated_at: string | null;
  replay_of: string | null;
  created_at: string;
  deadline_at: string;
  steps?: {
    step_key: string;
    label?: string;
    status: string;
    output: Record<string, unknown>;
    error_code: string | null;
    attempts: number;
  }[];
}
export interface WorkPage<T> {
  items: T[];
  next_after: string | null;
}
export interface Criterion {
  id: string;
  text: string;
  required: boolean;
  accepted: boolean;
  evidence: string;
  reviewer_name: string | null;
  artifact_id: string | null;
}
export interface TaskWork {
  participants: { membership_id: string; name: string; role: 'watcher' | 'collaborator' }[];
  criteria: Criterion[];
  artifacts: {
    id: string;
    kind: string;
    title: string;
    url: string | null;
    details: string;
    outcome: string;
    file_id: string | null;
    creator_name: string;
  }[];
  sources: {
    id: string;
    message_id: string;
    kind: string;
    body: string;
    conversation_id: string;
  }[];
}
export interface ProjectReport {
  project: { id: string; name: string };
  states: { state: string; count: number; estimate: number }[];
  assignees: { name: string; count: number; overdue: number; estimate: number }[];
  velocity: { week: string; completed: number }[];
  totals: {
    tasks: number;
    completed: number;
    overdue: number;
    blocked: number;
    estimated: number;
    completed_estimate: number;
  };
}
