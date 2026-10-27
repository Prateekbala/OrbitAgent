import type { Sql } from '@ao/database';
import type { Project, Milestone } from '@ao/contracts';
import { requireConversation, type Identity } from '../lib/policy.js';
import { notFound } from '../lib/errors.js';
export const projectAccess = `p.workspace_id=$1 AND (p.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=p.workspace_id AND c.id=p.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2))))`;
export const projectColumns = `p.id,p.name,p.description,p.status,p.conversation_id,p.owner_id,owner.name owner_name,p.created_by,p.version,to_char(p.start_date,'YYYY-MM-DD') start_date,to_char(p.target_date,'YYYY-MM-DD') target_date,p.created_at,p.updated_at,
 (SELECT count(*)::int FROM tasks t WHERE t.workspace_id=p.workspace_id AND t.project_id=p.id) task_count,
 (SELECT count(*)::int FROM tasks t WHERE t.workspace_id=p.workspace_id AND t.project_id=p.id AND t.state='completed') completed_count,
 (SELECT count(*)::int FROM tasks t WHERE t.workspace_id=p.workspace_id AND t.project_id=p.id AND t.state='cancelled') cancelled_count,
 (SELECT count(*)::int FROM tasks t WHERE t.workspace_id=p.workspace_id AND t.project_id=p.id AND t.due_date<(now() AT TIME ZONE 'UTC')::date AND t.state NOT IN ('completed','cancelled')) overdue_count`;
export const projectFrom =
  'FROM projects p JOIN memberships owner ON owner.workspace_id=p.workspace_id AND owner.id=p.owner_id';
export function managesProject(p: Identity, project: Pick<Project, 'owner_id' | 'created_by'>) {
  return (
    p.kind === 'human' &&
    (p.membershipId === project.owner_id ||
      p.membershipId === project.created_by ||
      ['owner', 'admin'].includes(p.role))
  );
}
export async function getProject(tx: Sql, p: Identity, id: string, lock = false): Promise<Project> {
  if (lock) {
    const [source] = await tx.query(
      'SELECT conversation_id FROM projects WHERE workspace_id=$1 AND id=$2',
      [p.workspaceId, id],
    );
    if (!source) throw notFound();
    if (source.conversation_id)
      await requireConversation(tx, p, String(source.conversation_id), true);
  }
  const [row] = await tx.query<Project & Record<string, unknown>>(
    `SELECT ${projectColumns} ${projectFrom} WHERE ${projectAccess} AND p.id=$3${lock ? ' FOR UPDATE OF p' : ''}`,
    [p.workspaceId, p.membershipId, id],
  );
  if (!row) throw notFound();
  return row;
}
export const milestoneColumns = `m.id,m.project_id,m.title,m.description,m.status,to_char(m.due_date,'YYYY-MM-DD') due_date,m.version,
 (SELECT count(*)::int FROM tasks t WHERE t.workspace_id=m.workspace_id AND t.milestone_id=m.id) task_count,
 (SELECT count(*)::int FROM tasks t WHERE t.workspace_id=m.workspace_id AND t.milestone_id=m.id AND t.state='completed') completed_count,
 (SELECT count(*)::int FROM tasks t WHERE t.workspace_id=m.workspace_id AND t.milestone_id=m.id AND t.state='cancelled') cancelled_count`;
export async function getMilestone(tx: Sql, ws: string, project: string, id: string, lock = false) {
  const [row] = await tx.query<Milestone & Record<string, unknown>>(
    `SELECT ${milestoneColumns} FROM project_milestones m WHERE m.workspace_id=$1 AND m.project_id=$2 AND m.id=$3${lock ? ' FOR UPDATE OF m' : ''}`,
    [ws, project, id],
  );
  if (!row) throw notFound();
  return row;
}
