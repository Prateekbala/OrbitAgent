import { dispatcherScope, workerScope, scopedDatabase, type Database } from '@ao/database';
import { readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileStore } from './storage.js';
export class FileCleanupWorker {
  private readonly db: Database;
  private sweptAt = 0;
  constructor(
    db: Database,
    private readonly store: FileStore,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly stagingDirectory?: string,
  ) {
    this.db = scopedDatabase(db);
  }
  private async sweepStaging() {
    if (!this.stagingDirectory || Date.now() - this.sweptAt < 3600000) return;
    this.sweptAt = Date.now();
    const entries = await readdir(this.stagingDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries.filter((name) => /^upload-[A-Za-z0-9]+$/.test(name))) {
      const path = join(this.stagingDirectory, entry);
      const metadata = await lstat(path).catch(() => null);
      if (metadata?.isDirectory() && metadata.mtimeMs < Date.now() - 86400000)
        await rm(path, { recursive: true, force: true });
    }
  }
  async tick() {
    await this.sweepStaging();
    const workspaces = await dispatcherScope(() => this.db.query('SELECT id FROM workspaces'));
    for (const workspace of workspaces)
      await workerScope(String(workspace.id), async () => {
        const lease = randomUUID();
        const files = await this.db.transaction(async (tx) => {
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace.id]);
          return tx.query(
            `WITH candidates AS (
          SELECT id FROM files WHERE workspace_id=$1 AND storage_provider=$2 AND cleanup_after<=now() AND NOT governance_held(workspace_id,conversation_id)
          AND (lease_expires_at IS NULL OR lease_expires_at<now())
          AND (status IN ('rejected','deleting') OR (status IN ('pending','ready') AND expires_at<now()) OR (status='uploading' AND lease_expires_at<now()) OR (status='deleted' AND purged_at>now()-interval '7 days'))
          ORDER BY cleanup_after,id LIMIT 20 FOR UPDATE SKIP LOCKED
        ) UPDATE files f SET status='deleting',lease_token=$3,lease_expires_at=now()+interval '5 minutes' FROM candidates c WHERE f.id=c.id RETURNING f.*`,
            [workspace.id, this.store.id, lease],
          );
        });
        for (const file of files) {
          try {
            await this.store.delete(String(file.object_key));
            if (file.preview_key) await this.store.delete(String(file.preview_key));
            await this.store.delete(`${workspace.id}/${file.id}/preview`);
            const versions = await this.db.query(
              'SELECT object_key,preview_key FROM file_versions WHERE workspace_id=$1 AND file_id=$2',
              [workspace.id, file.id],
            );
            for (const version of versions) {
              await this.store.delete(String(version.object_key));
              if (version.preview_key) await this.store.delete(String(version.preview_key));
            }
            const chunks = await this.db.query(
              'SELECT object_key FROM file_upload_chunks WHERE workspace_id=$1 AND file_id=$2',
              [workspace.id, file.id],
            );
            for (const chunk of chunks) await this.store.delete(String(chunk.object_key));
            await this.db.transaction(async (tx) => {
              await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace.id]);
              const [purged] = await tx.query(
                "UPDATE files SET status='deleted',reserved_bytes=0,purged_at=COALESCE(purged_at,now()),cleanup_after=now()+interval '1 day',lease_token=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 RETURNING id",
                [workspace.id, file.id, lease],
              );
              if (purged)
                await tx.query('UPDATE workspaces SET storage_bytes=storage_bytes-$2 WHERE id=$1', [
                  workspace.id,
                  file.reserved_bytes,
                ]);
            });
          } catch (error) {
            this.onError(error);
            await this.db.query(
              "UPDATE files SET cleanup_after=now()+interval '5 minutes',lease_expires_at=NULL,lease_token=NULL WHERE workspace_id=$1 AND id=$2 AND lease_token=$3",
              [workspace.id, file.id, lease],
            );
          }
        }
      });
  }
  start() {
    let stopped = false,
      pending: Promise<void> | undefined;
    const run = () => {
      if (stopped || pending) return;
      pending = this.tick()
        .catch(this.onError)
        .finally(() => {
          pending = undefined;
        });
    };
    const timer = setInterval(run, 30000);
    timer.unref();
    run();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    };
  }
}
