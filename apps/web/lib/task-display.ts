import type { Task } from '@ao/contracts';
export function localTaskDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function overdueTask(task: Task) {
  return Boolean(
    task.due_date &&
    task.due_date < localTaskDate() &&
    !['completed', 'cancelled'].includes(task.state),
  );
}
export function dueLabel(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
