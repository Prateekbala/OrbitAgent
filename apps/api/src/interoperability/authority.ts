import type { Sql } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { lockAdministrator } from '../lib/policy.js';
import { hasPermission } from '../identity/authorization.js';
import { AppError, notFound } from '../lib/errors.js';
export async function importActor(tx: Sql, p: Identity) {
  if (p.platformCredentialId || p.credentialId || p.accessType !== 'member' || p.kind !== 'human')
    throw new AppError(403, 'HUMAN_REQUIRED', 'Use an administrator browser session.');
  await lockAdministrator(tx, p, 'workspace.manage');
  const [authority] = await tx.query('SELECT migration_owner_current($1,$2,$3,$4) valid', [
    p.workspaceId,
    p.membershipId,
    p.authVersion ?? 0,
    p.policyVersion ?? 0,
  ]);
  if (!authority?.valid)
    throw new AppError(
      403,
      'IMPORT_AUTHORITY_CHANGED',
      'Sign in and renew the source owner authorization.',
    );
  if (
    !['messages.read', 'messages.write', 'files.read'].every((v) =>
      hasPermission(p, v as 'messages.read'),
    )
  )
    throw new AppError(403, 'PERMISSION_DENIED', 'Imports require message and file access.');
}
export async function sourceFor(tx: Sql, p: Identity, id: string) {
  await importActor(tx, p);
  const [source] = await tx.query(
    'SELECT * FROM migration_sources WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [p.workspaceId, id],
  );
  if (!source) throw notFound();
  if (source.owner_id !== p.membershipId)
    throw new AppError(403, 'IMPORT_OWNER_REQUIRED', 'The source owner must perform this action.');
  return source;
}
