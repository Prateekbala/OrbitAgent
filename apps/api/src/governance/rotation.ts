import type { Database } from '@ao/database';
import { IdentitySecrets } from '../identity/secrets.js';
const inventory = [
  ['account_mfa', 'secret', "'mfa:'||account_id"],
  ['identity_providers', 'secret', "'provider:'||id"],
  ['connection_secrets', 'encrypted_value', "'connection:'||workspace_id||':'||connection_id"],
  [
    'tool_connection_secrets',
    'encrypted_secret',
    "'tool-connection:'||workspace_id||':'||connection_id",
  ],
  ['agent_webhooks', 'encrypted_secret', "'agent-webhook:'||workspace_id||':'||agent_id"],
  ['calendar_connections', 'credentials', "'calendar:'||workspace_id||':'||id"],
  ['developer_webhooks', 'encrypted_secret', "'developer-webhook:'||workspace_id||':'||id"],
  [
    'connection_webhooks',
    'encrypted_incoming',
    "'connection-hook:'||workspace_id||':'||connection_id||':incoming'",
  ],
  [
    'connection_webhooks',
    'encrypted_outgoing',
    "'connection-hook:'||workspace_id||':'||connection_id||':outgoing'",
  ],
  [
    'connection_native_hooks',
    'encrypted_secret',
    "'native-hook:'||workspace_id||':'||connection_id",
  ],
  ['notification_devices', 'ciphertext', "'notification-device:'||workspace_id||':'||id"],
  ['migration_sources', 'relay_secret', "'migration:'||id"],
] as const;
export async function rewrapCredentials(
  db: Database,
  keys: IdentitySecrets,
  apply = false,
  batch = 200,
) {
  if (!Number.isInteger(batch) || batch < 1 || batch > 1000)
    throw new Error('Invalid rotation batch.');
  const result: {
    table: string;
    column: string;
    scanned: number;
    changed: number;
    remaining: boolean;
  }[] = [];
  for (const [table, column, context] of inventory) {
    const summary = await db.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT ctid::text locator,${column} value,${context} context FROM ${table} WHERE ${column} IS NOT NULL AND ${column}<>'' AND ${column} NOT LIKE $1 ORDER BY ctid LIMIT $2 FOR UPDATE`,
        [keys.writePrefix + '%', batch],
      );
      let changed = 0;
      for (const row of rows) {
        const plain = keys.open(String(row.context), String(row.value));
        if (apply) {
          await tx.query(`UPDATE ${table} SET ${column}=$2 WHERE ctid=$1::tid`, [
            row.locator,
            keys.seal(String(row.context), plain),
          ]);
          changed++;
        }
      }
      const [pending] = await tx.query(
        `SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL AND ${column}<>'' AND ${column} NOT LIKE $1) pending`,
        [keys.writePrefix + '%'],
      );
      return { table, column, scanned: rows.length, changed, remaining: Boolean(pending!.pending) };
    });
    result.push(summary);
  }
  return {
    apply,
    inventory: result,
    retirementApproved: false,
    requires: [
      'expire-inflight-oauth-and-execution-capabilities',
      'drain-email-key-queue',
      'backup-key-retention-review',
      'all-replicas-on-new-write-key',
    ],
  };
}
