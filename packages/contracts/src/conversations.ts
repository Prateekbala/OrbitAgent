import { z } from 'zod';
const memberId = z.uuid().transform((value) => value.toLowerCase());
export const directInput = z.object({ membershipId: memberId }).strict();
export const groupInput = z
  .object({
    historyPolicy: z.enum(['retained', 'join_time']).default('join_time'),
    title: z.string().trim().min(1).max(100),
    membershipIds: z
      .array(memberId)
      .min(1)
      .max(49)
      .refine((v) => new Set(v).size === v.length, 'Choose each member once.'),
  })
  .strict();
export const groupUpdate = z
  .object({
    version: z.number().int().positive(),
    historyPolicy: z.enum(['retained', 'join_time']).optional(),
    title: z.string().trim().min(1).max(100).optional(),
    member: z
      .object({
        membershipId: memberId,
        action: z.enum(['add', 'remove', 'promote', 'demote']),
        historyAccess: z.enum(['retained', 'join_time']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) => [v.title, v.member, v.historyPolicy].filter(Boolean).length === 1,
    'Choose one change.',
  );
export interface ConversationParticipant {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  role: 'owner' | 'member';
  status: 'active' | 'suspended';
}
export interface ConversationDetails {
  history_policy?: 'retained' | 'join_time';
  archived_at?: string | null;
  id: string;
  kind: 'channel' | 'direct' | 'group';
  title: string | null;
  version: number;
  participants: ConversationParticipant[];
}
