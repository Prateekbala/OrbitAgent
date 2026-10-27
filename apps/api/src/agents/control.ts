import { randomUUID } from 'node:crypto';
import type { Sql } from '@ao/database';
import {
  agentConfiguration,
  credentialInput,
  credentialScopes,
  type AgentConfiguration,
} from '@ao/contracts/agents';
import { AppError, notFound } from '../lib/errors.js';
import { requireConversation, type Identity } from '../lib/policy.js';
import { recordChange } from '../lib/events.js';
import { digest, token } from '../lib/security.js';

export async function initializeAgent(
  tx: Sql,
  p: Identity,
  id: string,
  instructions: string,
  key: string | null,
) {
  await tx.query('INSERT INTO execution_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [
    p.workspaceId,
  ]);
  const configuration = agentConfiguration.parse({ instructions });
  await tx.query(
    'INSERT INTO agent_revisions(workspace_id,agent_id,revision,configuration,created_by) VALUES($1,$2,1,$3,$4)',
    [p.workspaceId, id, JSON.stringify(configuration), p.membershipId],
  );
  if (key)
    await insertCredential(
      tx,
      p,
      id,
      {
        name: 'Initial connection',
        scopes: [...credentialScopes],
        conversationIds: [],
        expiresInDays: 30,
      },
      key,
    );
}
export async function insertCredential(
  tx: Sql,
  p: Identity,
  agent: string,
  input: ReturnType<typeof credentialInput.parse>,
  key = token(),
) {
  const [agentIdentity] = await tx.query(
    'SELECT membership_id FROM agents WHERE workspace_id=$1 AND id=$2',
    [p.workspaceId, agent],
  );
  if (!agentIdentity) throw notFound();
  for (const conversation of input.conversationIds) {
    await requireConversation(tx, p, conversation);
    await requireConversation(
      tx,
      { ...p, membershipId: String(agentIdentity.membership_id), kind: 'agent', role: 'member' },
      conversation,
    );
  }
  const [count] = await tx.query(
    'SELECT count(*)::int count FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 AND revoked_at IS NULL AND expires_at>now()',
    [p.workspaceId, agent],
  );
  if (Number(count?.count) >= 20)
    throw new AppError(
      409,
      'CREDENTIAL_LIMIT',
      'Revoke an unused credential before creating another.',
    );
  const id = randomUUID();
  await tx.query(
    "INSERT INTO agent_credentials(id,workspace_id,agent_id,name,token_hash,scopes,conversation_ids,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 day',$9)",
    [
      id,
      p.workspaceId,
      agent,
      input.name,
      digest(key),
      input.scopes,
      input.conversationIds,
      input.expiresInDays,
      p.membershipId,
    ],
  );
  await recordChange(tx, p, 'agent.credential_created', agent, null, p.membershipId);
  return { id, key };
}
export async function fenceAgent(tx: Sql, workspace: string, id: string) {
  const runs = await tx.query(
    "SELECT id FROM agent_runs WHERE workspace_id=$1 AND agent_id=$2 AND status IN ('queued','running','awaiting_approval','outcome_unknown') ORDER BY id FOR UPDATE",
    [workspace, id],
  );
  for (const run of runs) {
    await tx.query(
      "UPDATE agent_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [workspace, run.id],
    );
    await tx.query(
      "UPDATE tool_invocations SET status='cancelled' WHERE workspace_id=$1 AND run_id=$2 AND status IN ('pending','approved')",
      [workspace, run.id],
    );
  }
  await tx.query(
    "UPDATE agent_inbox SET state=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,lease_token=NULL,lease_expires_at=NULL,credential_id=NULL,fence=fence+1 WHERE workspace_id=$1 AND agent_id=$2 AND state='leased'",
    [workspace, id],
  );
}
export async function currentAgent(tx: Sql, p: Identity, id: string, version?: number) {
  const [row] = await tx.query('SELECT * FROM agents WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
    p.workspaceId,
    id,
  ]);
  if (!row) throw notFound();
  if (version !== undefined && row.version !== version)
    throw new AppError(409, 'VERSION_CONFLICT', 'The agent changed. Refresh before saving.');
  return row;
}
export async function reviseAgent(
  tx: Sql,
  p: Identity,
  id: string,
  version: number,
  configuration: AgentConfiguration,
) {
  await fenceAgent(tx, p.workspaceId, id);
  const agent = await currentAgent(tx, p, id, version);
  if (agent.status === 'archived')
    throw new AppError(
      409,
      'AGENT_ARCHIVED',
      'Restore the agent before changing its configuration.',
    );
  for (const conversation of configuration.conversationIds)
    await requireConversation(tx, p, conversation);
  const revision = Number(agent.revision) + 1;
  await tx.query(
    'INSERT INTO agent_revisions(workspace_id,agent_id,revision,configuration,created_by) VALUES($1,$2,$3,$4,$5)',
    [p.workspaceId, id, revision, JSON.stringify(configuration), p.membershipId],
  );
  await tx.query(
    'UPDATE agents SET revision=$3,instructions=$4,version=version+1 WHERE workspace_id=$1 AND id=$2',
    [p.workspaceId, id, revision, configuration.instructions],
  );
  await recordChange(tx, p, 'agent.revised', id);
  return { revision };
}
