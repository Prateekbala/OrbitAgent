import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dispatcherScope, workerScope, scopedDatabase, type Database } from '@ao/database';
import type { FileDependencies } from './config.js';
import { currentDlp, inspectDlp } from './dlp.js';
export class FileGovernanceWorker {
  private readonly db: Database;
  private pending: Promise<void> | undefined;
  constructor(
    db: Database,
    private readonly files: FileDependencies,
    private readonly onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    if (this.pending) return this.pending;
    this.pending = this.process().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  start() {
    const timer = setInterval(
      () => void this.tick().catch(() => this.onError('FILE_GOVERNANCE_FAILED')),
      15000,
    );
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
  private async process() {
    for (const workspace of await dispatcherScope(() => this.db.query('SELECT id FROM workspaces')))
      await workerScope(String(workspace.id), async () => {
        const w = String(workspace.id),
          policy = await currentDlp(this.db, w);
        if (policy.enabled)
          for (const table of ['files', 'file_versions'] as const) {
            const lease = randomUUID();
            const rows = await this.db.query(
              `UPDATE ${table} f SET dlp_lease=$3,dlp_lease_until=now()+interval '5 minutes' WHERE (workspace_id,${table === 'files' ? 'id' : 'file_id'},version) IN (SELECT workspace_id,${table === 'files' ? 'id' : 'file_id'},version FROM ${table} WHERE workspace_id=$1 AND storage_provider=$4 AND dlp_policy_version<>$2 AND (dlp_lease_until IS NULL OR dlp_lease_until<now()) ${table === 'files' ? "AND status IN ('ready','attached')" : ''} ORDER BY ${table === 'files' ? 'id' : 'file_id'},version FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING *`,
              [w, policy.version, lease, this.files.store.id],
            );
            for (const row of rows) {
              let directory: string | undefined;
              try {
                await mkdir(this.files.stagingDirectory, { recursive: true, mode: 0o700 });
                directory = await mkdtemp(join(this.files.stagingDirectory, 'upload-'));
                const path = join(directory, 'inspection'),
                  hash = createHash('sha256');
                let size = 0;
                await pipeline(
                  await this.files.store.get(String(row.object_key)),
                  new Transform({
                    transform(chunk: Buffer, _encoding, done) {
                      size += chunk.length;
                      if (size > Number(row.size)) return done(new Error('FILE_INTEGRITY'));
                      hash.update(chunk);
                      done(null, chunk);
                    },
                  }),
                  createWriteStream(path, { flags: 'wx', mode: 0o600 }),
                  { signal: AbortSignal.timeout(30000) },
                );
                if (size !== Number(row.size) || hash.digest('hex') !== row.sha256)
                  throw new Error('FILE_INTEGRITY');
                const result = await inspectDlp(path, String(row.name), policy);
                await this.db.query(
                  `UPDATE ${table} SET dlp_status=$5,dlp_policy_version=$6,dlp_findings=$7::jsonb,dlp_lease=NULL,dlp_lease_until=NULL WHERE workspace_id=$1 AND ${table === 'files' ? 'id' : 'file_id'}=$2 AND version=$3 AND dlp_lease=$4 AND sha256=$8`,
                  [
                    w,
                    row.id ?? row.file_id,
                    row.version,
                    lease,
                    result.status,
                    result.version,
                    JSON.stringify(result.findings),
                    row.sha256,
                  ],
                );
              } catch {
                this.onError('FILE_INSPECTION_FAILED');
              } finally {
                if (directory) await rm(directory, { recursive: true, force: true });
              }
            }
          }
        const chunks = await this.db.query(
          "SELECT c.file_id,c.offset_bytes,c.object_key FROM file_upload_chunks c JOIN files f ON f.workspace_id=c.workspace_id AND f.id=c.file_id WHERE c.workspace_id=$1 AND (f.status IN ('ready','attached','rejected','deleting','deleted') OR f.expires_at<now()) AND c.lease_until<now() AND c.cleanup_after<=now() ORDER BY c.cleanup_after LIMIT 100",
          [w],
        );
        for (const chunk of chunks) {
          await this.files.store.delete(String(chunk.object_key));
          await this.db.query(
            "UPDATE file_upload_chunks SET cleanup_after=now()+interval '1 day' WHERE workspace_id=$1 AND file_id=$2 AND offset_bytes=$3",
            [w, chunk.file_id, chunk.offset_bytes],
          );
        }
      });
  }
}
