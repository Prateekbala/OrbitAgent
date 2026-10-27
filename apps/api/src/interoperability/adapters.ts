import { z } from 'zod';
import { migrationRecord, type MigrationRecord } from '@ao/contracts/interoperability';
const text = z.string().max(12000);
const sourceId = z.string().min(1).max(200);
const slackMessage = z.object({
  ts: z.string().regex(/^\d{1,12}\.\d{1,6}$/),
  user: sourceId.optional(),
  bot_id: sourceId.optional(),
  username: z.string().max(160).optional(),
  text: text.default(''),
  thread_ts: sourceId.optional(),
  subtype: z.string().max(100).optional(),
  edited: z.object({ ts: sourceId }).optional(),
  reactions: z
    .array(
      z.object({
        name: sourceId,
        count: z.number().int().nonnegative(),
        users: z.array(sourceId).max(1000).default([]),
      }),
    )
    .max(100)
    .default([]),
  files: z
    .array(
      z.object({
        id: sourceId,
        name: z.string().max(255).default('File'),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(10)
    .default([]),
  blocks: z.unknown().optional(),
});
const teamsMessage = z.object({
  id: sourceId,
  replyToId: sourceId.nullable().optional(),
  createdDateTime: z.iso.datetime({ offset: true }),
  lastModifiedDateTime: z.iso.datetime({ offset: true }),
  deletedDateTime: z.string().nullable().optional(),
  from: z
    .object({
      user: z
        .object({ id: sourceId, displayName: z.string().max(160) })
        .nullable()
        .optional(),
    })
    .nullable(),
  body: z.object({ contentType: z.enum(['text', 'html']), content: text }),
  reactions: z
    .array(
      z.object({ reactionType: sourceId, user: z.object({ user: z.object({ id: sourceId }) }) }),
    )
    .max(100)
    .default([]),
  attachments: z
    .array(z.object({ id: sourceId, name: z.string().max(255).nullable().optional() }))
    .max(10)
    .default([]),
});
const discordMessage = z.object({
  id: sourceId,
  author: z.object({ id: sourceId, username: z.string().max(160) }),
  content: text,
  timestamp: z.iso.datetime({ offset: true }),
  edited_timestamp: z.iso.datetime({ offset: true }).nullable().optional(),
  message_reference: z.object({ message_id: sourceId.optional() }).optional(),
  type: z.number().int().default(0),
  reactions: z
    .array(
      z.object({
        emoji: z.object({ id: sourceId.nullable().optional(), name: sourceId.nullable() }),
        count: z.number().int().nonnegative(),
      }),
    )
    .max(100)
    .default([]),
  attachments: z
    .array(
      z.object({
        id: sourceId,
        filename: z.string().max(255),
        size: z.number().int().nonnegative(),
      }),
    )
    .max(10)
    .default([]),
});
export function normalizePage(
  provider: 'slack' | 'teams' | 'discord',
  channelId: string,
  raw: unknown,
): MigrationRecord[] {
  if (provider === 'slack')
    return z
      .array(slackMessage)
      .max(100)
      .parse(raw)
      .map((m) =>
        migrationRecord.parse({
          id: m.ts,
          channelId,
          authorId: m.user ?? m.bot_id ?? 'unknown',
          authorName: m.username ?? m.user ?? m.bot_id ?? 'Unknown Slack author',
          timestamp: new Date(Number(m.ts) * 1000).toISOString(),
          revision: m.edited?.ts ?? m.ts,
          body: m.text || (m.files.length ? '[File]' : '[Unsupported Slack message]'),
          threadId: m.thread_ts !== m.ts ? m.thread_ts : undefined,
          reactions: m.reactions.map((r) => ({
            emoji: ':' + r.name + ':',
            count: r.count,
            authorIds: r.users,
          })),
          files: m.files.map((f) => ({ sourceId: f.id, name: f.name, size: f.size })),
          unsupported: [
            ...(m.subtype && !['bot_message', 'file_share', 'thread_broadcast'].includes(m.subtype)
              ? ['Slack subtype: ' + m.subtype]
              : []),
            ...(m.blocks ? ['Slack blocks retained as text fallback'] : []),
          ],
        }),
      );
  if (provider === 'teams')
    return z
      .array(teamsMessage)
      .max(100)
      .parse(raw)
      .map((m) =>
        migrationRecord.parse({
          id: m.id,
          channelId,
          authorId: m.from?.user?.id ?? 'unknown',
          authorName: m.from?.user?.displayName ?? 'Unknown Teams author',
          timestamp: m.createdDateTime,
          revision: m.lastModifiedDateTime,
          deleted: !!m.deletedDateTime,
          threadId: m.replyToId ?? undefined,
          body:
            m.body.contentType === 'html'
              ? m.body.content
                  .replace(/<br\s*\/?\s*>/gi, '\n')
                  .replace(/<[^>]*>/g, '')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&amp;/g, '&') || '[Unsupported Teams content]'
              : m.body.content || '[Empty Teams message]',
          reactions: m.reactions.map((r) => ({
            emoji: r.reactionType,
            count: 1,
            authorIds: [r.user.user.id],
          })),
          files: m.attachments.map((a) => ({ sourceId: a.id, name: a.name ?? 'Attachment' })),
          unsupported:
            m.body.contentType === 'html'
              ? [
                  'Teams HTML converted to inert text; cards and hosted content require file mapping',
                ]
              : [],
        }),
      );
  return z
    .array(discordMessage)
    .max(100)
    .parse(raw)
    .map((m) =>
      migrationRecord.parse({
        id: m.id,
        channelId,
        authorId: m.author.id,
        authorName: m.author.username,
        timestamp: m.timestamp,
        revision: m.edited_timestamp ?? m.timestamp,
        body: m.content || (m.attachments.length ? '[File]' : '[Content unavailable]'),
        threadId: undefined,
        reactions: m.reactions.map((r) => ({
          emoji: r.emoji.id ? ':' + (r.emoji.name ?? 'custom') + ':' : (r.emoji.name ?? 'unknown'),
          count: r.count,
          authorIds: [],
        })),
        files: m.attachments.map((f) => ({ sourceId: f.id, name: f.filename, size: f.size })),
        unsupported: [
          ...(m.message_reference?.message_id
            ? ['Discord reply reference: ' + m.message_reference.message_id + ' (not a thread)']
            : []),
          ...(m.type !== 0 ? ['Discord message type: ' + m.type] : []),
          ...(!m.content && !m.attachments.length
            ? ['Discord content unavailable; check MESSAGE_CONTENT authorization']
            : []),
        ],
      }),
    );
}
