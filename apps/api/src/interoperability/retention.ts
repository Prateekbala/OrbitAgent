import { dispatcherScope, workerScope, scopedDatabase, type Database } from '@ao/database';
export class SharedRetentionWorker {
  private busy = false;
  private active: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private db: Database,
    private onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  start(interval = 60000) {
    const timer = setInterval(() => {
      if (!this.busy && !this.stopped)
        this.active = this.tick().catch(() => this.onError('SHARED_RETENTION_FAILED'));
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
      const tenants = await dispatcherScope(() =>
        this.db.query('SELECT id FROM workspaces ORDER BY id'),
      );
      for (const tenant of tenants)
        await workerScope(String(tenant.id), () =>
          this.db.transaction(async (tx) => {
            await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [tenant.id]);
            const rows = await tx.query(
              "SELECT m.id,m.conversation_id,(SELECT invited_by FROM shared_channel_grants g WHERE g.workspace_id=m.workspace_id AND g.conversation_id=m.conversation_id ORDER BY created_at LIMIT 1) actor_id FROM messages m JOIN shared_channel_policies p ON p.workspace_id=m.workspace_id AND p.conversation_id=m.conversation_id WHERE m.workspace_id=$1 AND m.deleted_at IS NULL AND m.created_at<now()-(p.policy->>'retentionDays')::int*interval '1 day' ORDER BY m.created_at,m.id LIMIT 100 FOR UPDATE OF m",
              [tenant.id],
            );
            for (const row of rows) {
              await tx.query(
                "UPDATE agent_inbox SET state='expired',expires_at=least(expires_at,now()),lease_token=NULL,lease_expires_at=NULL,fence=fence+1,summary='Shared-channel retention expired' WHERE workspace_id=$1 AND message_id=$2 AND state IN ('pending','leased')",
                [tenant.id, row.id],
              );
              await tx.query(
                "UPDATE messages SET body='',deleted_at=now(),deleted_by=$3,version=version+1,source_attribution=CASE WHEN source_attribution IS NULL THEN NULL ELSE jsonb_set(jsonb_set(source_attribution,'{reactions}','[]'::jsonb),'{files}','[]'::jsonb) END WHERE workspace_id=$1 AND id=$2",
                [tenant.id, row.id, row.actor_id],
              );
              await tx.query(
                'DELETE FROM message_reactions WHERE workspace_id=$1 AND message_id=$2',
                [tenant.id, row.id],
              );
              await tx.query(
                "UPDATE files SET status='deleting',cleanup_after=now()+interval '5 minutes' WHERE workspace_id=$1 AND id IN (SELECT file_id FROM message_attachments WHERE workspace_id=$1 AND message_id=$2)",
                [tenant.id, row.id],
              );
              await tx.query(
                "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id) VALUES($1,'message.deleted',$2,$3)",
                [tenant.id, row.id, row.conversation_id],
              );
              await tx.query(
                "INSERT INTO audit_events(id,workspace_id,actor_id,action,resource_id,conversation_id) VALUES(gen_random_uuid(),$1,$2,'shared_channel.retention_expired',$3,$4)",
                [tenant.id, row.actor_id, row.id, row.conversation_id],
              );
            }
          }),
        );
    } finally {
      this.busy = false;
    }
  }
}
