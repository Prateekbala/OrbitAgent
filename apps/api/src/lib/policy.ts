import type { Sql } from '@ao/database';
import { AppError, notFound } from './errors.js';
export interface Identity {
  workspaceId: string;
  membershipId: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  kind: 'human' | 'agent';
  accountId?: string;
  authVersion?: number;
  policyVersion?: number;
  platformCredentialId?: string;
  credentialId?: string;
  credentialScopes?: string[];
  accessType?: 'member' | 'guest' | 'service';
  permissions?: Partial<Record<import('@ao/contracts').Permission, boolean>>;
}
export async function requireConversation(db: Sql, identity: Identity, id: string, lock = false) {
  const rows = await db.query(
    `SELECT c.id FROM conversations c WHERE c.workspace_id=$1 AND c.id=$2 AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$3))${lock ? ' FOR SHARE OF c' : ''}`,
    [identity.workspaceId, id, identity.membershipId],
  );
  if (!rows.length) throw notFound();
  if (identity.kind === 'agent') {
    const [allowed] = await db.query('SELECT shared_agent_allowed($1,$2) allowed', [
      identity.workspaceId,
      id,
    ]);
    if (!allowed?.allowed)
      throw new AppError(
        403,
        'SHARED_AGENTS_DISABLED',
        'Participating organizations disabled agent access.',
      );
  }
}
export async function requireActiveMember(db: Sql, identity: Identity, membershipId: string) {
  const [member] = await db.query(
    "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",
    [identity.workspaceId, membershipId],
  );
  if (!member)
    throw new AppError(400, 'INVALID_REFERENCE', 'An active workspace member is required.');
}
export function requireAdmin(identity: Identity) {
  if (identity.kind !== 'human' || !['owner', 'admin'].includes(identity.role))
    throw new AppError(403, 'FORBIDDEN', 'An administrator must perform this action.');
}
export async function lockAdministrator(
  tx: Sql,
  actor: Identity,
  permission: import('@ao/contracts').Permission = 'people.manage',
) {
  requireAdmin(actor);
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [actor.workspaceId]);
  const [member] = await tx.query(
    "SELECT role,permissions FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND kind='human' AND access_type='member'",
    [actor.workspaceId, actor.membershipId],
  );
  if (!member || !['owner', 'admin'].includes(String(member.role)))
    throw new AppError(403, 'FORBIDDEN', 'A current administrator must perform this action.');
  if (permission && (member.permissions as Record<string, boolean>)[permission] === false)
    throw new AppError(403, 'PERMISSION_DENIED', 'This capability is disabled.');
  return String(member.role);
}
