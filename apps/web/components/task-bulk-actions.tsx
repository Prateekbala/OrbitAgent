'use client';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { useEffect, useRef, useState } from 'react';
import type { Member, Task, TaskBulkPreviewResult } from '@ao/contracts';
import { taskLabels, taskMoves } from '@ao/contracts/tasks';
import { post, HttpError } from '../lib/api';
import { TaskOrganizationFields, emptyOrganization } from './task-organization';
import { Dialog } from './dialog';
export function TaskBulkActions({
  selected,
  members,
  onClear,
  onReview,
  onChanged,
}: {
  selected: Task[];
  members: Member[];
  onClear: () => void;
  onReview: (items: Task[]) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<'assignee' | 'priority' | 'due' | 'state' | 'organization'>(
      'priority',
    ),
    [assignee, setAssignee] = useState(''),
    [priority, setPriority] = useState('normal'),
    [due, setDue] = useState(''),
    [state, setState] = useState('queued'),
    [proof, setProof] = useState<Record<string, string>>({}),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [organization, setOrganization] = useState(emptyOrganization);
  const sameAudience = selected.every((t) => t.conversation_id === selected[0]?.conversation_id);
  const alive = useRef(true),
    request = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const moves = Object.keys(taskLabels).filter((next) =>
    selected.every(
      (task) => task.state === next || taskMoves[task.state].includes(next as Task['state']),
    ),
  );
  async function latest() {
    if (busy) return;
    setBusy(true);
    setError('');
    setReviewed(false);
    try {
      const result = await post<TaskBulkPreviewResult>('/tasks/bulk/preview', {
        ids: selected.map((t) => t.id),
      });
      if (alive.current) onReview(result.items);
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to review tasks.');
        if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
          onClear();
          setOpen(false);
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function apply(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !reviewed || !selected.length) return;
    const targets = selected.map((task) => ({
      id: task.id,
      version: task.version,
      ...(kind === 'state' && state === 'completed' && task.state !== 'completed'
        ? { evidence: proof[task.id] ?? '' }
        : {}),
    }));
    const input =
      kind === 'state'
        ? { action: 'transition', targets, state }
        : {
            action: 'update',
            targets,
            patch:
              kind === 'assignee'
                ? { assigneeId: assignee || null }
                : kind === 'priority'
                  ? { priority }
                  : kind === 'organization'
                    ? {
                        projectId: organization.projectId || null,
                        milestoneId: organization.milestoneId || null,
                        labelIds: organization.labels.map((l) => l.id),
                      }
                    : { dueDate: due || null },
          };
    const signature = JSON.stringify(input);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      await post('/tasks/bulk', { ...input, clientId: request.current.id });
      if (alive.current) {
        setOpen(false);
        onClear();
        request.current = null;
        await onChanged();
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to apply bulk changes.');
        setReviewed(false);
        if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
          onClear();
          setOpen(false);
        }
        await onChanged();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!selected.length) return null;
  return (
    <>
      <div className="task-bulk-toolbar" role="region" aria-label="Selected task actions">
        <strong>{selected.length} selected</strong>
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setOpen(true);
            setReviewed(false);
            setError('');
          }}
        >
          Review bulk action
        </Button>
        <Button variant="outline" type="button" onClick={onClear}>
          Clear selection
        </Button>
      </div>
      {open && (
        <Dialog
          title="Review bulk task action"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <form className="task-bulk-form" onSubmit={(e) => void apply(e)}>
            <p>
              All {selected.length} tasks must pass permissions, version and workflow checks. If any
              check fails, none are changed.
            </p>
            <label>
              Bulk action
              <NativeSelect
                aria-label="Bulk action"
                value={kind}
                disabled={busy}
                onChange={(e) => {
                  setKind(e.target.value as typeof kind);
                  setReviewed(false);
                }}
              >
                <option value="priority">Set priority</option>
                <option value="assignee">Assign or unassign</option>
                <option value="due">Set or clear due date</option>
                <option value="state">Change state</option>
                <option value="organization" disabled={!sameAudience}>
                  Set project, milestone and labels
                </option>
              </NativeSelect>
            </label>
            {kind === 'organization' && (
              <>
                <p className="muted">
                  Replace the project, milestone and complete label set on every selected task. An
                  empty choice clears it. Tasks must share an audience.
                </p>
                <TaskOrganizationFields
                  source={selected[0]?.conversation_id ?? null}
                  value={organization}
                  disabled={busy || !sameAudience}
                  onChange={(value) => {
                    setOrganization(value);
                    setReviewed(false);
                  }}
                />
              </>
            )}
            {kind === 'priority' && (
              <label>
                Priority
                <NativeSelect
                  aria-label="Bulk priority"
                  disabled={busy}
                  value={priority}
                  onChange={(e) => {
                    setPriority(e.target.value);
                    setReviewed(false);
                  }}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </NativeSelect>
              </label>
            )}
            {kind === 'assignee' && (
              <label>
                Assignee
                <NativeSelect
                  aria-label="Bulk assignee"
                  disabled={busy}
                  value={assignee}
                  onChange={(e) => {
                    setAssignee(e.target.value);
                    setReviewed(false);
                  }}
                >
                  <option value="">Unassigned</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </NativeSelect>
                <small>Every private source must allow this assignee.</small>
              </label>
            )}
            {kind === 'due' && (
              <label>
                Due date (blank clears)
                <Input
                  aria-label="Bulk due date"
                  type="date"
                  min="0001-01-01"
                  max="9999-12-31"
                  disabled={busy}
                  value={due}
                  onChange={(e) => {
                    setDue(e.target.value);
                    setReviewed(false);
                  }}
                />
              </label>
            )}
            {kind === 'state' && (
              <label>
                Next state
                <NativeSelect
                  aria-label="Bulk next state"
                  disabled={busy}
                  value={moves.includes(state) ? state : ''}
                  required
                  onChange={(e) => {
                    setState(e.target.value);
                    setReviewed(false);
                  }}
                >
                  <option value="">Choose a permitted state</option>
                  {moves.map((next) => (
                    <option key={next} value={next}>
                      {taskLabels[next as Task['state']]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            <ol className="bulk-task-review">
              {selected.map((task) => (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  <small>
                    v{task.version} · {taskLabels[task.state]} ·{' '}
                    {task.assignee_name ?? 'Unassigned'} · {task.priority} ·{' '}
                    {task.due_date ?? 'No due date'}
                  </small>
                  {kind === 'state' && state === 'completed' && task.state !== 'completed' && (
                    <label>
                      Verification evidence for {task.title}
                      <Textarea
                        aria-label={`Bulk evidence for ${task.title}`}
                        required
                        maxLength={2000}
                        disabled={busy}
                        value={proof[task.id] ?? ''}
                        onChange={(e) => {
                          setProof({ ...proof, [task.id]: e.target.value });
                          setReviewed(false);
                        }}
                      />
                    </label>
                  )}
                </li>
              ))}
            </ol>
            <Button variant="outline" type="button" disabled={busy} onClick={() => void latest()}>
              Review current task versions
            </Button>
            <label className="checkbox-label">
              <Input
                aria-label="I reviewed the selected tasks and changes"
                type="checkbox"
                checked={reviewed}
                disabled={busy}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              I reviewed the selected tasks and changes
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button
              size="sm"
              className="primary small"
              disabled={
                busy ||
                !reviewed ||
                (kind === 'state' && !moves.includes(state)) ||
                (kind === 'organization' && !sameAudience)
              }
            >
              Apply to {selected.length} tasks
            </Button>
          </form>
        </Dialog>
      )}
    </>
  );
}
