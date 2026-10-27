import type { Sql } from '@ao/database';
import { AppError } from '../lib/errors.js';
export async function requireGovernedExport(tx: Sql, workspaceId: string) {
  const [row] = await tx.query(
    "SELECT coalesce((governance_policy($1)->>'exports')::boolean,true) allowed",
    [workspaceId],
  );
  if (!row?.allowed)
    throw new AppError(403, 'EXPORT_DISABLED', 'Organization policy disables content exports.');
}
