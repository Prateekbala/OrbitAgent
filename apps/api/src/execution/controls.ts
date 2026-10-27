import { checkAutomationBudget } from '../automations/budget.js';
import type { Sql } from '@ao/database';
import { agentConfiguration, type AgentConfiguration } from '@ao/contracts/agents';
import { AppError } from '../lib/errors.js';
import type { HostedRuntime, RunRow, RuntimeUsage } from './types.js';

export async function executionPolicy(tx: Sql, workspace: string) {
  await tx.query('INSERT INTO execution_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [
    workspace,
  ]);
  const [policy] = await tx.query('SELECT * FROM execution_policies WHERE workspace_id=$1', [
    workspace,
  ]);
  return policy!;
}
export function runConfiguration(run: RunRow): AgentConfiguration {
  return agentConfiguration.parse(run.configuration ?? { instructions: run.instructions });
}
export function qualifyConfiguration(runtime: HostedRuntime, configuration: AgentConfiguration) {
  const minimum = runtime.requiredReservation?.(configuration) ?? 0;
  if (configuration.limits.reservationMicros < minimum)
    throw new AppError(
      409,
      'INSUFFICIENT_RESERVATION',
      'The spending reservation must cover the configured token bounds at operator-approved model rates.',
    );
  const capabilities = runtime.capabilities;
  if (
    configuration.model !== 'operator_default' &&
    !capabilities?.models?.includes(configuration.model)
  )
    throw new AppError(
      409,
      'MODEL_NOT_QUALIFIED',
      'The configured model is not supported by this runtime.',
    );
  if (configuration.limits.maxSeconds > Number(capabilities?.maxSeconds ?? 300))
    throw new AppError(
      409,
      'DURATION_NOT_QUALIFIED',
      'This runtime is not qualified for the requested execution duration.',
    );
}
export async function reserveSpending(
  tx: Sql,
  workspace: string,
  run: string,
  amount: number,
  policy: Record<string, unknown>,
) {
  await checkAutomationBudget(tx, workspace, run, amount);
  const [usage] = await tx.query(
    'SELECT (reserved_micros+spent_micros)::text used FROM execution_totals($1)',
    [workspace],
  );
  if (BigInt(String(usage?.used ?? 0)) + BigInt(amount) > BigInt(String(policy.budget_micros)))
    throw new AppError(
      429,
      'SPENDING_LIMIT',
      'The workspace budget is fully spent or reserved. Reconcile outstanding runs or raise the budget.',
    );
  await tx.query(
    'INSERT INTO execution_reservations(workspace_id,run_id,amount_micros) VALUES($1,$2,$3)',
    [workspace, run, amount],
  );
  const [row] = await tx.query(
    'SELECT configuration FROM agent_runs WHERE workspace_id=$1 AND id=$2',
    [workspace, run],
  );
  const limits = agentConfiguration.parse(
    row?.configuration ?? { instructions: 'Hosted agent' },
  ).limits;
  await tx.query("SELECT commercial_reserve($1,'models',$2,$3,$4)", [
    workspace,
    run,
    limits.maxInputTokens + limits.maxOutputTokens,
    amount,
  ]);
  await tx.query("SELECT commercial_reserve($1,'runtime',$2,$3,0)", [
    workspace,
    run,
    limits.maxSeconds,
  ]);
}
export async function settleSpending(tx: Sql, run: RunRow, usage?: RuntimeUsage) {
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [run.workspace_id]);
  const [reservation] = await tx.query(
    "SELECT amount_micros FROM execution_reservations WHERE workspace_id=$1 AND run_id=$2 AND state='reserved' FOR UPDATE",
    [run.workspace_id, run.id],
  );
  if (!reservation) return;
  const actual = usage?.costMicros ?? Number(reservation.amount_micros);
  if (!Number.isSafeInteger(actual) || actual < 0)
    throw new AppError(502, 'INVALID_USAGE', 'The runtime returned invalid usage.');
  await tx.query(
    "UPDATE execution_reservations SET state='settled',actual_micros=$3,input_tokens=$4,output_tokens=$5,receipt=$6,settled_at=now() WHERE workspace_id=$1 AND run_id=$2 AND state='reserved'",
    [
      run.workspace_id,
      run.id,
      actual,
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.costMicros === null || !usage ? 'conservative_reservation' : 'runtime_usage',
    ],
  );
  const configuration = runConfiguration(run);
  await tx.query("SELECT commercial_settle($1,'models',$2,$3,$4,$5)", [
    run.workspace_id,
    run.id,
    usage
      ? usage.inputTokens + usage.outputTokens
      : configuration.limits.maxInputTokens + configuration.limits.maxOutputTokens,
    actual,
    usage?.costMicros !== null && usage ? 'runtime_receipt' : 'conservative_reservation',
  ]);
  await tx.query("SELECT commercial_settle($1,'runtime',$2,$3,0,'conservative_runtime_limit')", [
    run.workspace_id,
    run.id,
    configuration.limits.maxSeconds,
  ]);
}
export async function checkpoint(
  tx: Sql,
  run: RunRow,
  kind: string,
  summary: string,
  payload: Record<string, unknown> = {},
) {
  await tx.query('SELECT id FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
    run.workspace_id,
    run.id,
  ]);
  await tx.query(
    'INSERT INTO run_checkpoints(workspace_id,run_id,ordinal,kind,summary,payload) SELECT $1,$2,coalesce(max(ordinal),0)+1,$3,$4,$5 FROM run_checkpoints WHERE workspace_id=$1 AND run_id=$2',
    [run.workspace_id, run.id, kind, summary, JSON.stringify(payload)],
  );
}
export async function publicTrace(
  tx: Sql,
  run: RunRow,
  kind: string,
  summary: string,
  resource: string | null = null,
) {
  await tx.query(
    'INSERT INTO run_traces(workspace_id,run_id,kind,summary,resource_id) VALUES($1,$2,$3,$4,$5)',
    [run.workspace_id, run.id, kind, summary.slice(0, 2000), resource],
  );
}
