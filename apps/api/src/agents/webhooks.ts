import { createHmac, randomUUID } from 'node:crypto';
import { Agent, request } from 'undici';
import { dispatcherScope, scopedDatabase, workerScope, type Database } from '@ao/database';
import type { IdentitySecrets } from '../identity/secrets.js';
import { validatePublicEndpoint } from '../lib/safe-endpoint.js';
import { expireInbox } from './inbox.js';

export const validateWebhookUrl = (value: string, hosts: string[]) =>
  validatePublicEndpoint(value, hosts, 'WEBHOOK');
export function webhookSignature(secret: string, id: string, timestamp: string, body: string) {
  return createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('hex');
}
export type WakeupSender = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<number>;
export function webhookSender(hosts: string[]): WakeupSender {
  return async (value, headers, body) => {
    const { url, address } = await validateWebhookUrl(value, hosts);
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [{ address: address.address, family: address.family }])
            : callback(null, address.address, address.family),
      },
    });
    try {
      const response = await request(url, {
        dispatcher,
        method: 'POST',
        headers,
        body,
        headersTimeout: 10000,
        bodyTimeout: 10000,
        signal: AbortSignal.timeout(10000),
      });
      response.body.destroy();
      return response.statusCode;
    } finally {
      await dispatcher.close();
    }
  };
}
export class AgentDeliveryWorker {
  private busy = false;
  private stopped = false;
  private active: Promise<void> | null = null;
  constructor(
    private db: Database,
    private secrets: IdentitySecrets,
    private send: WakeupSender,
    private onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  start() {
    const timer = setInterval(() => {
      if (!this.busy && !this.stopped)
        this.active = this.tick().catch(() => this.onError('AGENT_DELIVERY_FAILED'));
    }, 1000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      this.stopped = true;
      await this.active;
    };
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const workspace of await dispatcherScope(() =>
        this.db.query<{ id: string }>('SELECT id FROM workspaces'),
      )) {
        if (this.stopped) break;
        await workerScope(workspace.id, async () => {
          await this.db.transaction(expireInbox);
          await this.db.query(
            "UPDATE agent_wakeups d SET state='dead',error_code='DELIVERY_SUPERSEDED',lease_token=NULL,lease_expires_at=NULL WHERE d.state='pending' AND (NOT EXISTS(SELECT 1 FROM agent_webhooks w WHERE w.workspace_id=d.workspace_id AND w.agent_id=d.agent_id AND w.version=d.webhook_version AND w.enabled) OR NOT EXISTS(SELECT 1 FROM agent_inbox i JOIN messages m ON m.workspace_id=i.workspace_id AND m.id=i.message_id WHERE i.workspace_id=d.workspace_id AND i.id=d.inbox_id AND i.state='pending' AND i.expires_at>now() AND m.deleted_at IS NULL))",
          );
          await this.db.query(
            "INSERT INTO agent_wakeups(workspace_id,agent_id,inbox_id,webhook_version,generation) SELECT i.workspace_id,i.agent_id,i.id,w.version,i.fence FROM agent_inbox i JOIN agent_webhooks w ON w.workspace_id=i.workspace_id AND w.agent_id=i.agent_id JOIN agents a ON a.workspace_id=i.workspace_id AND a.id=i.agent_id JOIN messages m ON m.workspace_id=i.workspace_id AND m.id=i.message_id WHERE i.state='pending' AND i.expires_at>now() AND w.enabled AND a.status='active' AND m.deleted_at IS NULL AND message_visible_to(m.workspace_id,m.conversation_id,m.sequence,m.thread_id,a.membership_id) AND NOT EXISTS(SELECT 1 FROM agent_wakeups d WHERE d.workspace_id=i.workspace_id AND d.inbox_id=i.id AND d.webhook_version=w.version AND d.generation=i.fence) ORDER BY i.created_at LIMIT 100 ON CONFLICT DO NOTHING",
          );
          await this.db.query(
            "UPDATE agent_wakeups SET state=CASE WHEN attempts>=8 THEN 'dead' ELSE 'pending' END,lease_token=NULL WHERE state='sending' AND lease_expires_at<=now()",
          );
          const delivery = await this.db.transaction<
            (Record<string, unknown> & { lease: string }) | null
          >(async (tx) => {
            const [row] = await tx.query(
              "SELECT d.*,w.url,w.encrypted_secret FROM agent_wakeups d JOIN agent_webhooks w ON w.workspace_id=d.workspace_id AND w.agent_id=d.agent_id AND w.version=d.webhook_version JOIN agents a ON a.workspace_id=d.workspace_id AND a.id=d.agent_id JOIN agent_inbox i ON i.workspace_id=d.workspace_id AND i.id=d.inbox_id JOIN messages m ON m.workspace_id=i.workspace_id AND m.id=i.message_id WHERE d.state='pending' AND d.available_at<=now() AND w.enabled AND a.status='active' AND EXISTS(SELECT 1 FROM agent_revisions v WHERE v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision AND v.configuration->>'activation'='mentions' AND (jsonb_array_length(v.configuration->'conversationIds')=0 OR v.configuration->'conversationIds' ? m.conversation_id::text)) AND i.state='pending' AND i.expires_at>now() AND m.deleted_at IS NULL AND message_visible_to(m.workspace_id,m.conversation_id,m.sequence,m.thread_id,a.membership_id) ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1",
            );
            if (!row) return null;
            const lease = randomUUID();
            await tx.query(
              "UPDATE agent_wakeups SET state='sending',attempts=attempts+1,lease_token=$2,lease_expires_at=now()+interval '30 seconds' WHERE id=$1",
              [row.id, lease],
            );
            return { ...row, lease };
          });
          if (!delivery) return;
          let success = false,
            errorCode = 'WEBHOOK_REJECTED';
          try {
            const body = JSON.stringify({
                id: delivery.id,
                type: 'agent.inbox_ready',
                agentId: delivery.agent_id,
                inboxId: delivery.inbox_id,
              }),
              timestamp = String(Math.floor(Date.now() / 1000));
            const secret = this.secrets.open(
              `agent-webhook:${workspace.id}:${delivery.agent_id}`,
              String(delivery.encrypted_secret),
            );
            const status = await this.send(
              String(delivery.url),
              {
                'content-type': 'application/json',
                'webhook-id': String(delivery.id),
                'webhook-timestamp': timestamp,
                'webhook-signature': `v1=${webhookSignature(secret, String(delivery.id), timestamp, body)}`,
              },
              body,
            );
            success = status >= 200 && status < 300;
          } catch {
            errorCode = 'WEBHOOK_UNAVAILABLE';
          }
          await this.db.query(
            "UPDATE agent_wakeups SET state=CASE WHEN $3 THEN 'delivered' WHEN attempts>=8 THEN 'dead' ELSE 'pending' END,delivered_at=CASE WHEN $3 THEN now() ELSE NULL END,error_code=CASE WHEN $3 THEN NULL ELSE $4 END,available_at=now()+least(3600,15*power(2,attempts))*interval '1 second',lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2 AND state='sending'",
            [delivery.id, delivery.lease, success, errorCode],
          );
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
