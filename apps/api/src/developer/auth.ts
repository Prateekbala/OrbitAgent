import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  identityScope,
  identifyWorkspace,
  identifyPrincipal,
  identifyPlatformCredential,
  type Database,
  type Sql,
} from '@ao/database';
import type { FastifyRequest } from 'fastify';
import type { PublicGrant } from '@ao/contracts/developer';
import { publicScopes } from '@ao/contracts/developer';
import type { Identity } from '../lib/policy.js';
import { requireConversation } from '../lib/policy.js';
import { digest } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
import { hasPermission } from '../identity/authorization.js';
import { internalOperation } from './operations.js';
import { workAuthority } from '../workflows/service.js';
export const platformInvocation = new AsyncLocalStorage<{ audience: 'mcp'; resource: string }>();
const platformToken = () => 'orb_' + randomBytes(32).toString('base64url');
export function browserDeveloper(p: Identity) {
  if (p.kind !== 'human' || p.accessType !== 'member' || p.credentialId || p.platformCredentialId)
    throw new AppError(
      403,
      'HUMAN_REQUIRED',
      'Use your verified workspace browser session to manage developer access.',
    );
}
function requiredPermissions(scope: string): string[] {
  if (scope === 'events.read') return ['messages.read'];
  if (scope.startsWith('automations.'))
    return [scope.endsWith('.write') ? 'execution.manage' : 'execution.read'];
  if (scope === 'search.read')
    return ['messages.read', 'tasks.read', 'knowledge.read', 'files.read', 'projects.read'];
  return [scope];
}
export async function validatePublicGrant(tx: Sql, p: Identity, grant: PublicGrant) {
  browserDeveloper(p);
  for (const scope of grant.scopes)
    for (const permission of requiredPermissions(scope)) {
      if (!hasPermission(p, permission as Parameters<typeof hasPermission>[1]))
        throw new AppError(
          403,
          'SCOPE_DENIED',
          'You cannot grant a permission you do not currently hold.',
        );
    }
  for (const id of grant.conversationIds) await requireConversation(tx, p, id, true);
}
export async function issueCredential(
  tx: Sql,
  p: Identity,
  input: {
    name: string;
    grants: PublicGrant;
    expires: Date;
    audiences: string[];
    kind?: 'api_key' | 'oauth';
    clientId?: string;
    familyId?: string;
    resource?: string;
    rotatedFrom?: string;
  },
) {
  const token = platformToken(),
    id = randomUUID(),
    authority = await workAuthority(tx, p);
  await tx.query(
    'INSERT INTO platform_credentials(id,workspace_id,owner_id,name,token_hash,kind,scopes,conversation_ids,workspace_resources,audiences,auth_version,policy_version,expires_at,client_id,family_id,resource,rotated_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
    [
      id,
      p.workspaceId,
      p.membershipId,
      input.name,
      digest(token),
      input.kind ?? 'api_key',
      input.grants.scopes,
      input.grants.conversationIds,
      input.grants.workspaceResources,
      input.audiences,
      authority.auth,
      authority.policy,
      input.expires,
      input.clientId ?? null,
      input.familyId ?? null,
      input.resource ?? null,
      input.rotatedFrom ?? null,
    ],
  );
  return { id, token, expires_at: input.expires.toISOString() };
}
export async function authenticatePlatform(
  db: Database,
  request: FastifyRequest,
  audience: 'rest' | 'mcp' = platformInvocation.getStore()?.audience ?? 'rest',
  resource: string | undefined = platformInvocation.getStore()?.resource,
  operationCheck = true,
): Promise<Identity> {
  const token = request.headers.authorization?.match(/^Bearer (orb_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!token)
    throw new AppError(401, 'INVALID_TOKEN', 'A valid platform bearer credential is required.');
  const [row] = await identityScope(() =>
    db.query(
      `SELECT c.id credential_id,c.workspace_id,c.owner_id,c.scopes,c.conversation_ids,c.workspace_resources,c.audiences,c.resource,c.kind,c.auth_version,c.policy_version,c.expires_at,m.name,m.role,m.permissions,m.account_id,m.access_type,m.status member_status,a.auth_version current_auth,a.email_verified_at,a.disabled_at,a.email,o.version current_policy,o.allowed_domains,om.status organization_status,dc.revoked_at client_revoked
    FROM platform_credentials c JOIN memberships m ON m.workspace_id=c.workspace_id AND m.id=c.owner_id JOIN accounts a ON a.id=m.account_id JOIN workspaces w ON w.id=m.workspace_id JOIN organizations o ON o.id=w.organization_id JOIN organization_members om ON om.organization_id=o.id AND om.account_id=a.id LEFT JOIN developer_clients dc ON dc.id=c.client_id WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND m.kind='human'`,
      [digest(token)],
    ),
  );
  if (
    !row ||
    row.member_status !== 'active' ||
    row.access_type !== 'member' ||
    row.organization_status !== 'active' ||
    !row.email_verified_at ||
    row.disabled_at ||
    row.client_revoked ||
    row.auth_version !== row.current_auth ||
    row.policy_version !== row.current_policy ||
    !(row.audiences as string[]).includes(audience) ||
    (row.kind === 'oauth' && resource && row.resource !== resource) ||
    ((row.allowed_domains as string[]).length &&
      !(row.allowed_domains as string[]).includes(String(row.email).split('@')[1]!))
  )
    throw new AppError(401, 'INVALID_TOKEN', 'This credential expired or its authority changed.');
  identifyWorkspace(String(row.workspace_id));
  identifyPrincipal(String(row.owner_id), 'member');
  identifyPlatformCredential(String(row.credential_id));
  const p: Identity = {
    workspaceId: String(row.workspace_id),
    membershipId: String(row.owner_id),
    accountId: String(row.account_id),
    name: String(row.name),
    role: row.role as Identity['role'],
    kind: 'human',
    accessType: 'member',
    permissions: row.permissions as NonNullable<Identity['permissions']>,
    platformCredentialId: String(row.credential_id),
    credentialScopes: row.scopes as string[],
    authVersion: Number(row.auth_version),
    policyVersion: Number(row.policy_version),
  };
  if (operationCheck) {
    const path = request.routeOptions.url ?? request.url.split('?')[0]!;
    const op =
      path === '/public/v1/events/stream' && request.method === 'GET'
        ? { scope: 'events.read' }
        : internalOperation(request.method, path);
    if (!op || !p.credentialScopes!.includes(op.scope))
      throw new AppError(
        403,
        'INSUFFICIENT_SCOPE',
        'This operation is outside the credential scopes.',
      );
    for (const permission of requiredPermissions(op.scope))
      if (!hasPermission(p, permission as Parameters<typeof hasPermission>[1]))
        throw new AppError(403, 'PERMISSION_DENIED', 'The owner no longer holds this permission.');
  }
  await identityScope(() =>
    db.query(
      "UPDATE platform_credentials SET last_used_at=clock_timestamp() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<clock_timestamp()-interval '1 minute')",
      [row.credential_id],
    ),
  );
  return p;
}
export function effectiveScopes(p: Identity) {
  return publicScopes.filter(
    (scope) =>
      p.credentialScopes?.includes(scope) &&
      requiredPermissions(scope).every((v) =>
        hasPermission(p, v as Parameters<typeof hasPermission>[1]),
      ),
  );
}
export async function credentialOwner(
  tx: Sql,
  workspace: string,
  member: string,
  expected: { auth: number; policy: number },
) {
  await tx.query('SET LOCAL ROLE ao_identity');
  await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [workspace]);
  const [r] = await tx.query(
    'SELECT m.*,a.auth_version,a.email_verified_at,a.disabled_at,a.email,o.version policy_version,o.allowed_domains,om.status organization_status FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN workspaces w ON w.id=m.workspace_id JOIN organizations o ON o.id=w.organization_id JOIN organization_members om ON om.organization_id=o.id AND om.account_id=a.id WHERE m.workspace_id=$1 AND m.id=$2 FOR SHARE OF a,m',
    [workspace, member],
  );
  if (
    !r ||
    r.kind !== 'human' ||
    r.access_type !== 'member' ||
    r.status !== 'active' ||
    r.organization_status !== 'active' ||
    !r.email_verified_at ||
    r.disabled_at ||
    Number(r.auth_version) !== expected.auth ||
    Number(r.policy_version) !== expected.policy ||
    ((r.allowed_domains as string[]).length &&
      !(r.allowed_domains as string[]).includes(String(r.email).split('@')[1]!))
  )
    throw new AppError(401, 'INVALID_GRANT', 'The consent owner authority changed.');
  await tx.query('SET LOCAL ROLE ao_worker');
  await tx.query(
    "SELECT set_config('ao.workspace_id',$1,true),set_config('ao.membership_id',$2,true),set_config('ao.access_type','member',true)",
    [workspace, member],
  );
  return {
    workspaceId: workspace,
    membershipId: member,
    name: String(r.name),
    role: r.role as Identity['role'],
    kind: 'human',
    accessType: 'member',
    accountId: String(r.account_id),
    authVersion: Number(r.auth_version),
    policyVersion: Number(r.policy_version),
    permissions: r.permissions as NonNullable<Identity['permissions']>,
  } satisfies Identity;
}
