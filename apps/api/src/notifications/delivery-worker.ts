import { randomUUID } from 'node:crypto';
import {
  dispatcherScope,
  identityScope,
  scopedDatabase,
  workerScope,
  type Database,
  type Sql,
} from '@ao/database';
import { deliveryPreferences, deviceRegistration } from '@ao/contracts/delivery';
import { IdentitySecrets } from '../identity/secrets.js';
import { EmailService } from '../email/service.js';
import { DeliveryError } from '../email/provider.js';
import { digest, token } from '../lib/security.js';
import { notificationVisible } from './service.js';
import { PushError, type PushProvider } from './delivery-providers.js';
import { inQuietHours, nextDeliveryAt } from './delivery-policy.js';

async function deliveryCandidate(tx: Sql, workspace: string, member: string, id: string) {
  const [row] = await tx.query(
    `SELECT n.id,n.kind,n.created_at,n.conversation_id,m.thread_id,coalesce(execution.agent_id,run.agent_id,(SELECT a.id FROM agents a WHERE a.workspace_id=n.workspace_id AND a.membership_id=n.actor_id ORDER BY a.id LIMIT 1)) agent_id ${notificationVisible}
    AND n.id=$3 AND n.read_at IS NULL
    AND retrieval_principal_current(n.workspace_id,n.recipient_id)
    AND coalesce((recipient.permissions->>CASE WHEN n.kind LIKE 'task_%' THEN 'tasks.read' WHEN n.kind IN ('agent_attention','automation_attention','workflow_attention','approval_request') THEN 'execution.read' ELSE 'messages.read' END)::boolean,true)
    AND (m.id IS NULL OR message_visible_to(n.workspace_id,m.conversation_id,m.sequence,m.thread_id,n.recipient_id))
    AND resource_visible_to(n.workspace_id,n.conversation_id,coalesce(m.created_at,t.created_at,n.created_at),n.recipient_id)
    AND coalesce((SELECT enabled FROM notification_preferences WHERE workspace_id=n.workspace_id AND membership_id=n.recipient_id),true)
    AND coalesce((SELECT CASE WHEN n.kind='mention' THEN mentions WHEN n.kind='reply' THEN replies WHEN n.kind='reaction' THEN reactions WHEN n.kind LIKE 'task_%' THEN tasks WHEN n.kind='approval_request' THEN approvals ELSE true END FROM notification_preferences WHERE workspace_id=n.workspace_id AND membership_id=n.recipient_id),true)
    AND coalesce((SELECT mode FROM conversation_notification_preferences WHERE workspace_id=n.workspace_id AND membership_id=n.recipient_id AND conversation_id=n.conversation_id),'default')<>'muted'`,
    [workspace, member, id],
  );
  return row;
}
async function policy(tx: Sql, w: string, m: string) {
  const [row] = await tx.query(
    'SELECT preferences FROM notification_delivery_preferences WHERE workspace_id=$1 AND membership_id=$2',
    [w, m],
  );
  return deliveryPreferences.parse(row?.preferences ?? {});
}
async function priority(tx: Sql, w: string, m: string, n: Record<string, unknown>) {
  const scopes = await tx.query(
    "SELECT mode FROM notification_scope_preferences WHERE workspace_id=$1 AND membership_id=$2 AND (scope='conversation' AND resource_id=$3 OR scope='thread' AND resource_id=$4 OR scope='agent' AND resource_id=$5)",
    [w, m, n.conversation_id, n.thread_id, n.agent_id],
  );
  return scopes.some((s) => s.mode === 'muted')
    ? 'muted'
    : scopes.some((s) => s.mode === 'high') ||
        ['mention', 'approval_request', 'agent_attention', 'automation_attention'].includes(
          String(n.kind),
        )
      ? 'high'
      : 'normal';
}
export class NotificationDeliveryWorker {
  private readonly db: Database;
  private pending: Promise<void> | undefined;
  constructor(
    db: Database,
    private readonly secrets: IdentitySecrets,
    private readonly email: EmailService,
    private readonly push?: PushProvider,
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
      () => void this.tick().catch(() => this.onError('NOTIFICATION_DELIVERY_FAILED')),
      3000,
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
        const w = String(workspace.id);
        await this.db.query(
          "UPDATE notification_deliveries SET state='outcome_unknown',error_code='DELIVERY_LEASE_EXPIRED' WHERE workspace_id=$1 AND state='sending' AND lease_expires_at<=now()",
          [w],
        );
        await this.db.query(
          "UPDATE notification_deliveries SET state='failed',error_code='DELIVERY_EXPIRED' WHERE workspace_id=$1 AND state='queued' AND deadline<=now()",
          [w],
        );
        const notifications = await this.db.query(
          "SELECT id,recipient_id,created_at FROM notifications n WHERE workspace_id=$1 AND created_at>now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM notification_delivery_plans p WHERE p.workspace_id=n.workspace_id AND p.notification_id=n.id) ORDER BY sequence LIMIT 100",
          [w],
        );
        for (const n of notifications)
          await this.db.transaction(async (tx) => {
            const [claimed] = await tx.query(
              'INSERT INTO notification_delivery_plans(workspace_id,notification_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING notification_id',
              [w, n.id],
            );
            if (!claimed) return;
            const member = String(n.recipient_id),
              candidate = await deliveryCandidate(tx, w, member, String(n.id));
            if (!candidate) return;
            const p = await policy(tx, w, member),
              level = await priority(tx, w, member, candidate);
            if (level === 'muted' || (p.minimumPriority === 'high' && level !== 'high')) return;
            let plannedPush = false;
            if (p.push) {
              const devices = await tx.query(
                'SELECT id,platform FROM notification_devices WHERE workspace_id=$1 AND membership_id=$2 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC,id LIMIT $3',
                [w, member, p.deviceRouting === 'all' ? 20 : 1],
              );
              for (const device of devices)
                if (this.push?.supports(device.platform as 'browser')) {
                  plannedPush = true;
                  await this.enqueue(
                    tx,
                    w,
                    member,
                    String(n.id),
                    'push',
                    String(device.id),
                    nextDeliveryAt(new Date(String(n.created_at)), p, 'push'),
                  );
                }
            }
            if (
              p.email !== 'off' &&
              this.email.configured &&
              !(plannedPush && level === 'high' && p.escalationMinutes !== null)
            )
              await this.enqueue(
                tx,
                w,
                member,
                String(n.id),
                'email',
                null,
                nextDeliveryAt(new Date(String(n.created_at)), p, 'email'),
              );
          });
        const escalations = await this.db.query(
          "SELECT d.notification_id,d.membership_id FROM notification_deliveries d JOIN notification_delivery_preferences p ON p.workspace_id=d.workspace_id AND p.membership_id=d.membership_id WHERE d.workspace_id=$1 AND d.channel='push' AND d.state IN ('sent','received','failed','outcome_unknown') AND p.preferences->>'email'<>'off' AND p.preferences->>'escalationMinutes' IS NOT NULL AND d.deadline>now() AND coalesce(d.sent_at,d.created_at)+((p.preferences->>'escalationMinutes')::int*interval '1 minute')<=now() AND NOT EXISTS(SELECT 1 FROM notification_deliveries e WHERE e.workspace_id=d.workspace_id AND e.notification_id=d.notification_id AND e.channel='email') LIMIT 100",
          [w],
        );
        for (const e of escalations) {
          const n = await deliveryCandidate(
            this.db,
            w,
            String(e.membership_id),
            String(e.notification_id),
          );
          if (
            n &&
            (await priority(this.db, w, String(e.membership_id), n)) === 'high' &&
            this.email.configured
          ) {
            const p = await policy(this.db, w, String(e.membership_id));
            await this.enqueue(
              this.db,
              w,
              String(e.membership_id),
              String(e.notification_id),
              'email',
              null,
              nextDeliveryAt(new Date(), p, 'email'),
            );
          }
        }
        for (let i = 0; i < 20; i++) {
          const handled = await this.deliver(w);
          if (!handled) break;
        }
        await this.db.query(
          'UPDATE notification_devices SET ciphertext=NULL,revoked_at=coalesce(revoked_at,now()) WHERE workspace_id=$1 AND expires_at<=now()',
          [w],
        );
        await this.db.query(
          "DELETE FROM notification_deliveries WHERE workspace_id=$1 AND created_at<now()-interval '90 days' AND state<>'sending'",
          [w],
        );
        await this.db.query(
          "DELETE FROM notification_delivery_plans WHERE workspace_id=$1 AND created_at<now()-interval '25 hours'",
          [w],
        );
      });
  }
  private async enqueue(
    tx: Sql,
    w: string,
    m: string,
    n: string,
    channel: string,
    device: string | null,
    at: Date,
  ) {
    await tx.query(
      'INSERT INTO notification_deliveries(id,workspace_id,membership_id,notification_id,channel,device_id,available_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
      [randomUUID(), w, m, n, channel, device, at.toISOString()],
    );
  }
  private async deliver(w: string) {
    const batch = await this.db.transaction(async (tx) => {
      const [first] = await tx.query(
        "SELECT * FROM notification_deliveries WHERE workspace_id=$1 AND state='queued' AND available_at<=now() AND deadline>now() ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
        [w],
      );
      if (!first) return null;
      const [locked] = await tx.query(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1,77113)) locked',
        [w + ':' + first.membership_id + ':' + first.channel + ':' + (first.device_id ?? 'email')],
      );
      if (!locked?.locked) return null;
      const p = await policy(tx, w, String(first.membership_id));
      const rows = await tx.query(
        "SELECT * FROM notification_deliveries WHERE workspace_id=$1 AND membership_id=$2 AND channel=$3 AND device_id IS NOT DISTINCT FROM $4::uuid AND batch_id IS NOT DISTINCT FROM $5::uuid AND state='queued' AND available_at<=now() AND deadline>now() ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 100",
        [w, first.membership_id, first.channel, first.device_id, first.batch_id],
      );
      const valid = [];
      for (const row of rows) {
        const n = await deliveryCandidate(
          tx,
          w,
          String(row.membership_id),
          String(row.notification_id),
        );
        const level = n ? await priority(tx, w, String(row.membership_id), n) : 'muted';
        if (
          !n ||
          level === 'muted' ||
          (p.minimumPriority === 'high' && level !== 'high') ||
          (row.channel === 'push' && !p.push) ||
          (row.channel === 'email' && p.email === 'off')
        )
          await tx.query(
            "UPDATE notification_deliveries SET state='cancelled',error_code='ACCESS_OR_PREFERENCE_CHANGED' WHERE workspace_id=$1 AND id=$2",
            [w, row.id],
          );
        else {
          const next = nextDeliveryAt(
            new Date(String(n.created_at)),
            p,
            row.channel as 'push' | 'email',
          );
          if (next.getTime() > Date.now())
            await tx.query(
              'UPDATE notification_deliveries SET available_at=$3 WHERE workspace_id=$1 AND id=$2',
              [w, row.id, next.toISOString()],
            );
          else valid.push(row);
        }
      }
      if (!valid.length) return { skip: true } as const;
      if (inQuietHours(new Date(), p)) {
        const at = nextDeliveryAt(new Date(), { ...p, batchMinutes: 0 }, 'push');
        await tx.query(
          'UPDATE notification_deliveries SET available_at=$3 WHERE workspace_id=$1 AND id=ANY($2::uuid[])',
          [w, valid.map((r) => r.id), at.toISOString()],
        );
        return { skip: true } as const;
      }
      const lease = randomUUID(),
        receipt = token();
      const batchId = String(first.batch_id ?? first.id);
      await tx.query(
        "UPDATE notification_deliveries SET state='sending',lease_token=$3,lease_expires_at=now()+interval '1 minute',attempts=attempts+1,receipt_hash=$4,batch_id=$5 WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
        [w, valid.map((r) => r.id), lease, digest(receipt), batchId],
      );
      return { rows: valid, lease, receipt, batchId };
    });
    if (!batch) return false;
    if ('skip' in batch) return true;
    const first = batch.rows[0]!,
      ids = batch.rows.map((row) => row.id),
      member = String(first.membership_id);
    let dispatched = false;
    try {
      for (const row of batch.rows)
        if (!(await deliveryCandidate(this.db, w, member, String(row.notification_id))))
          throw new PushError('DELIVERY_NO_LONGER_VISIBLE');
      let provider: string;
      if (first.channel === 'push') {
        const [device] = await this.db.query(
          'SELECT d.* FROM notification_devices d JOIN sessions s ON s.token_hash=d.session_hash AND s.workspace_id=d.workspace_id AND s.membership_id=d.membership_id JOIN member_account_authority($1,$3) a ON a.auth_version=d.auth_version AND a.verified WHERE d.workspace_id=$1 AND d.id=$2 AND d.membership_id=$3 AND d.revoked_at IS NULL AND d.expires_at>now() AND s.expires_at>now()',
          [w, first.device_id, member],
        );
        if (!device?.ciphertext) throw new PushError('PUSH_DEVICE_REVOKED', false, true);
        const target = deviceRegistration.parse(
          JSON.parse(
            this.secrets.open(`notification-device:${w}:${device.id}`, String(device.ciphertext)),
          ),
        );
        if (!this.push) throw new PushError('PUSH_PROVIDER_UNAVAILABLE');
        dispatched = true;
        provider = await this.push.send(target, {
          title: 'Orbit',
          body:
            batch.rows.length === 1
              ? 'You have a new notification.'
              : `You have ${batch.rows.length} new notifications.`,
          url: '/app',
          tag: 'orbit-' + member,
          receipt: { workspaceId: w, deliveryId: String(first.id), token: batch.receipt },
        });
      } else {
        const [account] = await identityScope(
          () =>
            this.db.query(
              "SELECT a.email FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.workspace_id=$1 AND m.id=$2 AND m.status='active' AND a.email_verified_at IS NOT NULL AND a.disabled_at IS NULL",
              [w, member],
            ),
          w,
        );
        if (!account) throw new PushError('EMAIL_RECIPIENT_UNAVAILABLE');
        const message = this.email.notificationMessage(String(account.email), batch.rows.length);
        dispatched = true;
        provider = await this.email.provider!.send(message, 'orbit-notifications/' + batch.batchId);
      }
      await this.db.query(
        "UPDATE notification_deliveries SET state=CASE WHEN state='sending' THEN 'sent' ELSE state END,sent_at=now(),provider_id=$4,lease_token=NULL,lease_expires_at=NULL,error_code=NULL WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND lease_token=$3 AND state IN ('sending','received','opened')",
        [w, ids, batch.lease, provider],
      );
    } catch (error) {
      const uncertain =
        dispatched &&
        ((first.channel === 'push' && (!(error instanceof PushError) || error.uncertain)) ||
          (first.channel === 'email' &&
            !this.email.provider?.idempotent &&
            (!(error instanceof DeliveryError) || error.uncertain)));
      const retry =
        !uncertain &&
        Number(first.attempts) < 5 &&
        (error instanceof PushError || error instanceof DeliveryError) &&
        error.retryable;
      const state = uncertain
        ? 'outcome_unknown'
        : retry
          ? 'queued'
          : dispatched
            ? 'failed'
            : 'cancelled';
      const code =
        error instanceof PushError || error instanceof DeliveryError
          ? error.code
          : 'DELIVERY_TRANSPORT_FAILED';
      await this.db.query(
        "UPDATE notification_deliveries SET state=$4,error_code=$5,available_at=now()+$6::interval,lease_token=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND lease_token=$3 AND state='sending'",
        [
          w,
          ids,
          batch.lease,
          state,
          code,
          Math.min(1800, 30 * 2 ** Number(first.attempts)) + ' seconds',
        ],
      );
      if (error instanceof PushError && error.expired && first.device_id)
        await this.db.query(
          'UPDATE notification_devices SET revoked_at=now(),ciphertext=NULL WHERE workspace_id=$1 AND id=$2',
          [w, first.device_id],
        );
      this.onError(code);
    }
    return true;
  }
}
