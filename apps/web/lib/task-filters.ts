import { localTaskDate } from './task-display';
export type TaskFilters = {
  q: string;
  state: string;
  assigneeId: string;
  conversationId: string;
  overdue: boolean;
  roots: boolean;
  sort: string;
  projectId?: string;
  projectName?: string;
  milestoneId?: string;
  milestoneTitle?: string;
  labelId?: string;
  labelName?: string;
};
export function taskFilterParams(filters: TaskFilters) {
  const params = new URLSearchParams({ q: filters.q, sort: filters.sort, asOf: localTaskDate() });
  if (filters.state) params.set('state', filters.state);
  if (filters.assigneeId === 'unassigned') params.set('unassigned', 'true');
  else if (filters.assigneeId) params.set('assigneeId', filters.assigneeId);
  if (filters.conversationId === 'workspace') params.set('workspaceOnly', 'true');
  else if (filters.conversationId) params.set('conversationId', filters.conversationId);
  if (filters.overdue) params.set('overdue', 'true');
  if (filters.roots) params.set('roots', 'true');
  if (filters.projectId) params.set('projectId', filters.projectId);
  if (filters.milestoneId) params.set('milestoneId', filters.milestoneId);
  if (filters.labelId) params.set('labelId', filters.labelId);
  return params;
}
