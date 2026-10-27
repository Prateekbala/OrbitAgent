import type { Sql } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { getProject, getMilestone } from './queries.js';
export async function validatePlacement(
  tx: Sql,
  p: Identity,
  projectId: string | null,
  milestoneId: string | null,
  conversation: string | null,
) {
  if (!projectId) {
    if (milestoneId)
      throw new AppError(
        409,
        'PROJECT_SCOPE_MISMATCH',
        'Choose a project before assigning a milestone.',
      );
    return;
  }
  const project = await getProject(tx, p, projectId, true);
  if (project.conversation_id !== conversation)
    throw new AppError(
      409,
      'PROJECT_SCOPE_MISMATCH',
      'The project and task must have the same audience.',
    );
  if (['completed', 'archived'].includes(project.status))
    throw new AppError(409, 'PROJECT_CLOSED', 'Reopen the project before assigning new work.');
  if (milestoneId) {
    const milestone = await getMilestone(tx, p.workspaceId, projectId, milestoneId, true);
    if (['completed', 'cancelled'].includes(milestone.status))
      throw new AppError(
        409,
        'MILESTONE_CLOSED',
        'Reopen the milestone before assigning new work.',
      );
  }
}
export async function setTaskLabels(tx: Sql, p: Identity, id: string, labels: string[]) {
  const old = await tx.query<{ label_id: string } & Record<string, unknown>>(
    'SELECT label_id FROM task_label_links WHERE workspace_id=$1 AND task_id=$2',
    [p.workspaceId, id],
  );
  const prior = new Set(old.map((row) => row.label_id));
  for (const label of labels) {
    const [found] = await tx.query(
      'SELECT archived FROM work_labels WHERE workspace_id=$1 AND id=$2 FOR SHARE',
      [p.workspaceId, label],
    );
    if (!found) throw new AppError(400, 'INVALID_LABEL', 'Choose labels from this workspace.');
    if (found.archived && !prior.has(label))
      throw new AppError(409, 'LABEL_ARCHIVED', 'An archived label cannot be assigned.');
  }
  await tx.query(
    'DELETE FROM task_label_links WHERE workspace_id=$1 AND task_id=$2 AND NOT(label_id=ANY($3::uuid[]))',
    [p.workspaceId, id, labels],
  );
  for (const label of labels)
    if (!prior.has(label))
      await tx.query(
        'INSERT INTO task_label_links(workspace_id,task_id,label_id,assigned_by) VALUES($1,$2,$3,$4)',
        [p.workspaceId, id, label, p.membershipId],
      );
}
