import type { Sql } from '@ao/database';
import type { Task } from '@ao/contracts';
import { notFound } from '../lib/errors.js';
import { requireConversation, type Identity } from '../lib/policy.js';
export const taskColumns = `t.id,to_char(t.start_date,'YYYY-MM-DD') start_date,t.estimate::float8 estimate,EXISTS(SELECT 1 FROM task_participants tp WHERE tp.workspace_id=t.workspace_id AND tp.task_id=t.id AND tp.membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid AND tp.role='collaborator') is_collaborator,t.project_id,t.milestone_id,project.name project_name,milestone.title milestone_title,t.title,t.description,t.state,t.priority,t.assignee_id,t.created_by,t.parent_id,t.conversation_id,to_char(t.due_date,'YYYY-MM-DD') due_date,t.version,t.created_at,t.updated_at,a.name assignee_name,creator.name creator_name,
 (SELECT count(*)::int FROM tasks child WHERE child.workspace_id=t.workspace_id AND child.parent_id=t.id) subtask_count,
 (SELECT count(*)::int FROM tasks child WHERE child.workspace_id=t.workspace_id AND child.parent_id=t.id AND child.state IN ('completed','cancelled')) closed_subtask_count,
 (SELECT count(*)::int FROM task_dependencies d WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id) dependency_count,
 (SELECT count(*)::int FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.workspace_id=d.workspace_id AND prerequisite.id=d.depends_on_id WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND prerequisite.state<>'completed') unresolved_dependency_count,
 (SELECT count(*)::int FROM task_comments comment WHERE comment.workspace_id=t.workspace_id AND comment.task_id=t.id) comment_count,
 (SELECT count(*)::int FROM task_attachments attachment WHERE attachment.workspace_id=t.workspace_id AND attachment.task_id=t.id AND attachment.removed_at IS NULL) attachment_count,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',label.id,'name',label.name,'color',label.color,'archived',label.archived) ORDER BY lower(label.name),label.id) FROM task_label_links link JOIN work_labels label ON label.workspace_id=link.workspace_id AND label.id=link.label_id WHERE link.workspace_id=t.workspace_id AND link.task_id=t.id),'[]'::jsonb) labels`;
export const taskFrom = `FROM tasks t LEFT JOIN projects project ON project.workspace_id=t.workspace_id AND project.id=t.project_id LEFT JOIN project_milestones milestone ON milestone.workspace_id=t.workspace_id AND milestone.id=t.milestone_id LEFT JOIN memberships a ON a.workspace_id=t.workspace_id AND a.id=t.assignee_id LEFT JOIN memberships creator ON creator.workspace_id=t.workspace_id AND creator.id=t.created_by`;
export const taskAccess = `t.workspace_id=$1 AND (t.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=t.workspace_id AND c.id=t.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2))))`;
export function managesTask(
  p: Identity,
  task: Pick<Task, 'assignee_id' | 'created_by'> & { is_collaborator?: boolean },
) {
  return (
    task.is_collaborator === true ||
    task.assignee_id === p.membershipId ||
    task.created_by === p.membershipId ||
    (p.kind === 'human' && ['owner', 'admin'].includes(p.role))
  );
}
export async function getTask(tx: Sql, p: Identity, id: string, lock = false): Promise<Task> {
  if (lock) {
    const [reference] = await tx.query(
      'SELECT conversation_id FROM tasks WHERE workspace_id=$1 AND id=$2',
      [p.workspaceId, id],
    );
    if (!reference) throw notFound();
    if (reference.conversation_id)
      await requireConversation(tx, p, String(reference.conversation_id), true);
  }
  const [row] = await tx.query<Task & Record<string, unknown>>(
    `SELECT ${taskColumns} ${taskFrom} WHERE ${taskAccess} AND t.id=$3${lock ? ' FOR UPDATE OF t' : ''}`,
    [p.workspaceId, p.membershipId, id],
  );
  if (!row) throw notFound();
  return row;
}
