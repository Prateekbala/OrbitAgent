import { publicResponses } from './responses.js';
import { z } from 'zod';
import {
  messageInput,
  messageEdit,
  messageDelete,
  taskInput,
  taskUpdate,
  taskTransition,
  taskCommentInput,
  taskListQuery,
  historyQuery,
  runInput,
  advancedSearchQuery,
  knowledgeEdit,
  pageInput,
} from '@ao/contracts';
import { automationCreate, automationRevision, automationControl } from '@ao/contracts/automations';
import type { PublicScope } from '@ao/contracts/developer';
const none = z.object({}).strict();
export interface PublicOperation {
  id: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  internal: string;
  scope: PublicScope;
  summary: string;
  query: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
}
const op = (v: Omit<PublicOperation, 'query'> & { query?: z.ZodType }): PublicOperation => ({
  query: none,
  ...v,
});
export const publicOperations: PublicOperation[] = [
  op({
    id: 'listTasks',
    method: 'GET',
    path: '/tasks',
    internal: '/v1/tasks/list',
    scope: 'tasks.read',
    summary: 'List visible tasks with cursor pagination and filters',
    query: taskListQuery,
    response: publicResponses.listTasks,
  }),
  op({
    id: 'getTask',
    method: 'GET',
    path: '/tasks/{id}',
    internal: '/v1/tasks/:id',
    scope: 'tasks.read',
    summary: 'Read a task and current management capability',
    response: publicResponses.getTask,
  }),
  op({
    id: 'createTask',
    method: 'POST',
    path: '/tasks',
    internal: '/v1/tasks',
    scope: 'tasks.write',
    summary: 'Create a task using clientId for idempotency',
    body: taskInput,
    response: publicResponses.createTask,
  }),
  op({
    id: 'updateTask',
    method: 'PATCH',
    path: '/tasks/{id}',
    internal: '/v1/tasks/:id',
    scope: 'tasks.write',
    summary: 'Update a task with optimistic version checking',
    body: taskUpdate,
    response: publicResponses.updateTask,
  }),
  op({
    id: 'transitionTask',
    method: 'POST',
    path: '/tasks/{id}/transitions',
    internal: '/v1/tasks/:id/transitions',
    scope: 'tasks.write',
    summary: 'Transition a task with evidence and dependency checks',
    body: taskTransition,
    response: publicResponses.transitionTask,
  }),
  op({
    id: 'commentOnTask',
    method: 'POST',
    path: '/tasks/{id}/comments',
    internal: '/v1/tasks/:id/comments',
    scope: 'tasks.write',
    summary: 'Add an idempotent task comment',
    body: taskCommentInput,
    response: publicResponses.commentOnTask,
  }),
  op({
    id: 'messageHistory',
    method: 'GET',
    path: '/conversations/{id}/messages',
    internal: '/v1/conversations/:id/messages/history',
    scope: 'messages.read',
    summary: 'Read accessible message history with pagination',
    query: historyQuery,
    response: publicResponses.messageHistory,
  }),
  op({
    id: 'sendMessage',
    method: 'POST',
    path: '/conversations/{id}/messages',
    internal: '/v1/conversations/:id/messages',
    scope: 'messages.write',
    summary: 'Send a message using clientId for idempotency',
    body: messageInput,
    response: publicResponses.sendMessage,
  }),
  op({
    id: 'editMessage',
    method: 'PATCH',
    path: '/messages/{id}',
    internal: '/v1/messages/:id',
    scope: 'messages.write',
    summary: 'Edit an authored message with version checking',
    body: messageEdit,
    response: publicResponses.editMessage,
  }),
  op({
    id: 'deleteMessage',
    method: 'DELETE',
    path: '/messages/{id}',
    internal: '/v1/messages/:id',
    scope: 'messages.write',
    summary: 'Delete an authored message with version checking',
    body: messageDelete,
    response: publicResponses.deleteMessage,
  }),
  op({
    id: 'getKnowledgePage',
    method: 'GET',
    path: '/knowledge/{id}',
    internal: '/v1/knowledge/:id',
    scope: 'knowledge.read',
    summary: 'Read a currently accessible knowledge page',
    response: publicResponses.getKnowledgePage,
  }),
  op({
    id: 'createKnowledgePage',
    method: 'POST',
    path: '/knowledge',
    internal: '/v1/knowledge',
    scope: 'knowledge.write',
    summary: 'Create a knowledge page in a granted audience',
    body: pageInput,
    response: publicResponses.createKnowledgePage,
  }),
  op({
    id: 'editKnowledgePage',
    method: 'PATCH',
    path: '/knowledge/{id}',
    internal: '/v1/knowledge/:id',
    scope: 'knowledge.write',
    summary: 'Create a versioned knowledge edit',
    body: knowledgeEdit,
    response: publicResponses.editKnowledgePage,
  }),
  op({
    id: 'projectReport',
    method: 'GET',
    path: '/projects/{id}/report',
    internal: '/v1/projects/:id/report',
    scope: 'projects.read',
    summary: 'Read a project report',
    response: publicResponses.projectReport,
  }),
  op({
    id: 'search',
    method: 'GET',
    path: '/search',
    internal: '/v1/search/advanced',
    scope: 'search.read',
    summary: 'Search content under current access controls',
    query: advancedSearchQuery,
    response: publicResponses.search,
  }),
  op({
    id: 'startRun',
    method: 'POST',
    path: '/runs',
    internal: '/v1/runs',
    scope: 'execution.manage',
    summary: 'Queue a budgeted hosted agent run; proposals require normal approval',
    body: runInput,
    response: publicResponses.startRun,
  }),
  op({
    id: 'getRun',
    method: 'GET',
    path: '/runs/{id}',
    internal: '/v1/runs/:id',
    scope: 'execution.read',
    summary: 'Read run status',
    response: publicResponses.getRun,
  }),
  op({
    id: 'cancelRun',
    method: 'POST',
    path: '/runs/{id}/cancel',
    internal: '/v1/runs/:id/cancel',
    scope: 'execution.manage',
    summary: 'Cancel a run without claiming provider completion',
    body: none,
    response: publicResponses.cancelRun,
  }),
  op({
    id: 'listAutomations',
    method: 'GET',
    path: '/automations',
    internal: '/v1/automations',
    scope: 'automations.read',
    summary: 'List owned automations',
    query: z
      .object({
        after: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .strict(),
    response: publicResponses.listAutomations,
  }),
  op({
    id: 'getAutomation',
    method: 'GET',
    path: '/automations/{id}',
    internal: '/v1/automations/:id',
    scope: 'automations.read',
    summary: 'Read a definition and upcoming occurrences',
    response: publicResponses.getAutomation,
  }),
  op({
    id: 'createAutomation',
    method: 'POST',
    path: '/automations',
    internal: '/v1/automations',
    scope: 'automations.write',
    summary: 'Create a paused automation for owner review',
    body: automationCreate,
    response: publicResponses.createAutomation,
  }),
  op({
    id: 'reviseAutomation',
    method: 'POST',
    path: '/automations/{id}/revisions',
    internal: '/v1/automations/:id/revisions',
    scope: 'automations.write',
    summary: 'Append a revision and pause for owner review',
    body: automationRevision,
    response: publicResponses.reviseAutomation,
  }),
  op({
    id: 'controlAutomation',
    method: 'POST',
    path: '/automations/{id}/control',
    internal: '/v1/automations/:id/control',
    scope: 'automations.write',
    summary: 'Pause or archive an automation; browser owner consent is required to resume',
    body: automationControl,
    response: publicResponses.controlAutomation,
  }),
  op({
    id: 'events',
    method: 'GET',
    path: '/events',
    internal: '/v1/events',
    scope: 'events.read',
    summary: 'Fetch audience-filtered events using an opaque credential-bound cursor',
    query: z.object({ after: z.string().max(200).default('0') }).strict(),
    response: publicResponses.events,
  }),
];
export function internalOperation(method: string, path: string) {
  return publicOperations.find(
    (o) =>
      o.method === method &&
      (o.internal === path ||
        new RegExp('^' + o.internal.replace(/:[a-zA-Z]+/g, '[0-9a-f-]{36}') + '$').test(path)),
  );
}
export function operationInput(o: PublicOperation) {
  return z
    .object({
      ...(o.path.includes('{id}') ? { id: z.uuid() } : {}),
      query: o.query.optional(),
      ...(o.body ? { body: o.body } : {}),
    })
    .strict();
}
function schema(v: z.ZodType, io: 'input' | 'output' = 'input') {
  return z.toJSONSchema(v, { io, unrepresentable: 'any' });
}
export function openApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const o of publicOperations) {
    const query = schema(o.query) as { properties?: Record<string, unknown>; required?: string[] };
    (paths[o.path] ??= {})[o.method.toLowerCase()] = {
      operationId: o.id,
      summary: o.summary,
      security: [{ bearer: [] }],
      'x-required-scope': o.scope,
      parameters: [
        ...(o.path.includes('{id}')
          ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }]
          : []),
        ...Object.entries(query.properties ?? {}).map(([name, schema]) => ({
          name,
          in: 'query',
          required: query.required?.includes(name) ?? false,
          schema,
        })),
      ],
      ...(o.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schema(o.body) } },
            },
          }
        : {}),
      responses: {
        '200': {
          description: 'Successful response',
          content: { 'application/json': { schema: schema(o.response, 'output') } },
        },
        ...(o.method === 'POST'
          ? {
              '201': {
                description: 'Created',
                content: { 'application/json': { schema: schema(o.response, 'output') } },
              },
            }
          : {}),
        default: {
          description: 'Structured API error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    };
  }
  return {
    openapi: '3.1.1',
    info: {
      title: 'Orbit Public API',
      version: '1.0.0',
      description:
        'Current member authority intersected with explicit credential scopes and audiences. Additive changes are compatible within v1.',
    },
    servers: [{ url: '/public/v1' }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ApiError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                requestId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}
