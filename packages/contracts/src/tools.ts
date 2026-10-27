import { z } from 'zod';

export const toolNames = [
  'create_task',
  'save_knowledge',
  'delegate_agent',
  'read_tasks',
  'read_knowledge',
  'connection_action',
  'execute_code',
  'interactive_form',
] as const;
export const toolEffects = [
  'read',
  'write',
  'publish',
  'deploy',
  'access',
  'payment',
  'destructive',
  'export',
  'execute',
] as const;
export const toolRule = z
  .object({
    approval: z.enum(['admin', 'owner', 'deny']).default('admin'),
    independent: z.boolean().default(false),
    expiresInMinutes: z.number().int().min(1).max(1440).default(1440),
  })
  .strict();
export const toolPolicyInput = z
  .object({
    version: z.number().int().positive(),
    rules: z.record(z.enum(toolEffects), toolRule),
  })
  .strict();
export const connectionInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    endpoint: z.url().max(500),
    secret: z.string().min(16).max(4000),
    operations: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
            effect: z.enum(toolEffects).exclude(['execute']),
            description: z.string().trim().min(5).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()
  .refine(
    (v) => new Set(v.operations.map((o) => o.name)).size === v.operations.length,
    'Operation names must be unique.',
  );
export const connectionGrant = z
  .object({
    memberId: z.uuid(),
    operations: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/))
      .min(1)
      .max(30),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const connectionAction = z
  .object({
    connectionId: z.uuid(),
    operation: z
      .string()
      .max(100)
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/),
    payload: z
      .string()
      .max(16000)
      .refine((v) => {
        try {
          const p: unknown = JSON.parse(v);
          return p !== null && typeof p === 'object' && !Array.isArray(p);
        } catch {
          return false;
        }
      }, 'Use a JSON object.')
      .describe(
        'For native catalog writes, use {resource, patch, expected}; expected must include the reviewed previous value of every patched field. Other adapters use their registered payload contract.',
      ),
  })
  .strict();
export const codeAction = z
  .object({
    language: z.enum(['javascript', 'python', 'shell', 'sqlite']),
    code: z.string().min(1).max(20000),
    timeoutSeconds: z.number().int().min(1).max(30).default(10),
  })
  .strict();
export const formAction = z
  .object({
    title: z.string().trim().min(2).max(100),
    description: z.string().max(2000),
    fields: z
      .string()
      .max(8000)
      .refine((v) => {
        try {
          return formFields.safeParse(JSON.parse(v)).success;
        } catch {
          return false;
        }
      }, 'Use a valid form field array.'),
  })
  .strict();
export const formFields = z
  .array(
    z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        label: z.string().min(1).max(100),
        type: z.enum(['text', 'number', 'boolean']),
        required: z.boolean().default(false),
      })
      .strict(),
  )
  .min(1)
  .max(20)
  .refine((v) => new Set(v.map((f) => f.name)).size === v.length, 'Field names must be unique.');
export type ToolName = (typeof toolNames)[number];
export type ToolEffect = (typeof toolEffects)[number];
export type ToolRule = z.infer<typeof toolRule>;
export interface ToolDefinition {
  name: ToolName;
  version: number;
  effect: ToolEffect;
  permission: import('./identity.js').Permission;
  resource: 'source_conversation' | 'owner_connection' | 'isolated_sandbox';
  deadlineSeconds: number;
  maxResultBytes: number;
  cost: 'local' | 'provider' | 'sandbox';
  redaction: string;
}
