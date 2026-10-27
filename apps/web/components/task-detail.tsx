'use client';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import { TaskWorkDisclosure } from './task-work';
import { TaskOrganizationPanel } from './task-organization';
import { TaskAttachmentsPanel } from './task-attachments';
import { useEffect, useRef, useState } from 'react';
import type { Channel, ConversationDetails, Member, TaskDetails, TaskHistory } from '@ao/contracts';
import { taskLabels, taskMoves } from '@ao/contracts/tasks';
import { api, HttpError, post } from '../lib/api';
import { dueLabel, overdueTask } from '../lib/task-display';
import { TaskCommentsPanel } from './task-comments';
import { TaskRelationsPanel } from './task-relations';
import { TaskSchedulingPanel } from './task-scheduling';
import { TaskPicker } from './task-picker';
type Draft = {
  title: string;
  description: string;
  priority: 'low' | 'normal' | 'high';
  assigneeId: string | null;
  parentId: string | null;
  parentTitle: string;
  dueDate: string | null;
  version: number;
};
export function TaskDetail({
  id,
  revision,
  me,
  members,
  channels,
  onOpen,
  onBack,
  onChanged,
}: {
  id: string;
  revision: number;
  me: Member;
  members: Member[];
  channels: Channel[];
  onOpen: (id: string) => void;
  onBack: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const [details, setDetails] = useState<TaskDetails | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [pickingParent, setPickingParent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [state, setState] = useState(''),
    [evidence, setEvidence] = useState(''),
    [eligible, setEligible] = useState<string[] | null>(null),
    [history, setHistory] = useState<TaskHistory | null>(null),
    [historyBusy, setHistoryBusy] = useState(false);
  const alive = useRef(true),
    historyRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      historyRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    const request = new AbortController();
    void api<TaskDetails>(`/tasks/${id}`, { signal: request.signal })
      .then((result) => {
        if (!request.signal.aborted) setDetails(result);
      })
      .catch((e) => {
        if (!request.signal.aborted) {
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            setDetails(null);
            setDraft(null);
            setHistory(null);
          }
          setError(e instanceof Error ? e.message : 'Unable to load task.');
        }
      });
    return () => request.abort();
  }, [id, revision]);
  const source = details?.task.conversation_id ?? null;
  const privateSource = Boolean(
    source && channels.find((c) => c.id === source)?.visibility === 'private',
  );
  useEffect(() => {
    setEligible(privateSource ? [] : null);
    if (!source || !privateSource) return;
    const request = new AbortController();
    void api<ConversationDetails>(`/conversations/${source}`, { signal: request.signal })
      .then((result) => {
        if (!request.signal.aborted)
          setEligible(result.participants.filter((p) => p.status === 'active').map((p) => p.id));
      })
      .catch(() => {
        if (!request.signal.aborted) setEligible([]);
      });
    return () => request.abort();
  }, [source, privateSource, revision]);
  const task = details?.task,
    choices = eligible ? members.filter((m) => eligible.includes(m.id)) : members;
  function failure(e: unknown) {
    if (!alive.current) return;
    setError(e instanceof Error ? e.message : 'Unable to update task.');
    if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
      setDetails(null);
      setDraft(null);
      setHistory(null);
      setEvidence('');
      setState('');
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    try {
      const { parentTitle: _title, ...input } = draft;
      await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
      if (alive.current) {
        setDraft(null);
        setPickingParent(false);
        await onChanged();
      }
    } catch (e) {
      failure(e);
      if (alive.current) await onChanged();
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function transition(e: React.FormEvent) {
    e.preventDefault();
    if (!task || !state || busy) return;
    setBusy(true);
    setError('');
    try {
      await post(`/tasks/${id}/transitions`, { state, version: task.version, evidence });
      if (alive.current) {
        setState('');
        setEvidence('');
        await onChanged();
      }
    } catch (e) {
      failure(e);
      if (alive.current) await onChanged();
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function activity(append = false) {
    if (historyBusy) return;
    historyRequest.current?.abort();
    const request = new AbortController();
    historyRequest.current = request;
    setHistoryBusy(true);
    try {
      const rows = await api<TaskHistory>(
        `/tasks/${id}/history?limit=20${append && history?.next_before ? `&before=${history.next_before}` : ''}`,
        { signal: request.signal },
      );
      if (!request.signal.aborted)
        setHistory((old) => ({
          items: append ? [...(old?.items ?? []), ...rows.items] : rows.items,
          next_before: rows.next_before,
        }));
    } catch (e) {
      if (!request.signal.aborted) failure(e);
    } finally {
      if (!request.signal.aborted) setHistoryBusy(false);
    }
  }
  return (
    <section className="page-content task-detail-page">
      <div className="document-actions">
        <Button variant="link" type="button" className="text-button" onClick={onBack}>
          ← All tasks
        </Button>
        <Button
          variant="link"
          type="button"
          className="text-button"
          onClick={() => void onChanged()}
        >
          Refresh task
        </Button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!task || !details ? (
        <p role="status">{error ? 'This task is unavailable.' : 'Loading task…'}</p>
      ) : (
        <>
          <header className="task-detail-heading">
            <div>
              <span className="eyebrow">
                {task.conversation_id
                  ? (channels.find((c) => c.id === task.conversation_id)?.name ??
                    'Conversation task')
                  : 'WORKSPACE TASK'}
              </span>
              <h2>{task.title}</h2>
              <p className="muted">
                Created by {task.creator_name ?? 'an earlier workspace member'} · version{' '}
                {task.version}
              </p>
            </div>
            <Badge variant="outline" className={`state ${task.state}`}>
              {taskLabels[task.state]}
            </Badge>
          </header>
          {details.parent && (
            <Button
              variant="link"
              type="button"
              className="text-button task-parent-link"
              onClick={() => onOpen(details.parent!.id)}
            >
              ↑ Parent: {details.parent.title}
            </Button>
          )}
          {task.unresolved_dependency_count > 0 && (
            <p className="task-blocker-notice" role="status">
              Waiting on {task.unresolved_dependency_count} unfinished{' '}
              {task.unresolved_dependency_count === 1 ? 'prerequisite' : 'prerequisites'}. Move to
              Queued or Blocked while resolving dependencies.
            </p>
          )}
          <div className="task-detail-metadata">
            <span>
              Assignee <strong>{task.assignee_name ?? 'Unassigned'}</strong>
            </span>
            <span>
              Priority <strong>{task.priority}</strong>
            </span>
            <span>
              Due date{' '}
              <strong className={overdueTask(task) ? 'task-overdue' : ''}>
                {task.due_date ? dueLabel(task.due_date) : 'No due date'}
                {overdueTask(task) ? ' · Overdue' : ''}
              </strong>
            </span>
            <span>
              Last updated <strong>{new Date(task.updated_at).toLocaleString()}</strong>
            </span>
          </div>
          {draft ? (
            <form className="task-edit-form" onSubmit={save}>
              {draft.version !== task.version && (
                <div className="conflict-panel">
                  <strong>A newer task version is available: v{task.version}</strong>
                  <p>
                    Review the latest saved title, owner, date and description before keeping your
                    draft.
                  </p>
                  <h3>{task.title}</h3>
                  <p>{task.description}</p>
                  <p>
                    {task.assignee_name ?? 'Unassigned'} · {task.priority} ·{' '}
                    {task.due_date ?? 'No due date'} · Parent: {details.parent?.title ?? 'None'}
                  </p>
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => setDraft({ ...draft, version: task.version })}
                  >
                    I reviewed v{task.version}; keep my task draft
                  </Button>
                </div>
              )}
              <label>
                Task title
                <Input
                  aria-label="Edit task title"
                  value={draft.title}
                  required
                  minLength={3}
                  maxLength={200}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </label>
              <label>
                Description
                <Textarea
                  aria-label="Edit task description"
                  value={draft.description}
                  rows={5}
                  maxLength={12000}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
              <div className="task-form-columns">
                <label>
                  Assignee
                  <NativeSelect
                    aria-label="Edit task assignee"
                    value={draft.assigneeId ?? ''}
                    disabled={busy}
                    onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value || null })}
                  >
                    <option value="">Unassigned</option>
                    {choices.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                    {draft.assigneeId && !choices.some((m) => m.id === draft.assigneeId) && (
                      <option value={draft.assigneeId}>
                        {task.assignee_name ?? 'Unavailable member'}
                      </option>
                    )}
                  </NativeSelect>
                </label>
                <label>
                  Priority
                  <NativeSelect
                    aria-label="Edit task priority"
                    value={draft.priority}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, priority: e.target.value as Draft['priority'] })
                    }
                  >
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </NativeSelect>
                </label>
                <label>
                  Due date
                  <Input
                    aria-label="Edit task due date"
                    type="date"
                    min="0001-01-01"
                    max="9999-12-31"
                    value={draft.dueDate ?? ''}
                    disabled={busy}
                    onChange={(e) => setDraft({ ...draft, dueDate: e.target.value || null })}
                  />
                </label>
              </div>
              <div className="document-actions">
                <span>Parent: {draft.parentTitle || 'None'}</span>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => setPickingParent((v) => !v)}
                >
                  Choose parent task
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft({ ...draft, parentId: null, parentTitle: '' });
                    setPickingParent(false);
                  }}
                >
                  Make a root task
                </Button>
              </div>
              {pickingParent && (
                <TaskPicker
                  label="Find a parent task"
                  conversationId={task.conversation_id}
                  exclude={task.id}
                  onPick={(parent) => {
                    setDraft({ ...draft, parentId: parent.id, parentTitle: parent.title });
                    setPickingParent(false);
                  }}
                />
              )}
              <div className="document-actions">
                <Button
                  size="sm"
                  className="primary small"
                  disabled={busy || task.version !== draft.version}
                >
                  Save task changes
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setPickingParent(false);
                    setError('');
                  }}
                >
                  Discard task draft
                </Button>
              </div>
            </form>
          ) : (
            <>
              <p className="task-description">{task.description || 'No additional details.'}</p>
              {details.can_manage && (
                <Button
                  variant="outline"
                  type="button"
                  className="subtle-button"
                  onClick={() => {
                    setError('');
                    setDraft({
                      title: task.title,
                      description: task.description,
                      priority: task.priority,
                      assigneeId: task.assignee_id,
                      parentId: task.parent_id,
                      parentTitle: details.parent?.title ?? '',
                      dueDate: task.due_date,
                      version: task.version,
                    });
                  }}
                >
                  Edit task
                </Button>
              )}
            </>
          )}
          {details.can_manage && !draft && taskMoves[task.state].length > 0 && (
            <form className="task-state-form" onSubmit={transition}>
              <label>
                Change state
                <NativeSelect
                  aria-label="Task next state"
                  value={state}
                  disabled={busy}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="">Choose next state</option>
                  {taskMoves[task.state].map((next) => (
                    <option value={next} key={next}>
                      {taskLabels[next]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              {state === 'completed' && (
                <label>
                  Verification evidence
                  <Textarea
                    aria-label="Task completion evidence"
                    value={evidence}
                    required
                    maxLength={2000}
                    rows={3}
                    disabled={busy}
                    onChange={(e) => setEvidence(e.target.value)}
                  />
                </label>
              )}
              <Button
                size="sm"
                className="primary small"
                disabled={busy || !state || (state === 'completed' && !evidence.trim())}
              >
                Update task state
              </Button>
            </form>
          )}
          <TaskWorkDisclosure
            task={task}
            me={me}
            members={members}
            canManage={details.can_manage}
            revision={revision}
            onChanged={onChanged}
          />
          <TaskSchedulingPanel
            task={task}
            canManage={details.can_manage}
            human={me.kind === 'human'}
            revision={revision}
            onChanged={onChanged}
            onOpen={onOpen}
          />
          <TaskOrganizationPanel task={task} canManage={details.can_manage} onChanged={onChanged} />
          <TaskRelationsPanel
            task={task}
            members={choices}
            canManage={details.can_manage}
            revision={revision}
            onOpen={onOpen}
            onChanged={onChanged}
          />
          <TaskAttachmentsPanel
            id={id}
            canManage={details.can_manage}
            revision={revision}
            onChanged={onChanged}
          />
          <TaskCommentsPanel id={id} revision={revision} me={me} onChanged={onChanged} />
          <section className="task-section">
            <div className="task-section-heading">
              <h3>State history and evidence</h3>
              <Button
                variant="link"
                type="button"
                className="text-button"
                disabled={historyBusy}
                onClick={() => void activity()}
              >
                Load state history
              </Button>
            </div>
            {history && history.items.length === 0 && (
              <p className="muted">No state changes yet.</p>
            )}
            {history?.items.map((row) => (
              <article className="task-history-entry" key={row.id}>
                <strong>
                  {taskLabels[row.from_state]} → {taskLabels[row.to_state]}
                </strong>
                <small>
                  {row.actor_name} · {new Date(row.created_at).toLocaleString()}
                </small>
                {row.evidence && <p>{row.evidence}</p>}
              </article>
            ))}
            {history?.next_before && (
              <Button
                variant="outline"
                type="button"
                disabled={historyBusy}
                onClick={() => void activity(true)}
              >
                Load older state history
              </Button>
            )}
          </section>
        </>
      )}
    </section>
  );
}
