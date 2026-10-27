import { z } from 'zod';
import { automationDefinition } from '@ao/contracts/automations';
const uuid = z.uuid(),
  timestamp = z.iso.datetime(),
  version = z.number().int().positive();
const identifier = z.object({ id: uuid, replayed: z.boolean().optional() }).passthrough();
const mutation = z.object({ ok: z.boolean(), version }).passthrough();
const task = z
  .object({
    id: uuid,
    title: z.string(),
    description: z.string(),
    state: z.string(),
    version,
    conversation_id: uuid.nullable(),
    priority: z.string(),
    due_date: z.string().nullable(),
    assignee_id: uuid.nullable(),
    created_by: uuid,
  })
  .passthrough();
const message = z
  .object({
    id: uuid,
    body: z.string(),
    author_id: uuid,
    author_name: z.string(),
    sequence: z.number().int(),
    version,
    conversation_id: uuid.optional(),
    thread_id: uuid.nullable(),
    created_at: timestamp,
    deleted_at: timestamp.nullable(),
    reactions: z.array(z.record(z.string(), z.unknown())),
    attachments: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();
const knowledge = z
  .object({
    id: uuid,
    title: z.string(),
    body: z.string(),
    version,
    conversation_id: uuid.nullable(),
    updated_at: timestamp,
    author_name: z.string(),
  })
  .passthrough();
const automation = z
  .object({
    id: uuid,
    name: z.string(),
    owner_id: uuid,
    conversation_id: uuid,
    revision: version,
    version,
    status: z.enum(['active', 'paused', 'archived']),
    next_at: timestamp.nullable(),
    transfer_to: uuid.nullable(),
    created_at: timestamp,
  })
  .passthrough();
const run = z
  .object({
    id: uuid,
    prompt: z.string(),
    status: z.string(),
    error_code: z.string().nullable(),
    conversation_id: uuid,
    agent_name: z.string(),
    channel_name: z.string().nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .passthrough();
const rows = (item: z.ZodType) =>
  z
    .object({
      items: z.array(item),
      next_after: z.string().nullable().optional(),
      next_cursor: z.string().nullable().optional(),
    })
    .passthrough();
export const publicResponses = {
  listTasks: rows(task),
  getTask: z.object({ task, can_manage: z.boolean(), parent: task.nullable() }).passthrough(),
  createTask: identifier,
  updateTask: z.object({ task, replayed: z.boolean() }).passthrough(),
  transitionTask: mutation,
  commentOnTask: identifier,
  messageHistory: z
    .object({
      items: z.array(message),
      older: z.number().int().nullable(),
      newer: z.number().int().nullable(),
    })
    .passthrough(),
  sendMessage: identifier,
  editMessage: mutation,
  deleteMessage: mutation,
  getKnowledgePage: knowledge,
  createKnowledgePage: identifier,
  editKnowledgePage: z
    .object({ page: knowledge, applied_version: version, replayed: z.boolean() })
    .passthrough(),
  projectReport: z
    .object({
      project: z.object({ id: uuid, name: z.string() }).passthrough(),
      states: z.array(
        z
          .object({ state: z.string(), count: z.number().int(), estimate: z.number() })
          .passthrough(),
      ),
      assignees: z.array(
        z
          .object({
            name: z.string(),
            count: z.number().int(),
            overdue: z.number().int(),
            estimate: z.number(),
          })
          .passthrough(),
      ),
      velocity: z.array(z.object({ week: z.string(), completed: z.number().int() }).passthrough()),
      totals: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
  search: rows(
    z
      .object({
        id: uuid,
        title: z.string().nullable(),
        body: z.string(),
        conversation_id: uuid.nullable(),
        thread_id: uuid.nullable(),
        version,
        author_name: z.string(),
        channel_name: z.string().nullable(),
        created_at: timestamp,
      })
      .passthrough(),
  ),
  startRun: identifier,
  getRun: run,
  cancelRun: z.object({ ok: z.boolean() }).passthrough(),
  listAutomations: rows(automation),
  getAutomation: automation.extend({
    definition: automationDefinition,
    updated_at: timestamp,
    upcoming: z.array(timestamp),
    report: z
      .object({
        occurrences: z.number().int(),
        failures: z.number().int(),
        suppressed: z.number().int(),
        spent_or_reserved_micros: z.string(),
      })
      .passthrough(),
  }),
  createAutomation: identifier,
  reviseAutomation: z.object({ version, revision: version }).passthrough(),
  controlAutomation: z.object({ version }).passthrough(),
  events: z
    .object({
      events: z.array(
        z
          .object({
            id: z.string(),
            event_type: z.string(),
            resource_id: uuid,
            conversation_id: uuid.nullable(),
          })
          .passthrough(),
      ),
      cursor: z.string(),
      hasMore: z.boolean(),
    })
    .passthrough(),
} satisfies Record<string, z.ZodType>;
