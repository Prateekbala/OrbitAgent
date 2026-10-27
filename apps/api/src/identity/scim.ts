import { randomUUID } from 'node:crypto';
import type { Sql } from '@ao/database';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors.js';
import { organizationAudit } from './organizations.js';
import { offboardWorkspace } from './offboarding.js';
export const scimUserSchema = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const scimGroupSchema = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const workspaceExtension = 'urn:orbit:params:scim:schemas:extension:workspace:2.0:Group';
export const scimUserInput = z
  .object({
    schemas: z.array(z.string()).optional(),
    userName: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    externalId: z.string().min(1).max(500).optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    name: z
      .object({
        formatted: z.string().max(80).optional(),
        givenName: z.string().max(80).optional(),
        familyName: z.string().max(80).optional(),
      })
      .optional(),
    active: z.boolean().default(true),
    emails: z
      .array(
        z.object({
          value: z.email(),
          primary: z.boolean().optional(),
          type: z.string().optional(),
        }),
      )
      .max(10)
      .optional(),
  })
  .passthrough();
export const scimGroupInput = z
  .object({
    schemas: z.array(z.string()).optional(),
    displayName: z.string().trim().min(1).max(80),
    externalId: z.string().min(1).max(500).optional(),
    members: z
      .array(
        z.object({ value: z.uuid(), display: z.string().optional(), $ref: z.string().optional() }),
      )
      .max(500)
      .default([]),
    [workspaceExtension]: z.object({ workspaceId: z.uuid().nullable() }).optional(),
  })
  .passthrough();
export const scimPatch = z
  .object({
    schemas: z
      .array(z.string())
      .refine(
        (v) => v.includes('urn:ietf:params:scim:api:messages:2.0:PatchOp'),
        'A SCIM PatchOp schema is required.',
      ),
    Operations: z
      .array(
        z
          .object({
            op: z
              .string()
              .transform((v) => v.toLowerCase())
              .pipe(z.enum(['add', 'remove', 'replace'])),
            path: z.string().max(500).optional(),
            value: z.unknown().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const scimQuery = z
  .object({
    startIndex: z.coerce.number().int().min(1).default(1),
    count: z.coerce.number().int().min(0).max(200).default(100),
    filter: z.string().max(1000).optional(),
    attributes: z.string().max(1000).optional(),
    excludedAttributes: z.string().max(1000).optional(),
  })
  .strict();
export function scimFilter(filter: string | undefined, kind: 'User' | 'Group') {
  if (!filter) return null;
  const match = filter.match(
    /^\s*(userName|externalId|id|displayName)\s+eq\s+("(?:[^"\\]|\\.)*")\s*$/i,
  );
  if (!match)
    throw new AppError(
      400,
      'invalidFilter',
      'Only equality filters on userName, externalId, id, and displayName are supported.',
    );
  const attr = match[1]!.toLowerCase(),
    value = JSON.parse(match[2]!) as string;
  if (kind === 'Group' && attr === 'username')
    throw new AppError(400, 'invalidFilter', 'Groups do not have userName.');
  return { attr, value };
}
export function userResource(row: Record<string, unknown>, base: string) {
  return {
    schemas: [scimUserSchema],
    id: row.account_id,
    userName: row.email,
    externalId: row.external_id ?? undefined,
    displayName: row.display_name ?? row.name,
    active: row.status === 'active',
    emails: [{ value: row.email, primary: true, type: 'work' }],
    meta: {
      resourceType: 'User',
      created: row.created_at,
      location: `${base}/Users/${row.account_id}`,
      version: `W/"${row.version}"`,
    },
  };
}
export async function getScimUser(tx: Sql, org: string, id: string) {
  const [row] = await tx.query(
    'SELECT m.*,a.email,a.name FROM organization_members m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=$1 AND m.account_id=$2 AND m.scim_deleted_at IS NULL',
    [org, id],
  );
  if (!row) throw notFound();
  return row;
}
export async function writeScimUser(
  tx: Sql,
  org: string,
  accountId: string,
  input: z.infer<typeof scimUserInput>,
  existing: Record<string, unknown>,
) {
  if (existing.email !== input.userName)
    throw new AppError(
      400,
      'mutability',
      'Use the account’s verified email-change flow to change userName.',
    );
  if (existing.role === 'owner' && !input.active)
    throw new AppError(
      409,
      'OWNERSHIP_TRANSFER_REQUIRED',
      'Transfer organization ownership before deprovisioning an owner.',
    );
  const displayName =
    input.displayName ??
    input.name?.formatted ??
    ([input.name?.givenName, input.name?.familyName].filter(Boolean).join(' ') ||
      String(existing.display_name ?? existing.name));
  if (!input.active && existing.status === 'active') await deprovisionScimUser(tx, org, accountId);
  await tx.query(
    'UPDATE organization_members SET display_name=$3,external_id=$4,status=$5,provisioned=true,version=version+1 WHERE organization_id=$1 AND account_id=$2',
    [org, accountId, displayName, input.externalId ?? null, input.active ? 'active' : 'suspended'],
  );
  await organizationAudit(
    tx,
    org,
    null,
    input.active ? 'scim.user_updated' : 'scim.user_deprovisioned',
    accountId,
  );
}
async function retireScimMembership(tx: Sql, workspace: string, membership: string) {
  await tx.query('SET LOCAL ROLE ao_runtime');
  await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [workspace]);
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace]);
  const [custodian] = await tx.query(
    "SELECT id FROM memberships WHERE workspace_id=$1 AND id<>$2 AND kind='human' AND access_type='member' AND status='active' AND role='owner' ORDER BY id LIMIT 1",
    [workspace, membership],
  );
  if (!custodian)
    throw new AppError(
      409,
      'LAST_OWNER',
      'Transfer workspace ownership before deprovisioning its last owner.',
    );
  await tx.query(
    'UPDATE projects SET owner_id=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND owner_id=$2',
    [workspace, membership, custodian.id],
  );
  await offboardWorkspace(tx, String(workspace), String(membership));
  await tx.query('SET LOCAL ROLE ao_identity');
}
async function deprovisionScimUser(tx: Sql, org: string, account: string) {
  const memberships = await tx.query(
    "SELECT m.id,m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE w.organization_id=$1 AND m.account_id=$2 AND m.status='active' ORDER BY m.workspace_id",
    [org, account],
  );
  for (const member of memberships)
    await retireScimMembership(tx, String(member.workspace_id), String(member.id));
  await tx.query('DELETE FROM scim_group_members WHERE organization_id=$1 AND account_id=$2', [
    org,
    account,
  ]);
  await tx.query('DELETE FROM authentication_challenges WHERE account_id=$1', [account]);
  await tx.query('DELETE FROM federation_transactions WHERE account_id=$1', [account]);
  await tx.query(
    'DELETE FROM federated_identities WHERE account_id=$1 AND provider_id IN (SELECT id FROM identity_providers WHERE organization_id=$2)',
    [account, org],
  );
}
export async function groupResource(tx: Sql, row: Record<string, unknown>, base: string) {
  const members = await tx.query(
    'SELECT account_id FROM scim_group_members WHERE organization_id=$1 AND group_id=$2 ORDER BY account_id',
    [row.organization_id, row.id],
  );
  return {
    schemas: [scimGroupSchema, workspaceExtension],
    id: row.id,
    externalId: row.external_id ?? undefined,
    displayName: row.display_name,
    members: members.map((m) => ({ value: m.account_id, $ref: `${base}/Users/${m.account_id}` })),
    [workspaceExtension]: { workspaceId: row.workspace_id },
    meta: {
      resourceType: 'Group',
      created: row.created_at,
      location: `${base}/Groups/${row.id}`,
      version: `W/"${row.version}"`,
    },
  };
}
export async function writeScimGroup(
  tx: Sql,
  org: string,
  group: string,
  input: z.infer<typeof scimGroupInput>,
) {
  const [current] = await tx.query(
    'SELECT workspace_id FROM scim_groups WHERE organization_id=$1 AND id=$2 FOR UPDATE',
    [org, group],
  );
  if (!current) throw notFound();
  const workspace = input[workspaceExtension]?.workspaceId ?? null;
  if (workspace) {
    const [row] = await tx.query('SELECT id FROM workspaces WHERE id=$1 AND organization_id=$2', [
      workspace,
      org,
    ]);
    if (!row)
      throw new AppError(400, 'invalidValue', 'The workspace must belong to this organization.');
  }
  const previous = await tx.query(
    'SELECT account_id FROM scim_group_members WHERE organization_id=$1 AND group_id=$2',
    [org, group],
  );
  const ids = [...new Set(input.members.map((m) => m.value))];
  for (const account of ids) {
    const [valid] = await tx.query(
      "SELECT account_id FROM organization_members WHERE organization_id=$1 AND account_id=$2 AND status='active'",
      [org, account],
    );
    if (!valid)
      throw new AppError(
        400,
        'invalidValue',
        'Every group member must be an active user in this organization.',
      );
  }
  await tx.query('DELETE FROM scim_group_members WHERE organization_id=$1 AND group_id=$2', [
    org,
    group,
  ]);
  for (const account of ids)
    await tx.query(
      'INSERT INTO scim_group_members(organization_id,group_id,account_id) VALUES($1,$2,$3)',
      [org, group, account],
    );
  await tx.query(
    'UPDATE scim_groups SET display_name=$3,external_id=$4,workspace_id=$5,version=version+1 WHERE organization_id=$1 AND id=$2',
    [org, group, input.displayName, input.externalId ?? null, workspace],
  );
  if (workspace)
    for (const account of ids) {
      await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [workspace]);
      const [existing] = await tx.query(
        'SELECT id,status,provisioned FROM memberships WHERE workspace_id=$1 AND account_id=$2',
        [workspace, account],
      );
      if (!existing) {
        const [person] = await tx.query(
          'SELECT coalesce(m.display_name,a.name) name FROM accounts a JOIN organization_members m ON m.account_id=a.id WHERE a.id=$1 AND m.organization_id=$2',
          [account, org],
        );
        await tx.query(
          "INSERT INTO memberships(id,workspace_id,account_id,name,kind,role,provisioned) VALUES($1,$2,$3,$4,'human','member',true)",
          [randomUUID(), workspace, account, person!.name],
        );
      } else if (existing.provisioned && existing.status === 'suspended')
        await tx.query(
          "UPDATE memberships SET status='active',offboarded_at=NULL,version=version+1 WHERE id=$1",
          [existing.id],
        );
    }
  if (current.workspace_id)
    for (const account of previous.map((m) => String(m.account_id))) {
      if (current.workspace_id === workspace && ids.includes(account)) continue;
      const [other] = await tx.query(
        'SELECT g.id FROM scim_groups g JOIN scim_group_members m ON m.group_id=g.id AND m.organization_id=g.organization_id WHERE g.organization_id=$1 AND g.workspace_id=$2 AND m.account_id=$3 LIMIT 1',
        [org, current.workspace_id, account],
      );
      if (other) continue;
      const [member] = await tx.query(
        "SELECT id FROM memberships WHERE workspace_id=$1 AND account_id=$2 AND provisioned AND status='active'",
        [current.workspace_id, account],
      );
      if (member) {
        await retireScimMembership(tx, String(current.workspace_id), String(member.id));
      }
    }
  await organizationAudit(tx, org, null, 'scim.group_updated', group);
}
export function applyScimPatch(
  kind: 'User' | 'Group',
  resource: Record<string, unknown>,
  patch: z.infer<typeof scimPatch>,
) {
  const result = structuredClone(resource);
  for (const operation of patch.Operations) {
    const path = operation.path;
    if (!path) {
      if (
        operation.op === 'remove' ||
        typeof operation.value !== 'object' ||
        !operation.value ||
        Array.isArray(operation.value)
      )
        throw new AppError(400, 'invalidPath', 'A valid PATCH path or object value is required.');
      Object.assign(result, operation.value);
      continue;
    }
    const memberFilter = path.match(/^members\[value eq "([0-9a-f-]{36})"\]$/i);
    if (kind === 'Group' && memberFilter && operation.op === 'remove') {
      result.members = (result.members as Array<{ value: string }>).filter(
        (m) => m.value !== memberFilter[1],
      );
      continue;
    }
    if (kind === 'Group' && path.toLowerCase() === 'members') {
      if (operation.op === 'remove') result.members = [];
      else if (operation.op === 'replace') result.members = operation.value;
      else {
        const members = z.array(z.object({ value: z.uuid() }).passthrough()).parse(operation.value);
        result.members = [...(result.members as unknown[]), ...members];
      }
      continue;
    }
    const names =
      kind === 'User'
        ? ['userName', 'externalId', 'displayName', 'active', 'name']
        : ['externalId', 'displayName', workspaceExtension];
    const field = names.find((n) => n.toLowerCase() === path.toLowerCase());
    if (!field) throw new AppError(400, 'invalidPath', 'This PATCH attribute is not supported.');
    if (operation.op === 'remove') delete result[field];
    else result[field] = operation.value;
  }
  return result;
}
