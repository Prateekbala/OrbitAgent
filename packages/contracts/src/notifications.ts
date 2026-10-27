import { z } from 'zod';
const id = z.uuid().transform((value) => value.toLowerCase());
export const notificationKinds = [
  'message',
  'mention',
  'reply',
  'reaction',
  'task_assigned',
  'task_comment',
  'task_reminder',
  'task_activity',
  'workflow_attention',
  'agent_attention',
  'automation_attention',
  'approval_request',
  'group_added',
] as const;
export const notificationPreferences = z
  .object({
    enabled: z.boolean(),
    mentions: z.boolean(),
    replies: z.boolean(),
    direct_messages: z.boolean(),
    group_messages: z.boolean(),
    reactions: z.boolean(),
    tasks: z.boolean(),
    approvals: z.boolean(),
  })
  .strict();
export const defaultNotificationPreferences: NotificationPreferences = {
  enabled: true,
  mentions: true,
  replies: true,
  direct_messages: true,
  group_messages: true,
  reactions: true,
  tasks: true,
  approvals: true,
};
export type NotificationPreferences = z.infer<typeof notificationPreferences>;
export const notificationPreferenceUpdate = notificationPreferences
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Choose a preference.');
export const conversationNotificationPreference = z
  .object({ mode: z.enum(['default', 'all', 'mentions', 'muted']) })
  .strict();
export const notificationRead = z.object({ read: z.boolean() }).strict();
export const notificationReadAll = z.object({ throughId: id }).strict();
export const notificationQuery = z
  .object({
    before: id.optional(),
    unread: z.enum(['true', 'false']).default('false'),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict();
export interface InboxNotification {
  id: string;
  kind: (typeof notificationKinds)[number];
  actor_name: string;
  conversation_id: string | null;
  conversation_name: string | null;
  resource_id: string;
  task_id?: string | null;
  automation_id?: string | null;
  workflow_run_id?: string | null;
  agent_run_id?: string | null;
  message_id: string | null;
  thread_id: string | null;
  excerpt: string | null;
  read_at: string | null;
  created_at: string;
}
export interface NotificationPage {
  items: InboxNotification[];
  unread_count: number;
  next_cursor: string | null;
}

export function containsMention(body: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s(])@${escaped}(?=$|[\\s.,!?;:)]|\\n)`, 'iu').test(body);
}
