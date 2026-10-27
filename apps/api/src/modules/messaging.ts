import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import {
  id,
  messageEdit,
  messageDelete,
  messageReaction,
  conversationRead,
  historyQuery,
} from '@ao/contracts';
import { authenticate } from './auth.js';
import { AppError, notFound } from '../lib/errors.js';
import { requireConversation } from '../lib/policy.js';
import { listMessages, MessageService } from '../messaging/service.js';
export function messagingRoutes(app: FastifyInstance, db: Database) {
  const service = new MessageService(db);
  app.get('/v1/conversations/:id/messages/history', async (req) => {
    const p = await authenticate(db, req),
      channel = id.parse((req.params as { id: string }).id),
      q = historyQuery.parse(req.query);
    return db.transaction(async (tx) => {
      await requireConversation(tx, p, channel, true);
      if (q.threadId) {
        const [root] = await tx.query(
          'SELECT id FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND thread_id IS NULL',
          [p.workspaceId, channel, q.threadId],
        );
        if (!root) throw notFound();
      }
      const items = (
        await listMessages(tx, p, channel, q.threadId ?? null, q.before ?? null, q.around ?? null, {
          limit: q.limit,
          ...(q.after ? { after: q.after } : {}),
        })
      ).reverse();
      const low = items.at(0)?.sequence,
        high = items.at(-1)?.sequence;
      const [more] = await tx.query(
        `SELECT EXISTS(SELECT 1 FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND thread_id IS NOT DISTINCT FROM $3::uuid AND sequence<$4) older,
        EXISTS(SELECT 1 FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND thread_id IS NOT DISTINCT FROM $3::uuid AND sequence>$5) newer`,
        [p.workspaceId, channel, q.threadId ?? null, low ?? 0, high ?? 2147483647],
      );
      return { items, older: more?.older ? low : null, newer: more?.newer ? high : null };
    });
  });
  app.get('/v1/messages/:id/context', async (req) => {
    const p = await authenticate(db, req),
      message = id.parse((req.params as { id: string }).id);
    const [row] = await db.query(
      'SELECT id,conversation_id,thread_id,deleted_at FROM messages WHERE workspace_id=$1 AND id=$2',
      [p.workspaceId, message],
    );
    if (!row) throw notFound();
    await requireConversation(db, p, String(row.conversation_id));
    if (row.deleted_at) throw new AppError(410, 'MESSAGE_DELETED', 'This message was deleted.');
    const roots = row.thread_id
      ? await listMessages(db, p, String(row.conversation_id), null, null, String(row.thread_id))
      : [];
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      thread_id: row.thread_id,
      root: row.thread_id ? (roots.find((root) => root.id === row.thread_id) ?? null) : null,
    };
  });
  app.patch('/v1/messages/:id', async (req) =>
    service.edit(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      messageEdit.parse(req.body),
    ),
  );
  app.delete('/v1/messages/:id', async (req) =>
    service.delete(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      messageDelete.parse(req.body).version,
    ),
  );
  for (const method of ['PUT', 'DELETE'] as const)
    app.route({
      method,
      url: '/v1/messages/:id/reactions',
      handler: async (req) =>
        service.react(
          await authenticate(db, req),
          id.parse((req.params as { id: string }).id),
          messageReaction.parse(req.body).emoji,
          method === 'DELETE',
        ),
    });
  app.put('/v1/conversations/:id/read', async (req) =>
    service.read(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      conversationRead.parse(req.body).messageId,
    ),
  );
}
