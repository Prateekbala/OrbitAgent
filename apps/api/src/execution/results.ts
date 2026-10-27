import { automationPublication } from '../automations/publication.js';
import { randomUUID } from 'node:crypto';
import type { Sql } from '@ao/database';
import type { AgentOutput } from '@ao/contracts';
import { recordChange } from '../lib/events.js';
import { actionDigest } from './gateway.js';
import { runIdentities, requireRunContext } from './policy.js';
import type { RunRow } from './types.js';
import { checkpoint, publicTrace, runConfiguration } from './controls.js';
import { AppError } from '../lib/errors.js';
import { authorizeTool, effectiveRule } from '../tools/registry.js';
export async function publishRunResult(tx: Sql, run: RunRow, output: AgentOutput) {
  const configuration = runConfiguration(run);
  if (
    output.proposals.length > configuration.limits.maxTools ||
    output.proposals.some((p) => !configuration.tools.includes(p.tool))
  )
    throw new AppError(
      409,
      'TOOL_GRANT_DENIED',
      'The result exceeds the run’s tool grants or invocation limit.',
    );
  const { agent } = await runIdentities(tx, run);
  await requireRunContext(tx, run);
  const suppressionReason = await automationPublication(tx, run, output);
  let messageId: string | null = null;
  if (!suppressionReason) {
    const [conversation] = await tx.query(
      'UPDATE conversations SET next_sequence=next_sequence+1 WHERE workspace_id=$1 AND id=$2 RETURNING next_sequence',
      [run.workspace_id, run.conversation_id],
    );
    messageId = randomUUID();
    await tx.query(
      'INSERT INTO messages(id,workspace_id,conversation_id,author_id,body,client_id,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        messageId,
        run.workspace_id,
        run.conversation_id,
        agent.membershipId,
        output.reply,
        run.id,
        conversation!.next_sequence,
      ],
    );
    await recordChange(tx, agent, 'message.created', messageId, run.conversation_id);
  }
  for (const [ordinal, proposal] of output.proposals.entries()) {
    const actionId = randomUUID();
    const authorization = await authorizeTool(tx, run, proposal);
    const policy = await effectiveRule(tx, run.workspace_id, authorization.effect);
    await tx.query(
      `INSERT INTO tool_invocations(id,workspace_id,run_id,ordinal,tool_name,parameters,action_digest,policy_version,authorization_snapshot,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+$10::integer*interval '1 minute')`,
      [
        actionId,
        run.workspace_id,
        run.id,
        ordinal,
        proposal.tool,
        JSON.stringify(proposal.parameters),
        actionDigest(
          run.id,
          run.conversation_id,
          proposal,
          policy.version,
          authorization as unknown as Record<string, unknown>,
        ),
        policy.version,
        JSON.stringify(authorization),
        authorization.rule.expiresInMinutes,
      ],
    );
    await recordChange(tx, agent, 'approval.requested', actionId, run.conversation_id);
  }
  await tx.query(
    'UPDATE agent_runs SET status=$1,result=$2,lease_token=NULL,lease_expires_at=NULL,published_at=CASE WHEN $4::boolean THEN NULL ELSE clock_timestamp() END,updated_at=now() WHERE id=$3',
    [
      output.proposals.length ? 'awaiting_approval' : 'succeeded',
      JSON.stringify({
        reply: output.reply,
        proposalCount: output.proposals.length,
        suppressed: Boolean(suppressionReason),
        ...(suppressionReason ? { suppressionReason } : {}),
      }),
      run.id,
      Boolean(suppressionReason),
    ],
  );
  await recordChange(tx, agent, 'run.generated', run.id, run.conversation_id);
  await checkpoint(
    tx,
    run,
    'settled',
    suppressionReason
      ? 'The check completed under the automation publication policy.'
      : 'The validated result was published.',
    {
      messageId,
      proposalCount: output.proposals.length,
    },
  );
  await publicTrace(
    tx,
    run,
    'result',
    suppressionReason
      ? 'The check completed without a public message; proposals remain subject to approval.'
      : 'The agent published its result.',
    messageId ?? undefined,
  );
}
