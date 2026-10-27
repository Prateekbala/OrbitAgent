import { dispatcherScope, workerScope, scopedDatabase, type Database } from '@ao/database';
export class ActivityCleanupWorker {
  private readonly db: Database;
  constructor(
    db: Database,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  async tick() {
    const workspaces = await dispatcherScope(() => this.db.query('SELECT id FROM workspaces'));
    for (const workspace of workspaces)
      await workerScope(String(workspace.id), () =>
        this.db.query('DELETE FROM activity_sessions WHERE workspace_id=$1 AND expires_at<now()', [
          workspace.id,
        ]),
      );
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
    const timer = setInterval(run, 60000);
    timer.unref();
    run();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    };
  }
}
