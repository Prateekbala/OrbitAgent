import { dispatcherScope, workerScope, scopedDatabase, type Database } from '@ao/database';
import { messageInput } from '@ao/contracts';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { hasPermission } from '../identity/authorization.js';
import { sendMessage } from './send.js';
export class MessageDeliveryWorker {
  private readonly db: Database;
  private pending: Promise<void> | null = null;
  constructor(
    db: Database,
    private readonly onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    if (this.pending) return this.pending;
    this.pending = this.deliver().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async deliver() {
    const workspaces = await dispatcherScope(() => this.db.query('SELECT id FROM workspaces'));
    for (const workspace of workspaces)
      await workerScope(String(workspace.id), async () => {
        const due = await this.db.query(
          "SELECT id,conversation_id FROM scheduled_messages WHERE workspace_id=$1 AND status='scheduled' AND send_at<=now() ORDER BY send_at,id LIMIT 50",
          [workspace.id],
        );
        for (const reference of due)
          await this.db.transaction(async (tx) => {
            await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [workspace.id]);
            await tx.query(
              'SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
              [workspace.id, reference.conversation_id],
            );
            const [scheduled] = await tx.query(
              "SELECT * FROM scheduled_messages WHERE workspace_id=$1 AND id=$2 AND status='scheduled' AND send_at<=now() FOR UPDATE SKIP LOCKED",
              [workspace.id, reference.id],
            );
            if (!scheduled) return;
            await tx.query('SET LOCAL ROLE ao_identity');
            const [member] = await tx.query(
              'SELECT m.*,a.auth_version,a.email_verified_at,a.disabled_at,om.status organization_status,o.version organization_policy_version FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN workspaces w ON w.id=m.workspace_id JOIN organizations o ON o.id=w.organization_id JOIN organization_members om ON om.organization_id=w.organization_id AND om.account_id=a.id WHERE m.workspace_id=$1 AND m.id=$2 FOR SHARE OF m,a',
              [workspace.id, scheduled.membership_id],
            );
            await tx.query('SET LOCAL ROLE ao_worker');
            let error: string | null = null;
            if (
              !member ||
              member.status !== 'active' ||
              member.organization_status !== 'active' ||
              !member.email_verified_at ||
              member.disabled_at ||
              member.auth_version !== scheduled.auth_version
            )
              error = 'AUTHORITY_REVOKED';
            if (
              !error &&
              member?.organization_policy_version !== scheduled.organization_policy_version
            )
              error = 'ORGANIZATION_POLICY_CHANGED';
            const p: Identity = {
              workspaceId: String(workspace.id),
              membershipId: String(scheduled.membership_id),
              name: String(member?.name ?? ''),
              kind: 'human',
              role: member?.role as Identity['role'],
              accessType: member?.access_type as NonNullable<Identity['accessType']>,
              permissions: member?.permissions as NonNullable<Identity['permissions']>,
            };
            if (!error && !hasPermission(p, 'messages.write')) error = 'PERMISSION_DENIED';
            await tx.query('SAVEPOINT message_delivery');
            let message: string | null = null;
            if (!error)
              try {
                const result = await sendMessage(
                  tx,
                  p,
                  String(scheduled.conversation_id),
                  messageInput.parse({
                    body: scheduled.body,
                    format: scheduled.format,
                    clientId: scheduled.client_id,
                    attachmentIds: scheduled.attachment_ids,
                    mentionIds: scheduled.mention_ids,
                    expectedAuthorId: p.membershipId,
                    ...(scheduled.thread_id ? { threadId: scheduled.thread_id } : {}),
                  }),
                );
                message = String(result.id);
              } catch (cause) {
                if (!(cause instanceof AppError)) throw cause;
                await tx.query('ROLLBACK TO SAVEPOINT message_delivery');
                error = cause.code;
              }
            await tx.query('RELEASE SAVEPOINT message_delivery');
            await tx.query(
              'UPDATE scheduled_messages SET status=$3,error_code=$4,message_id=$5,version=version+1 WHERE workspace_id=$1 AND id=$2',
              [workspace.id, scheduled.id, error ? 'blocked' : 'sent', error, message],
            );
            await tx.query(
              "INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id) VALUES($1,'personal.changed',$2,$3)",
              [workspace.id, scheduled.id, scheduled.membership_id],
            );
          });
      });
  }
  start(interval = 5000) {
    const run = () => {
      void this.tick().catch(() => this.onError('MESSAGE_DELIVERY_FAILED'));
    };
    const timer = setInterval(run, interval);
    timer.unref();
    run();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
}
