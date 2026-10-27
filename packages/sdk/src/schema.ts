export interface paths {
  '/tasks': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listTasks'];
    put?: never;
    post: operations['createTask'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/tasks/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getTask'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch: operations['updateTask'];
    trace?: never;
  };
  '/tasks/{id}/transitions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['transitionTask'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/tasks/{id}/comments': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['commentOnTask'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/conversations/{id}/messages': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['messageHistory'];
    put?: never;
    post: operations['sendMessage'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/messages/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations['deleteMessage'];
    options?: never;
    head?: never;
    patch: operations['editMessage'];
    trace?: never;
  };
  '/knowledge/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getKnowledgePage'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch: operations['editKnowledgePage'];
    trace?: never;
  };
  '/knowledge': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['createKnowledgePage'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/projects/{id}/report': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['projectReport'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/search': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['search'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/runs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['startRun'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/runs/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getRun'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/runs/{id}/cancel': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['cancelRun'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/automations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listAutomations'];
    put?: never;
    post: operations['createAutomation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/automations/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getAutomation'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/automations/{id}/revisions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['reviseAutomation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/automations/{id}/control': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['controlAutomation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['events'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    ApiError: {
      error: {
        code: string;
        message: string;
        requestId: string;
      };
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  listTasks: {
    parameters: {
      query?: {
        q?: string;
        projectId?: string;
        milestoneId?: string;
        labelId?: string;
        noProject?: 'true';
        state?:
          | 'proposed'
          | 'queued'
          | 'active'
          | 'blocked'
          | 'awaiting_approval'
          | 'awaiting_review'
          | 'completed'
          | 'failed'
          | 'cancelled';
        assigneeId?: string;
        unassigned?: 'true';
        conversationId?: string;
        workspaceOnly?: 'true';
        parentId?: string;
        roots?: 'true';
        overdue?: 'true';
        asOf?: string;
        dueFrom?: string;
        dueThrough?: string;
        sort?: 'newest' | 'due' | 'priority';
        limit?: number;
        cursor?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            items: ({
              id: string;
              title: string;
              description: string;
              state: string;
              version: number;
              conversation_id: string | null;
              priority: string;
              due_date: string | null;
              assignee_id: string | null;
              created_by: string;
            } & {
              [key: string]: unknown;
            })[];
            next_after?: string | null;
            next_cursor?: string | null;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  createTask: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          title: string;
          description?: string;
          assigneeId?: string;
          priority?: 'low' | 'normal' | 'high';
          conversationId?: string;
          parentId?: string;
          dueDate?: string;
          projectId?: string;
          milestoneId?: string;
          labelIds?: string[];
          clientId?: string;
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getTask: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            task: {
              id: string;
              title: string;
              description: string;
              state: string;
              version: number;
              conversation_id: string | null;
              priority: string;
              due_date: string | null;
              assignee_id: string | null;
              created_by: string;
            } & {
              [key: string]: unknown;
            };
            can_manage: boolean;
            parent:
              | ({
                  id: string;
                  title: string;
                  description: string;
                  state: string;
                  version: number;
                  conversation_id: string | null;
                  priority: string;
                  due_date: string | null;
                  assignee_id: string | null;
                  created_by: string;
                } & {
                  [key: string]: unknown;
                })
              | null;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  updateTask: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          version: number;
          title?: string;
          description?: string;
          assigneeId?: string | null;
          priority?: 'low' | 'normal' | 'high';
          dueDate?: string | null;
          parentId?: string | null;
          projectId?: string | null;
          milestoneId?: string | null;
          labelIds?: string[];
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            task: {
              id: string;
              title: string;
              description: string;
              state: string;
              version: number;
              conversation_id: string | null;
              priority: string;
              due_date: string | null;
              assignee_id: string | null;
              created_by: string;
            } & {
              [key: string]: unknown;
            };
            replayed: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  transitionTask: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          state:
            | 'proposed'
            | 'queued'
            | 'active'
            | 'blocked'
            | 'awaiting_approval'
            | 'awaiting_review'
            | 'completed'
            | 'failed'
            | 'cancelled';
          version: number;
          evidence?: string;
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            ok: boolean;
            version: number;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            ok: boolean;
            version: number;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  commentOnTask: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          body: string;
          clientId: string;
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  messageHistory: {
    parameters: {
      query?: {
        threadId?: string;
        before?: number;
        after?: number;
        around?: string;
        limit?: number;
      };
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            items: ({
              id: string;
              body: string;
              author_id: string;
              author_name: string;
              sequence: number;
              version: number;
              conversation_id?: string;
              thread_id: string | null;
              created_at: string;
              deleted_at: string | null;
              reactions: {
                [key: string]: unknown;
              }[];
              attachments: {
                [key: string]: unknown;
              }[];
            } & {
              [key: string]: unknown;
            })[];
            older: number | null;
            newer: number | null;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  sendMessage: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          format?: 'plain' | 'markdown';
          expectedAuthorId?: string;
          expectedMembershipVersion?: number;
          expectedAccessInterval?: string | null;
          body?: string;
          clientId: string;
          threadId?: string;
          mentionIds?: string[];
          attachmentIds?: string[];
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  deleteMessage: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          version: number;
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            ok: boolean;
            version: number;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  editMessage: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          body: string;
          version: number;
          format?: 'plain' | 'markdown';
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            ok: boolean;
            version: number;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getKnowledgePage: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            title: string;
            body: string;
            version: number;
            conversation_id: string | null;
            updated_at: string;
            author_name: string;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  editKnowledgePage: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          version: number;
          title: string;
          body: string;
          summary?: string;
          clientId: string;
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            page: {
              id: string;
              title: string;
              body: string;
              version: number;
              conversation_id: string | null;
              updated_at: string;
              author_name: string;
            } & {
              [key: string]: unknown;
            };
            applied_version: number;
            replayed: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  createKnowledgePage: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          kind?:
            | 'page'
            | 'dictionary'
            | 'decision'
            | 'procedure'
            | 'project_context'
            | 'summary'
            | 'journal';
          title: string;
          body: string;
          conversationId?: string;
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  projectReport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            project: {
              id: string;
              name: string;
            } & {
              [key: string]: unknown;
            };
            states: ({
              state: string;
              count: number;
              estimate: number;
            } & {
              [key: string]: unknown;
            })[];
            assignees: ({
              name: string;
              count: number;
              overdue: number;
              estimate: number;
            } & {
              [key: string]: unknown;
            })[];
            velocity: ({
              week: string;
              completed: number;
            } & {
              [key: string]: unknown;
            })[];
            totals: {
              [key: string]: unknown;
            };
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  search: {
    parameters: {
      query?: {
        q?: string;
        scope?: 'messages' | 'knowledge';
        conversationId?: string;
        authorId?: string;
        from?: string;
        to?: string;
        attachments?: 'true';
        threads?: 'replies' | 'main';
        sort?: 'relevance' | 'newest' | 'oldest';
        limit?: number;
        cursor?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            items: ({
              id: string;
              title: string | null;
              body: string;
              conversation_id: string | null;
              thread_id: string | null;
              version: number;
              author_name: string;
              channel_name: string | null;
              created_at: string;
            } & {
              [key: string]: unknown;
            })[];
            next_after?: string | null;
            next_cursor?: string | null;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  startRun: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          agentId: string;
          conversationId: string;
          prompt: string;
          requestKey: string;
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            prompt: string;
            status: string;
            error_code: string | null;
            conversation_id: string;
            agent_name: string;
            channel_name: string | null;
            created_at: string;
            updated_at: string;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  cancelRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, never>;
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            ok: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            ok: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  listAutomations: {
    parameters: {
      query?: {
        after?: string;
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            items: ({
              id: string;
              name: string;
              owner_id: string;
              conversation_id: string;
              revision: number;
              version: number;
              status: 'active' | 'paused' | 'archived';
              next_at: string | null;
              transfer_to: string | null;
              created_at: string;
            } & {
              [key: string]: unknown;
            })[];
            next_after?: string | null;
            next_cursor?: string | null;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  createAutomation: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          clientId: string;
          name: string;
          definition: {
            conversationId: string;
            trigger:
              | {
                  kind: 'schedule';
                  cron: string;
                  timezone: string;
                  dst?: 'skip_gap' | 'shift_gap';
                  missed?: 'skip' | 'coalesce' | 'catch_up';
                  catchUpLimit?: number;
                  graceSeconds?: number;
                }
              | {
                  kind: 'event';
                  events: (
                    | 'message.created'
                    | 'message.updated'
                    | 'task.created'
                    | 'task.updated'
                    | 'task.transitioned'
                    | 'task.comment_created'
                    | 'knowledge.created'
                    | 'knowledge.updated'
                    | 'connection.resource_imported'
                  )[];
                  ignoreOwner?: boolean;
                };
            action:
              | {
                  kind: 'agent';
                  agentId: string;
                  agentRevision: number;
                  prompt: string;
                }
              | {
                  kind: 'workflow';
                  templateId: string;
                  revision: number;
                  sourceTaskId?: string;
                  projectId?: string;
                };
            overlap?: 'skip' | 'queue';
            concurrency?: number;
            maxDailySpendMicros?: number;
            maxRunsPerDay?: number;
            timeoutMinutes?: number;
            escalationMemberId?: string;
            participation?: {
              enabled?: boolean;
              onlyMeaningfulChanges?: boolean;
              cooldownMinutes?: number;
              maxPublicationsPerDay?: number;
              quietHours?: {
                timezone: string;
                startHour: number;
                endHour: number;
              };
            };
          };
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            replayed?: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getAutomation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            id: string;
            name: string;
            owner_id: string;
            conversation_id: string;
            revision: number;
            version: number;
            status: 'active' | 'paused' | 'archived';
            next_at: string | null;
            transfer_to: string | null;
            created_at: string;
            definition: {
              conversationId: string;
              trigger:
                | {
                    kind: 'schedule';
                    cron: string;
                    timezone: string;
                    dst: 'skip_gap' | 'shift_gap';
                    missed: 'skip' | 'coalesce' | 'catch_up';
                    catchUpLimit: number;
                    graceSeconds: number;
                  }
                | {
                    kind: 'event';
                    events: (
                      | 'message.created'
                      | 'message.updated'
                      | 'task.created'
                      | 'task.updated'
                      | 'task.transitioned'
                      | 'task.comment_created'
                      | 'knowledge.created'
                      | 'knowledge.updated'
                      | 'connection.resource_imported'
                    )[];
                    ignoreOwner: boolean;
                  };
              action:
                | {
                    kind: 'agent';
                    agentId: string;
                    agentRevision: number;
                    prompt: string;
                  }
                | {
                    kind: 'workflow';
                    templateId: string;
                    revision: number;
                    sourceTaskId?: string;
                    projectId?: string;
                  };
              overlap: 'skip' | 'queue';
              concurrency: number;
              maxDailySpendMicros: number;
              maxRunsPerDay: number;
              timeoutMinutes: number;
              escalationMemberId?: string;
              participation: {
                enabled: boolean;
                onlyMeaningfulChanges: boolean;
                cooldownMinutes: number;
                maxPublicationsPerDay: number;
                quietHours?: {
                  timezone: string;
                  startHour: number;
                  endHour: number;
                };
              };
            };
            updated_at: string;
            upcoming: string[];
            report: {
              occurrences: number;
              failures: number;
              suppressed: number;
              spent_or_reserved_micros: string;
            } & {
              [key: string]: unknown;
            };
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  reviseAutomation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          definition: {
            conversationId: string;
            trigger:
              | {
                  kind: 'schedule';
                  cron: string;
                  timezone: string;
                  dst?: 'skip_gap' | 'shift_gap';
                  missed?: 'skip' | 'coalesce' | 'catch_up';
                  catchUpLimit?: number;
                  graceSeconds?: number;
                }
              | {
                  kind: 'event';
                  events: (
                    | 'message.created'
                    | 'message.updated'
                    | 'task.created'
                    | 'task.updated'
                    | 'task.transitioned'
                    | 'task.comment_created'
                    | 'knowledge.created'
                    | 'knowledge.updated'
                    | 'connection.resource_imported'
                  )[];
                  ignoreOwner?: boolean;
                };
            action:
              | {
                  kind: 'agent';
                  agentId: string;
                  agentRevision: number;
                  prompt: string;
                }
              | {
                  kind: 'workflow';
                  templateId: string;
                  revision: number;
                  sourceTaskId?: string;
                  projectId?: string;
                };
            overlap?: 'skip' | 'queue';
            concurrency?: number;
            maxDailySpendMicros?: number;
            maxRunsPerDay?: number;
            timeoutMinutes?: number;
            escalationMemberId?: string;
            participation?: {
              enabled?: boolean;
              onlyMeaningfulChanges?: boolean;
              cooldownMinutes?: number;
              maxPublicationsPerDay?: number;
              quietHours?: {
                timezone: string;
                startHour: number;
                endHour: number;
              };
            };
          };
          version: number;
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            version: number;
            revision: number;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            version: number;
            revision: number;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  controlAutomation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          version: number;
          action: 'pause' | 'resume' | 'archive';
        };
      };
    };
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            version: number;
          } & {
            [key: string]: unknown;
          };
        };
      };
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            version: number;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  events: {
    parameters: {
      query?: {
        after?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            events: ({
              id: string;
              event_type: string;
              resource_id: string;
              conversation_id: string | null;
            } & {
              [key: string]: unknown;
            })[];
            cursor: string;
            hasMore: boolean;
          } & {
            [key: string]: unknown;
          };
        };
      };
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
}
