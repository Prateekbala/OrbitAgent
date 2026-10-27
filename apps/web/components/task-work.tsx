'use client';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';
import { Input } from './ui/input';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Agent, Member, Task } from '@ao/contracts';
import type { TaskWork } from '@ao/contracts/workflows';
import { api } from '../lib/api';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
interface Artifact {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  details: string;
  outcome: string;
  file_id: string | null;
  creator_name: string;
}
interface Source {
  id: string;
  message_id: string;
  kind: string;
  body: string;
  conversation_id: string;
  workspace_id: string;
}
interface TaskRun {
  progress_summary?: string | null;
  verification_status?: string;
  id: string;
  status: string;
  prompt: string;
  agent_name: string;
  created_at: string;
}
type TaskWorkProps = {
  task: Task;
  me: Member;
  members: Member[];
  canManage: boolean;
  revision: number;
  onChanged: () => Promise<unknown>;
};
export function TaskWorkDisclosure(props: TaskWorkProps) {
  const [open, setOpen] = useState(false);
  return (
    <section className="task-section task-work-disclosure" aria-label="Task work tools">
      <div className="task-section-heading">
        <h3>People, acceptance and artifacts</h3>
        <Button
          variant="outline"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Close task collaboration' : 'Open task collaboration'}
        </Button>
      </div>
      <p className="muted">
        Watchers, collaborators, human verification, source discussions, agent run history and
        timeline planning.
      </p>
      {open ? <TaskWorkPanel {...props} /> : null}
    </section>
  );
}
function TaskWorkPanel({ task, me, members, canManage, revision, onChanged }: TaskWorkProps) {
  const [work, setWork] = useState<Pick<TaskWork, 'participants' | 'criteria'> | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const requests = useRef(new Map<string, { signature: string; id: string }>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const request = new AbortController();
    void api<Pick<TaskWork, 'participants' | 'criteria'>>(`/tasks/${task.id}/work`, {
      signal: request.signal,
    })
      .then((value) => {
        if (!request.signal.aborted) setWork(value);
      })
      .catch((error) => {
        if (!request.signal.aborted) {
          setWork(null);
          setError(error instanceof Error ? error.message : 'Unable to load task collaboration.');
        }
      });
    return () => request.abort();
  }, [task.id, revision]);
  const canReadRuns =
    me.kind === 'human' &&
    me.access_type !== 'guest' &&
    me.access_type !== 'service' &&
    me.permissions?.['execution.read'] !== false;
  const canRun = canManage && canReadRuns && me.permissions?.['execution.manage'] !== false;
  const artifacts = useCursorPage<Artifact>(task.id, `/tasks/${task.id}/artifacts`, revision),
    sources = useCursorPage<Source>(
      me.permissions?.['messages.read'] === false ? null : task.id,
      `/tasks/${task.id}/sources`,
      revision,
    ),
    runs = useCursorPage<TaskRun>(canReadRuns ? task.id : null, `/tasks/${task.id}/runs`, revision),
    attachments = useCursorPage<{ id: string; name: string }>(
      canManage ? task.id : null,
      `/tasks/${task.id}/attachments`,
      revision,
    ),
    availableRuns = useCursorPage<TaskRun & { conversation_id: string }>(
      canManage && task.conversation_id && me.permissions?.['execution.read'] !== false
        ? task.id
        : null,
      '/collections/runs',
      revision,
    ),
    reviews = useCursorPage<{
      id: string;
      accepted: boolean;
      evidence: string;
      reviewer_name: string;
      created_at: string;
    }>(task.id, `/tasks/${task.id}/verification-history`, revision),
    people = useCursorPage<Member>(canManage ? task.id : null, '/collections/members'),
    agents = useCursorPage<Agent>(
      canRun && task.conversation_id ? task.id : null,
      '/collections/agents',
    );
  const choices = [...new Map([...members, ...people.items].map((m) => [m.id, m])).values()].filter(
    (m) => m.status !== 'suspended',
  );
  async function act(path: string, body: unknown, method = 'POST'): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError('');
    let requestBody = body;
    if (body && typeof body === 'object' && 'clientId' in body) {
      const { clientId: _key, ...payload } = body as Record<string, unknown>;
      const signature = JSON.stringify(payload),
        old = requests.current.get(path);
      const id = old?.signature === signature ? old.id : crypto.randomUUID();
      requests.current.set(path, { signature, id });
      requestBody = { ...payload, clientId: id };
    }
    try {
      await api(path, { method, body: JSON.stringify(requestBody) });
      requests.current.delete(path);
      if (alive.current)
        try {
          await onChanged();
        } catch {
          setError('Saved. Refresh this task to load the latest details.');
        }
      return true;
    } catch (error) {
      if (alive.current)
        setError(error instanceof Error ? error.message : 'Unable to update task work.');
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function form(event: FormEvent<HTMLFormElement>, submit: (data: FormData) => Promise<boolean>) {
    event.preventDefault();
    const node = event.currentTarget;
    void submit(new FormData(node)).then((saved) => {
      if (saved && node.isConnected) node.reset();
    });
  }
  const watching = work?.participants.find((p) => p.membership_id === me.id);
  return (
    <Card asChild>
      <section className="task-section work-panel" aria-label="Task collaboration and verification">
        <h3>People and acceptance</h3>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <Button
          variant="outline"
          type="button"
          disabled={busy || !work}
          onClick={() =>
            void act(
              `/tasks/${task.id}/participants`,
              {
                version: task.version,
                membershipId: me.id,
                role: 'watcher',
                remove: Boolean(watching),
              },
              'PUT',
            )
          }
        >
          {watching ? 'Stop following task' : 'Watch task'}
        </Button>
        <p className="muted">
          Watchers receive task updates. Collaborators can edit the task; its audience stays the
          same.
        </p>
        {work?.participants.map((person) => (
          <div className="work-inline" key={person.membership_id}>
            <span>
              {person.name} · {person.role}
            </span>
            {canManage ? (
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                aria-label={`Remove task participant ${person.name}`}
                onClick={() =>
                  void act(
                    `/tasks/${task.id}/participants`,
                    {
                      version: task.version,
                      membershipId: person.membership_id,
                      role: person.role,
                      remove: true,
                    },
                    'PUT',
                  )
                }
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        {canManage ? (
          <form
            className="work-form"
            onSubmit={(event) =>
              form(event, (data) =>
                act(
                  `/tasks/${task.id}/participants`,
                  {
                    version: task.version,
                    membershipId: data.get('member'),
                    role: data.get('role'),
                  },
                  'PUT',
                ),
              )
            }
          >
            <label>
              Task participant
              <NativeSelect name="member" required aria-label="Task participant">
                <option value="">Choose a teammate</option>
                {choices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Participation
              <NativeSelect aria-label="Participation" name="role">
                <option value="watcher">Watcher</option>
                <option value="collaborator">Collaborator</option>
              </NativeSelect>
            </label>
            <Button variant="outline" disabled={busy}>
              Add task participant
            </Button>
            <PageControls {...people} onMore={people.more} />
          </form>
        ) : null}
        <h4>Acceptance criteria</h4>
        {!work?.criteria.length ? (
          <p className="muted">No explicit acceptance criteria yet.</p>
        ) : null}
        {work?.criteria.map((criterion) => (
          <Card key={criterion.id} asChild>
            <article className="work-card">
              <strong>
                {criterion.accepted ? 'Verified' : 'Not verified'} · {criterion.text}
              </strong>
              <p>{criterion.evidence}</p>
              {criterion.reviewer_name ? (
                <small>Reviewed by {criterion.reviewer_name}</small>
              ) : null}
              {canManage &&
              me.kind === 'human' &&
              !['completed', 'cancelled'].includes(task.state) ? (
                <form
                  className="work-form"
                  onSubmit={(event) =>
                    form(event, (data) =>
                      act(
                        `/tasks/${task.id}/criteria/${criterion.id}`,
                        {
                          version: task.version,
                          accepted: data.get('accepted') === 'yes',
                          evidence: data.get('evidence'),
                          artifactId: data.get('artifact') || null,
                        },
                        'PUT',
                      ),
                    )
                  }
                >
                  <label>
                    Criterion evidence
                    <Textarea
                      name="evidence"
                      required
                      maxLength={4000}
                      aria-label={`Evidence for ${criterion.text}`}
                    />
                  </label>
                  <label>
                    Supporting artifact
                    <NativeSelect aria-label="Supporting artifact" name="artifact">
                      <option value="">No linked artifact</option>
                      {artifacts.items.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label>
                    Verification result
                    <NativeSelect
                      aria-label="Verification result"
                      name="accepted"
                      defaultValue="yes"
                    >
                      <option value="yes">Accepted</option>
                      <option value="no">Needs more work</option>
                    </NativeSelect>
                  </label>
                  <Button variant="outline" disabled={busy}>
                    Record verification
                  </Button>
                </form>
              ) : null}
            </article>
          </Card>
        ))}
        {canManage && !['completed', 'cancelled'].includes(task.state) ? (
          <form
            className="work-form"
            onSubmit={(event) =>
              form(event, (data) =>
                act(`/tasks/${task.id}/criteria`, {
                  version: task.version,
                  text: data.get('text'),
                  required: data.get('required') === 'on',
                }),
              )
            }
          >
            <label>
              New acceptance criterion
              <Input name="text" required maxLength={2000} />
            </label>
            <label className="checkbox-label">
              <Input name="required" type="checkbox" defaultChecked />
              Required before completion
            </label>
            <Button variant="outline" disabled={busy}>
              Add acceptance criterion
            </Button>
          </form>
        ) : null}
        <h4>Structured artifacts</h4>
        {artifacts.items.map((artifact) => (
          <Card key={artifact.id} asChild>
            <article className="work-card">
              <strong>{artifact.title}</strong>
              <small>
                {artifact.kind} · {artifact.outcome} · {artifact.creator_name}
              </small>
              <p>{artifact.details}</p>
              {artifact.url ? (
                <a href={artifact.url} target="_blank" rel="noopener noreferrer">
                  Open artifact
                </a>
              ) : null}
            </article>
          </Card>
        ))}
        <PageControls {...artifacts} onMore={artifacts.more} />
        {canManage ? (
          <form
            className="work-form"
            onSubmit={(event) =>
              form(event, (data) =>
                act(`/tasks/${task.id}/artifacts`, {
                  clientId: crypto.randomUUID(),
                  kind: data.get('kind'),
                  title: data.get('title'),
                  details: data.get('details'),
                  outcome: data.get('outcome'),
                  ...(data.get('url') ? { url: data.get('url') } : {}),
                  ...(data.get('file') ? { fileId: data.get('file') } : {}),
                }),
              )
            }
          >
            <label>
              Artifact title
              <Input name="title" required maxLength={200} />
            </label>
            <label>
              Artifact type
              <NativeSelect aria-label="Artifact type" name="kind">
                <option value="link">Link</option>
                <option value="document">Document</option>
                <option value="decision">Decision</option>
                <option value="test_result">Test result</option>
                <option value="file">Attached file</option>
              </NativeSelect>
            </label>
            <label>
              Artifact URL
              <Input name="url" type="url" placeholder="https://" />
            </label>
            <label>
              Attached artifact file
              <NativeSelect aria-label="Attached artifact file" name="file">
                <option value="">No file</option>
                {attachments.items.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <PageControls {...attachments} onMore={attachments.more} />
            <label>
              Artifact details
              <Textarea name="details" maxLength={12000} />
            </label>
            <label>
              Reported outcome
              <NativeSelect aria-label="Reported outcome" name="outcome">
                <option value="proposed">Proposed</option>
                <option value="passed">Passed</option>
                <option value="failed">Failed</option>
              </NativeSelect>
            </label>
            <Button variant="outline" disabled={busy}>
              Add structured artifact
            </Button>
          </form>
        ) : null}
        <h4>Source discussions and decisions</h4>
        {sources.items.map((source) => (
          <Card key={source.id} asChild>
            <article className="work-card">
              <strong>{source.kind}</strong>
              <p>{source.body}</p>
              <a href={`/?workspace=${source.workspace_id}&message=${source.message_id}`}>
                Open source discussion
              </a>
            </article>
          </Card>
        ))}
        <PageControls {...sources} onMore={sources.more} />
        {canManage && task.conversation_id && me.permissions?.['messages.read'] !== false ? (
          <form
            className="work-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              try {
                const messageId = new URL(
                  String(data.get('link')),
                  window.location.origin,
                ).searchParams.get('message');
                if (!messageId) throw new Error('Paste a message permalink.');
                void act(`/tasks/${task.id}/sources`, { messageId, kind: data.get('kind') });
              } catch (error) {
                setError(error instanceof Error ? error.message : 'Invalid message link.');
              }
            }}
          >
            <label>
              Source message permalink
              <Input name="link" required placeholder="Paste a message link" />
            </label>
            <label>
              Source type
              <NativeSelect aria-label="Source type" name="kind">
                <option value="discussion">Discussion</option>
                <option value="decision">Decision</option>
              </NativeSelect>
            </label>
            <Button variant="outline" disabled={busy}>
              Link source message
            </Button>
          </form>
        ) : null}
        <details>
          <summary>Acceptance verification history</summary>
          {reviews.items.map((review) => (
            <Card key={review.id} asChild>
              <article className="work-card">
                <strong>
                  {review.accepted ? 'Accepted' : 'Needs more work'} · {review.reviewer_name}
                </strong>
                <p>{review.evidence}</p>
                <small>{new Date(review.created_at).toLocaleString()}</small>
              </article>
            </Card>
          ))}
          <PageControls {...reviews} onMore={reviews.more} />
        </details>
        <h4>Agent run history</h4>
        {runs.items.map((run) => (
          <Card key={run.id} asChild>
            <article className="work-card">
              <strong>
                {run.agent_name} · {run.status}
              </strong>
              <p>{run.prompt}</p>
              {run.progress_summary && <p>Progress: {run.progress_summary}</p>}
              {run.verification_status && run.verification_status !== 'not_required' && (
                <small>Independent verification: {run.verification_status}</small>
              )}
              <small>{new Date(run.created_at).toLocaleString()}</small>
            </article>
          </Card>
        ))}
        <PageControls {...runs} onMore={runs.more} />
        {canManage &&
        task.conversation_id &&
        me.kind === 'human' &&
        me.permissions?.['execution.manage'] !== false ? (
          <form
            className="work-form"
            onSubmit={(event) =>
              form(event, (data) =>
                act(`/tasks/${task.id}/runs`, {
                  action: 'start',
                  agentId: data.get('agent'),
                  prompt: data.get('prompt'),
                  clientId: crypto.randomUUID(),
                }),
              )
            }
          >
            <label>
              Task agent
              <NativeSelect aria-label="Task agent" name="agent" required>
                <option value="">Choose a managed agent</option>
                {agents.items
                  .filter((a) => a.runtime === 'managed' && a.status === 'active')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            <label>
              Task run instructions
              <Textarea name="prompt" required maxLength={12000} />
            </label>
            <Button variant="outline" disabled={busy}>
              Start task agent run
            </Button>
            <PageControls {...agents} onMore={agents.more} />
          </form>
        ) : null}
        {canManage && task.conversation_id && me.permissions?.['execution.manage'] !== false ? (
          <form
            className="work-form"
            onSubmit={(event) =>
              form(event, (data) =>
                act(`/tasks/${task.id}/runs`, { action: 'link', runId: data.get('run') }),
              )
            }
          >
            <label>
              Existing agent run
              <NativeSelect aria-label="Existing agent run" name="run" required>
                <option value="">Choose a run in this conversation</option>
                {availableRuns.items
                  .filter((run) => run.conversation_id === task.conversation_id)
                  .map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.agent_name} · {run.status} · {run.prompt.slice(0, 60)}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            <Button variant="outline" disabled={busy}>
              Link existing run
            </Button>
            <PageControls {...availableRuns} onMore={availableRuns.more} />
          </form>
        ) : null}
        {canManage ? <TaskPlanEditor task={task} busy={busy} save={act} /> : null}
      </section>
    </Card>
  );
}

function TaskPlanEditor({
  task,
  busy,
  save,
}: {
  task: Task;
  busy: boolean;
  save: (path: string, body: unknown, method: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState({
    version: task.version,
    start: task.start_date ?? '',
    estimate: task.estimate?.toString() ?? '',
    dirty: false,
  });
  useEffect(() => {
    setDraft((value) =>
      value.dirty
        ? value
        : {
            version: task.version,
            start: task.start_date ?? '',
            estimate: task.estimate?.toString() ?? '',
            dirty: false,
          },
    );
  }, [task.version, task.start_date, task.estimate]);
  const stale = draft.dirty && draft.version !== task.version;
  return (
    <form
      className="work-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save(
          `/tasks/${task.id}/plan`,
          {
            version: draft.version,
            startDate: draft.start || null,
            estimate: draft.estimate === '' ? null : Number(draft.estimate),
          },
          'PUT',
        ).then((saved) => {
          if (saved) setDraft((v) => ({ ...v, version: v.version + 1, dirty: false }));
        });
      }}
    >
      <h4>Timeline planning</h4>
      <label>
        Planned start date
        <Input
          type="date"
          value={draft.start}
          max={task.due_date ?? '9999-12-31'}
          onChange={(event) => setDraft((v) => ({ ...v, start: event.target.value, dirty: true }))}
        />
      </label>
      <label>
        Estimated effort
        <Input
          type="number"
          min={0}
          max={100000}
          step="0.25"
          value={draft.estimate}
          onChange={(event) =>
            setDraft((v) => ({ ...v, estimate: event.target.value, dirty: true }))
          }
        />
      </label>
      {stale ? (
        <p role="status">
          This task changed. Your plan draft is preserved.{' '}
          <Button
            variant="outline"
            type="button"
            onClick={() => setDraft((v) => ({ ...v, version: task.version }))}
          >
            I reviewed the task; keep my plan draft
          </Button>
        </p>
      ) : null}
      <Button variant="outline" disabled={busy || stale}>
        Save task plan
      </Button>
    </form>
  );
}
