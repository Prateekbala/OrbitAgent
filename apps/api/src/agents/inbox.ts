import { randomUUID } from 'node:crypto';
import type { Sql } from '@ao/database';
import { AppError, notFound } from '../lib/errors.js';
import type { Identity } from '../lib/policy.js';

export async function expireInbox(tx: Sql) {
  await tx.query(
    "UPDATE agent_inbox SET state='expired',lease_token=NULL,lease_expires_at=NULL WHERE state IN ('pending','leased') AND expires_at<=now()",
  );
  await tx.query(
    "UPDATE agent_inbox SET state=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,available_at=now()+least(3600,30*power(2,least(attempts,6))) * interval '1 second',lease_token=NULL,lease_expires_at=NULL,credential_id=NULL WHERE state='leased' AND lease_expires_at<=now()",
  );
}
export async function leaseInbox(tx: Sql, p: Identity, id: string, seconds: number) {
  if (!p.credentialId) throw new AppError(403, 'AGENT_ONLY', 'Use a scoped agent credential.');
  await expireInbox(tx);
  const [row] = await tx.query(
    "SELECT i.* FROM agent_inbox i JOIN agents a ON a.workspace_id=i.workspace_id AND a.id=i.agent_id JOIN agent_revisions v ON v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision JOIN messages m ON m.workspace_id=i.workspace_id AND m.id=i.message_id WHERE v.configuration->>'activation'='mentions' AND (jsonb_array_length(v.configuration->'conversationIds')=0 OR v.configuration->'conversationIds' ? m.conversation_id::text) AND i.workspace_id=$1 AND i.id=$2 AND a.membership_id=$3 AND a.runtime='external' AND a.status='active' FOR UPDATE OF i",
    [p.workspaceId, id, p.membershipId],
  );
  if (!row) throw notFound();
  if (row.state !== 'pending' || new Date(String(row.available_at)).getTime() > Date.now())
    throw new AppError(409, 'DELIVERY_UNAVAILABLE', 'This delivery is not available for a lease.');
  const leaseToken = randomUUID();
  const [lease] = await tx.query(
    "UPDATE agent_inbox SET state='leased',lease_token=$3,credential_id=$4,lease_expires_at=least(expires_at,now()+$5*interval '1 second'),fence=fence+1,attempts=attempts+1 WHERE workspace_id=$1 AND id=$2 RETURNING id,lease_token,fence,lease_expires_at,attempts",
    [p.workspaceId, id, leaseToken, p.credentialId, seconds],
  );
  return lease;
}
export async function deliveryLease(
  tx: Sql,
  p: Identity,
  id: string,
  leaseToken: string,
  fence: number,
) {
  const [row] = await tx.query(
    "SELECT * FROM agent_inbox WHERE workspace_id=$1 AND id=$2 AND credential_id=$3 AND state='leased' AND lease_token=$4 AND fence=$5 AND lease_expires_at>now() AND expires_at>now() FOR UPDATE",
    [p.workspaceId, id, p.credentialId, leaseToken, fence],
  );
  if (!row)
    throw new AppError(409, 'LEASE_FENCED', 'This delivery lease expired or was superseded.');
  return row;
}
