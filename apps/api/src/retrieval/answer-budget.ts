import { workerScope, type Database } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
export interface AnswerLimits {
  workspaceDaily: number;
  memberDaily: number;
  concurrency: number;
}
export const defaultAnswerLimits: AnswerLimits = {
  workspaceDaily: 100,
  memberDaily: 40,
  concurrency: 2,
};
export async function reserveAnswer(
  db: Database,
  p: Identity,
  model: string,
  inputBytes: number,
  limits: AnswerLimits,
) {
  return workerScope(p.workspaceId, () =>
    db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const [usage] = await tx.query(
        "SELECT count(*)::integer total,count(*) FILTER(WHERE member_id=$2)::integer member,count(*) FILTER(WHERE state='reserved' AND lease_until>now())::integer active FROM retrieval_answer_attempts WHERE workspace_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
        [p.workspaceId, p.membershipId],
      );
      if (
        Number(usage!.total) >= limits.workspaceDaily ||
        Number(usage!.member) >= limits.memberDaily ||
        Number(usage!.active) >= limits.concurrency
      )
        throw new AppError(
          429,
          'ANSWER_USAGE_LIMIT',
          'The workspace or member answer allowance is exhausted, or another answer is still running.',
        );
      const [row] = await tx.query(
        'INSERT INTO retrieval_answer_attempts(workspace_id,member_id,model,input_bytes) VALUES($1,$2,$3,$4) RETURNING id',
        [p.workspaceId, p.membershipId, model, inputBytes],
      );
      return String(row!.id);
    }),
  );
}
