import type { Database } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { taskActor, manageTask } from './service.js';
import { taskAccess, getTask } from './queries.js';
import { recordChange } from '../lib/events.js';
export class TaskAttachmentService {
  constructor(private readonly db: Database) {}
  async list(p: Identity, id: string, input: { after?: string | undefined; limit: number }) {
    await getTask(this.db, p, id);
    const rows = await this.db.query(
      `SELECT f.id,f.name,f.size,f.content_type,(f.preview_key IS NOT NULL) has_preview,a.attached_by,m.name attached_by_name,a.attached_at,a.version FROM task_attachments a JOIN tasks t ON t.workspace_id=a.workspace_id AND t.id=a.task_id JOIN files f ON f.workspace_id=a.workspace_id AND f.id=a.file_id JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.attached_by WHERE ${taskAccess} AND a.task_id=$3 AND a.removed_at IS NULL AND f.status='attached' AND ($4::uuid IS NULL OR a.file_id>$4) ORDER BY a.file_id LIMIT $5`,
      [p.workspaceId, p.membershipId, id, input.after ?? null, input.limit + 1],
    );
    const items = rows.slice(0, input.limit);
    return { items, next_after: rows.length > input.limit ? items.at(-1)!.id : null };
  }
  async attach(p: Identity, id: string, fileIds: string[]) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p, false);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      const fresh: string[] = [];
      for (const fileId of [...fileIds].sort()) {
        const [old] = await tx.query(
          'SELECT removed_at FROM task_attachments WHERE workspace_id=$1 AND task_id=$2 AND file_id=$3',
          [p.workspaceId, id, fileId],
        );
        if (old) {
          if (old.removed_at)
            throw new AppError(
              410,
              'ATTACHMENT_REMOVED',
              'This attachment was removed. Upload a new file to attach it again.',
            );
          continue;
        }
        const [file] = await tx.query(
          "SELECT id FROM files WHERE workspace_id=$1 AND task_id=$2 AND id=$3 AND uploader_id=$4 AND status='ready' AND scan_status IN ('clean','development_only') AND expires_at>now() FOR UPDATE",
          [p.workspaceId, id, fileId, p.membershipId],
        );
        if (!file)
          throw new AppError(
            400,
            'INVALID_ATTACHMENT',
            'Choose ready files uploaded by you for this task.',
          );
        fresh.push(fileId);
      }
      const [count] = await tx.query(
        'SELECT count(*)::int total FROM task_attachments WHERE workspace_id=$1 AND task_id=$2 AND removed_at IS NULL',
        [p.workspaceId, id],
      );
      if (Number(count!.total) + fresh.length > 100)
        throw new AppError(
          409,
          'ATTACHMENT_LIMIT',
          'A task can have up to 100 active attachments.',
        );
      for (const file of fresh) {
        await tx.query(
          'INSERT INTO task_attachments(workspace_id,task_id,file_id,attached_by) VALUES($1,$2,$3,$4)',
          [p.workspaceId, id, file, p.membershipId],
        );
        await tx.query("UPDATE files SET status='attached' WHERE workspace_id=$1 AND id=$2", [
          p.workspaceId,
          file,
        ]);
        await recordChange(tx, p, 'task.attachment_added', id, task.conversation_id);
      }
      return { ok: true, replayed: fresh.length === 0 };
    });
  }
  async remove(p: Identity, id: string, fileId: string, version: number) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p, false);
      const task = await getTask(tx, p, id, true);
      manageTask(p, task);
      const [row] = await tx.query(
        'SELECT version,removed_at FROM task_attachments WHERE workspace_id=$1 AND task_id=$2 AND file_id=$3 FOR UPDATE',
        [p.workspaceId, id, fileId],
      );
      if (!row) throw notFound();
      if (row.removed_at) return { ok: true, replayed: true };
      if (row.version !== version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'This attachment changed. Refresh before removing it.',
        );
      await tx.query(
        'UPDATE task_attachments SET removed_at=now(),removed_by=$4,version=version+1 WHERE workspace_id=$1 AND task_id=$2 AND file_id=$3',
        [p.workspaceId, id, fileId, p.membershipId],
      );
      await tx.query(
        "UPDATE files SET status='deleting',cleanup_after=now()+interval '5 minutes' WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, fileId],
      );
      await recordChange(tx, p, 'task.attachment_removed', id, task.conversation_id);
      return { ok: true, replayed: false };
    });
  }
}
