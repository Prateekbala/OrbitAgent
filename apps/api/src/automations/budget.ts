import type { Sql } from '@ao/database';
import { AppError } from '../lib/errors.js';
export async function checkAutomationBudget(
  tx: Sql,
  workspace: string,
  runId: string,
  amount: number,
) {
  const [limit] = await tx.query(
    "SELECT (v.definition->>'maxDailySpendMicros')::bigint allowance,o.automation_id FROM agent_runs r JOIN automation_occurrences o ON o.workspace_id=r.workspace_id AND o.id=r.automation_occurrence_id JOIN automation_versions v ON v.workspace_id=o.workspace_id AND v.automation_id=o.automation_id AND v.revision=o.revision WHERE r.workspace_id=$1 AND r.id=$2",
    [workspace, runId],
  );
  if (!limit) return;
  const [usage] = await tx.query(
    "SELECT coalesce(sum(CASE e.state WHEN 'reserved' THEN e.amount_micros WHEN 'settled' THEN e.actual_micros ELSE 0 END),0)::text used FROM execution_reservations e JOIN agent_runs r ON r.workspace_id=e.workspace_id AND r.id=e.run_id JOIN automation_occurrences o ON o.workspace_id=r.workspace_id AND o.id=r.automation_occurrence_id WHERE e.workspace_id=$1 AND o.automation_id=$2 AND r.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    [workspace, limit.automation_id],
  );
  if (BigInt(String(usage?.used ?? 0)) + BigInt(amount) > BigInt(String(limit.allowance ?? 0)))
    throw new AppError(
      429,
      'AUTOMATION_SPENDING_LIMIT',
      'This automation has spent or reserved its daily allowance.',
    );
}
