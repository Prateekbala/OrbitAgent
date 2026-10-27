import type { Sql } from '@ao/database';
import type { AgentOutput } from '@ao/contracts';
import { automationDefinition } from '@ao/contracts/automations';
import type { RunRow } from '../execution/types.js';
import { digest } from '../lib/security.js';
import { inQuietHours } from './schedule.js';
export async function automationPublication(tx: Sql, run: RunRow, output: AgentOutput) {
  if (!run.automation_occurrence_id) return null;
  const [a] = await tx.query(
    'SELECT a.*,v.definition FROM automations a JOIN automation_occurrences o ON o.workspace_id=a.workspace_id AND o.automation_id=a.id JOIN automation_versions v ON v.workspace_id=o.workspace_id AND v.automation_id=o.automation_id AND v.revision=o.revision WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF a',
    [run.workspace_id, run.automation_occurrence_id],
  );
  if (!a) return null;
  const d = automationDefinition.parse(a.definition),
    now = new Date(),
    hash = digest(output.reply.trim().replace(/\s+/g, ' '));
  const [count] = await tx.query(
    "SELECT count(*)::int count FROM agent_runs r JOIN automation_occurrences o ON o.workspace_id=r.workspace_id AND o.id=r.automation_occurrence_id WHERE o.workspace_id=$1 AND o.automation_id=$2 AND r.published_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND r.result IS NOT NULL AND coalesce((r.result->>'suppressed')::boolean,false)=false",
    [run.workspace_id, a.id],
  );
  const reason = !d.participation.enabled
    ? 'participation_disabled'
    : inQuietHours(d, now)
      ? 'quiet_hours'
      : Number(count?.count) >= d.participation.maxPublicationsPerDay
        ? 'publication_limit'
        : d.participation.onlyMeaningfulChanges && a.last_result_hash === hash
          ? 'unchanged_result'
          : d.participation.onlyMeaningfulChanges && output.meaningfulChange === false
            ? 'no_meaningful_change'
            : a.last_publication_at != null &&
                now.getTime() - new Date(String(a.last_publication_at)).getTime() <
                  d.participation.cooldownMinutes * 60000
              ? 'cooldown'
              : null;
  const suppressed = reason;
  if (!suppressed)
    await tx.query(
      'UPDATE automations SET last_publication_at=clock_timestamp(),last_result_hash=$3 WHERE workspace_id=$1 AND id=$2',
      [run.workspace_id, a.id, hash],
    );
  return suppressed;
}
