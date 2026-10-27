import { z } from 'zod';
const id = z.uuid().transform((v) => v.toLowerCase());
export const messageFormat = z.enum(['plain', 'markdown']);
export const mentionTokenPattern = /\[([^\]\r\n]{1,100})\]\(mention:([0-9a-f-]{36})\)/gi;
export function structuredMentionIds(body: string) {
  return [...new Set([...body.matchAll(mentionTokenPattern)].map((m) => id.parse(m[2])))].sort();
}
export function mentionToken(member: { id: string; name: string }) {
  return `[@${member.name.replace(/[\[\]\\\r\n]/g, '')}](mention:${member.id})`;
}
export const messageContent = z
  .object({
    body: z.string().trim().max(12000),
    format: messageFormat.default('plain'),
    attachmentIds: z.array(id).max(10).default([]),
    mentionIds: z.array(id).max(50).default([]),
    threadId: id.optional(),
  })
  .strict();
export const draftInput = messageContent.extend({ version: z.number().int().nonnegative() });
export const scheduleInput = messageContent.extend({
  expectedAuthorId: id.optional(),
  expectedMembershipVersion: z.number().int().positive().optional(),
  expectedAccessInterval: id.nullable().optional(),
  clientId: id,
  sendAt: z.iso.datetime({ offset: true }),
});
export const scheduleUpdate = z
  .object({
    version: z.number().int().positive(),
    sendAt: z.iso.datetime({ offset: true }).optional(),
    cancel: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.cancel) !== Boolean(v.sendAt), 'Choose cancellation or a new time.');
export const personalListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(40),
  after: z.string().max(2000).optional(),
});
export interface CursorPage<T> {
  items: T[];
  next: string | null;
}
export const sidebarInput = z
  .object({
    version: z.number().int().nonnegative(),
    sections: z
      .array(
        z
          .object({
            id,
            name: z.string().trim().min(1).max(40),
            conversationIds: z.array(id).max(1000),
          })
          .strict(),
      )
      .max(30),
    hiddenIds: z.array(id).max(1000),
  })
  .strict()
  .refine((v) => {
    const ids = v.sections.flatMap((s) => s.conversationIds);
    return (
      new Set(ids).size === ids.length &&
      new Set(v.sections.map((s) => s.id)).size === v.sections.length &&
      new Set(v.hiddenIds).size === v.hiddenIds.length
    );
  }, 'Choose each section and conversation once.');
export type SidebarPreferences = z.infer<typeof sidebarInput>;
export interface MessageDraft extends z.infer<typeof messageContent> {
  conversation_id: string;
  thread_id: string | null;
  version: number;
  updated_at: string;
}
export interface ScheduledMessage {
  id: string;
  conversation_id: string;
  thread_id: string | null;
  body: string;
  format: 'plain' | 'markdown';
  send_at: string;
  status: 'scheduled' | 'sent' | 'cancelled' | 'blocked';
  error_code: string | null;
  version: number;
  message_id: string | null;
  created_at: string;
}
export interface PersonalMessage {
  id: string;
  message_id: string;
  conversation_id: string;
  thread_id: string | null;
  body: string;
  format: 'plain' | 'markdown';
  author_name: string;
  created_at: string;
}
export const channelManagement = z
  .object({
    version: z.number().int().positive(),
    name: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    description: z.string().trim().max(300).optional(),
    archived: z.boolean().optional(),
    historyPolicy: z.enum(['retained', 'join_time']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, 'Choose a change.');
export const historyProposalInput = z
  .object({ membershipId: id, version: z.number().int().positive() })
  .strict();
export interface HistoryProposal {
  id: string;
  target_id: string;
  target_name: string;
  requested_by: string;
  base_version: number;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  expires_at: string;
  approved: number;
  required: number;
  my_decision: 'approve' | 'reject' | null;
}
