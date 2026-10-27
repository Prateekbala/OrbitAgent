import {
  dispatcherScope,
  workerScope,
  identifyPrincipal,
  scopedDatabase,
  type Database,
} from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { ImportService } from './imports.js';
export class MigrationWorker {
  private busy = false;
  private active: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private db: Database,
    private onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  start(interval = 2000) {
    const timer = setInterval(() => {
      if (!this.busy && !this.stopped)
        this.active = this.tick().catch(() => this.onError('MIGRATION_WORKER_FAILED'));
    }, interval);
    timer.unref();
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      await this.active;
    };
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const workspaces = await dispatcherScope(() =>
        this.db.query('SELECT id FROM workspaces ORDER BY id'),
      );
      for (const w of workspaces)
        await workerScope(String(w.id), async () => {
          const sources = await this.db.query(
            "SELECT s.*,m.name,m.role,m.permissions FROM migration_sources s JOIN memberships m ON m.workspace_id=s.workspace_id AND m.id=s.owner_id WHERE s.workspace_id=$1 AND s.state='active' ORDER BY s.created_at LIMIT 20",
            [w.id],
          );
          for (const s of sources) {
            const p: Identity = {
              workspaceId: String(w.id),
              membershipId: String(s.owner_id),
              name: String(s.name),
              kind: 'human',
              role: s.role as Identity['role'],
              accessType: 'member',
              authVersion: Number(s.owner_auth_version),
              policyVersion: Number(s.owner_policy_version),
              permissions: s.permissions as NonNullable<Identity['permissions']>,
            };
            identifyPrincipal(p.membershipId, 'member');
            try {
              await new ImportService(this.db).process(p, String(s.id));
            } catch {
              await this.db.query(
                "UPDATE migration_sources SET state='paused',version=version+1 WHERE workspace_id=$1 AND id=$2 AND state='active'",
                [w.id, s.id],
              );
              this.onError('MIGRATION_SOURCE_PAUSED');
            }
          }
        });
    } finally {
      this.busy = false;
    }
  }
}
