import { z } from 'zod';
const id = z.uuid();
export const messageBody = z.string().trim().min(1).max(12000);
export const messageEdit = z
  .object({
    body: z.string().trim().max(12000),
    version: z.number().int().positive(),
    format: z.enum(['plain', 'markdown']).optional(),
  })
  .strict();
export const messageDelete = messageEdit.pick({ version: true });
export const reactionEmojis = [
  '👍',
  '❤️',
  '🎉',
  '😄',
  '👀',
  '🚀',
  '✅',
  '🙏',
  '🔥',
  '💡',
  '😂',
  '😕',
] as const;
export const messageReaction = z.object({ emoji: z.enum(reactionEmojis) }).strict();
export const conversationRead = z.object({ messageId: id }).strict();
export const eventCursor = z.union([z.literal('0'), z.string().regex(/^v1\.[A-Za-z0-9_-]{48}$/)]);
export const realtimeBatch = z.object({
  events: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        event_type: z.string(),
        resource_id: id,
        conversation_id: id.nullable(),
      }),
    )
    .max(100),
  cursor: eventCursor,
  hasMore: z.boolean(),
});
export type RealtimeBatch = z.infer<typeof realtimeBatch>;
export interface Reaction {
  emoji: (typeof reactionEmojis)[number];
  count: number;
  reacted: boolean;
}
export interface MessageReader {
  membership_id: string;
  name: string;
}
