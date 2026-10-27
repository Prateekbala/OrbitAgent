import type { Sql } from '@ao/database';
import { AppError } from '../lib/errors.js';
export async function requireOrganizationEntitlement(
  tx: Sql,
  organization: string,
  feature: 'sso' | 'scim',
) {
  const [row] = await tx.query(
    "SELECT a.mode,p.features FROM billing_accounts a JOIN billing_plans p ON p.id=CASE WHEN a.status='trialing' AND a.trial_ends_at>now() THEN 'team' WHEN a.status='active' THEN a.plan_id ELSE 'free' END AND p.revision=1 WHERE a.organization_id=$1 FOR SHARE OF a",
    [organization],
  );
  if (!row || (row.mode !== 'self_hosted' && !(row.features as Record<string, boolean>)[feature]))
    throw new AppError(
      403,
      'ENTITLEMENT_REQUIRED',
      'The current plan does not include this organization capability.',
    );
}
