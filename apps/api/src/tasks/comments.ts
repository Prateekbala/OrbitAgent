import { randomUUID } from 'node:crypto';
import type { Database } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { recordChange } from '../lib/events.js';
import { getTask } from './queries.js';
import { taskActor } from './service.js';
export class TaskCommentService {
  constructor(private readonly db: Database) {}
  async create(p: Identity, taskId: string, input: { body: string; clientId: string }) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p, false);
      const task = await getTask(tx, p, taskId, true),
        hash = digest(input.body);
      const [previous] = await tx.query(
        'SELECT id,creation_body_hash FROM task_comments WHERE workspace_id=$1 AND task_id=$2 AND author_id=$3 AND client_id=$4',
        [p.workspaceId, taskId, p.membershipId, input.clientId],
      );
      if (previous) {
        if (previous.creation_body_hash !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This comment identifier was already used for different text.',
          );
        return { id: previous.id, replayed: true };
      }
      const [counter] = await tx.query(
        'UPDATE tasks SET next_comment_sequence=next_comment_sequence+1 WHERE workspace_id=$1 AND id=$2 RETURNING next_comment_sequence',
        [p.workspaceId, taskId],
      );
      const id = randomUUID();
      await tx.query(
        'INSERT INTO task_comments(id,workspace_id,task_id,author_id,body,client_id,creation_body_hash,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          p.workspaceId,
          taskId,
          p.membershipId,
          input.body,
          input.clientId,
          hash,
          counter!.next_comment_sequence,
        ],
      );
      await recordChange(tx, p, 'task.comment_created', id, task.conversation_id);
      return { id, replayed: false };
    });
  }
  async change(p: Identity, taskId: string, id: string, version: number, body: string | null) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p, false);
      const task = await getTask(tx, p, taskId, true);
      const [comment] = await tx.query(
        'SELECT author_id,version,body,deleted_at FROM task_comments WHERE workspace_id=$1 AND task_id=$2 AND id=$3 FOR UPDATE',
        [p.workspaceId, taskId, id],
      );
      if (!comment) throw notFound();
      if (
        comment.author_id !== p.membershipId &&
        !(body === null && p.kind === 'human' && ['owner', 'admin'].includes(p.role))
      )
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the author can edit a comment. Authors and human administrators can delete it.',
        );
      if (comment.deleted_at) {
        if (body === null) return { ok: true, version: comment.version };
        throw new AppError(410, 'COMMENT_DELETED', 'This comment was deleted.');
      }
      if (comment.version !== version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'This comment changed. Review its latest version first.',
        );
      if (body === comment.body) return { ok: true, version };
      await tx.query(
        `UPDATE task_comments SET body=$4,version=version+1,edited_at=CASE WHEN $5 THEN edited_at ELSE clock_timestamp() END,deleted_at=CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,deleted_by=CASE WHEN $5 THEN $6::uuid ELSE NULL END WHERE workspace_id=$1 AND task_id=$2 AND id=$3`,
        [p.workspaceId, taskId, id, body ?? '', body === null, p.membershipId],
      );
      await recordChange(
        tx,
        p,
        body === null ? 'task.comment_deleted' : 'task.comment_edited',
        id,
        task.conversation_id,
      );
      return { ok: true, version: version + 1 };
    });
  }
}
