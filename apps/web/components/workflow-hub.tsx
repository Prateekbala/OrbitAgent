'use client';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import { useEffect, useRef, useState } from 'react';
import type { Channel, Member } from '@ao/contracts';
import type { WorkTemplate, WorkflowRun } from '@ao/contracts/workflows';
import { useCursorPage } from '../lib/use-cursor-page';
import { api } from '../lib/api';
import { PageControls } from './page-controls';
import { WorkflowEditor } from './workflow-editor';
import { TaskPicker } from './task-picker';
export function WorkflowHub({
  revision,
  me,
  members,
  channels,
  onChanged,
  openRun,
  onRun,
}: {
  revision: number;
  me: Member;
  members: Member[];
  channels: Channel[];
  onChanged: () => Promise<unknown>;
  openRun?: string | null | undefined;
  onRun?: (id: string | null) => void;
}) {
  const templates = useCursorPage<WorkTemplate>(me.id, '/work-templates', revision),
    runs = useCursorPage<WorkflowRun>(me.id, '/workflow-runs', revision),
    triggers = useCursorPage<{
      id: string;
      template_name: string;
      event_type: string;
      enabled: boolean;
      version: number;
    }>(me.id, '/workflow-triggers', revision);
  const [editor, setEditor] = useState<WorkTemplate | 'new' | null>(null),
    [runId, setRunId] = useState<string | null>(openRun ?? null),
    [run, setRun] = useState<WorkflowRun | null>(null),
    [source, setSource] = useState<string | null>(null),
    [sourceTitle, setSourceTitle] = useState(''),
    [sourceScope, setSourceScope] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<{
      template: WorkTemplate;
      items: { revision: number; created_at: string; definition: { steps: unknown[] } }[];
      before: number | null;
    } | null>(null);
  const request = useRef(crypto.randomUUID()),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (openRun) setRunId(openRun);
  }, [openRun]);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    const load = () => {
      void api<WorkflowRun>('/workflow-runs/' + runId, { signal: controller.signal })
        .then((value) => {
          if (!controller.signal.aborted) setRun(value);
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setRun(null);
            setError(error instanceof Error ? error.message : 'Unable to load workflow.');
          }
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [runId, revision]);
  async function act(path: string, body: unknown, method = 'POST') {
    if (busy) return null;
    setBusy(true);
    setError('');
    try {
      const value = await api<{ id?: string }>(path, { method, body: JSON.stringify(body) });
      request.current = crypto.randomUUID();
      if (alive.current) await onChanged();
      return value;
    } catch (error) {
      if (alive.current)
        setError(error instanceof Error ? error.message : 'Unable to update workflow.');
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const manager = (template: WorkTemplate) =>
    me.kind === 'human' && (template.created_by === me.id || ['owner', 'admin'].includes(me.role));
  async function revisions(template: WorkTemplate, before?: number) {
    try {
      const response = await api<{
        items: { revision: number; created_at: string; definition: { steps: unknown[] } }[];
        next_before: number | null;
      }>(`/work-templates/${template.id}/revisions${before ? '?before=' + before : ''}`);
      if (alive.current)
        setHistory((v) => ({
          template,
          items: before && v ? [...v.items, ...response.items] : response.items,
          before: response.next_before,
        }));
    } catch (error) {
      if (alive.current)
        setError(error instanceof Error ? error.message : 'Unable to load revisions.');
    }
  }
  if (runId)
    return (
      <section className="work-hub" aria-label="Workflow run details">
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setRunId(null);
            setRun(null);
            onRun?.(null);
          }}
        >
          ← Workflows
        </Button>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        {run ? (
          <>
            <h3>{run.template_name}</h3>
            <p>
              {run.status} · revision {run.template_revision} · step {run.next_step + 1}
            </p>
            {run.replay_of ? (
              <p>Replay of an earlier run. Completed steps retain their original outputs.</p>
            ) : null}
            {run.error_code ? <p role="alert">{run.error_code}</p> : null}
            {run.escalated_at ? (
              <p>Escalated {new Date(run.escalated_at).toLocaleString()}</p>
            ) : null}
            {run.steps?.map((step) => (
              <Card key={step.step_key} asChild>
                <article className="work-card">
                  <strong>
                    {step.label ?? step.step_key.replaceAll('_', ' ')} · {step.status}
                  </strong>
                  {typeof step.output.instructions === 'string' ? (
                    <p>{step.output.instructions}</p>
                  ) : null}
                  {step.error_code ? <p>{step.error_code}</p> : null}
                  {typeof step.output.taskId === 'string' ? (
                    <small>Task created or observed by this step.</small>
                  ) : null}
                  <small>
                    {step.attempts} attempt{step.attempts === 1 ? '' : 's'}
                  </small>
                </article>
              </Card>
            ))}
            {run.status === 'waiting' &&
            run.steps?.some(
              (s) => s.status === 'waiting' && typeof s.output.instructions === 'string',
            ) ? (
              <form
                className="work-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void act(`/workflow-runs/${run.id}/decision`, {
                    version: run.version,
                    approve: data.get('decision') === 'approve',
                    evidence: data.get('evidence'),
                  });
                }}
              >
                <label>
                  Decision evidence
                  <Textarea name="evidence" required maxLength={4000} />
                </label>
                <label>
                  Decision
                  <NativeSelect aria-label="Decision" name="decision">
                    <option value="approve">Approve</option>
                    <option value="reject">Reject</option>
                  </NativeSelect>
                </label>
                <Button variant="outline" disabled={busy}>
                  Record workflow decision
                </Button>
              </form>
            ) : null}
            {['failed', 'cancelled'].includes(run.status) ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  const next = await act(`/workflow-runs/${run.id}/replay`, {
                    version: run.version,
                    clientId: request.current,
                  });
                  if (next?.id) {
                    setRunId(next.id);
                    setRun(null);
                    onRun?.(next.id);
                  }
                }}
              >
                Replay remaining workflow
              </Button>
            ) : ['queued', 'running', 'waiting'].includes(run.status) ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(`/workflow-runs/${run.id}/cancel`, { version: run.version })
                }
              >
                Cancel workflow
              </Button>
            ) : null}
          </>
        ) : (
          <p role="status">{error ? 'Workflow unavailable.' : 'Loading workflow…'}</p>
        )}
      </section>
    );
  return (
    <section className="work-hub" aria-label="Workflows and templates">
      <div className="task-section-heading">
        <h3>Workflows and templates</h3>
        <Button size="sm" type="button" className="primary small" onClick={() => setEditor('new')}>
          New work template
        </Button>
      </div>
      <p className="muted">
        Publish reusable task plans and approval workflows. Event triggers run under their owner’s
        current authority.
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <div className="work-form">
        <label>
          Source task audience
          <NativeSelect
            aria-label="Source task audience"
            value={sourceScope}
            onChange={(event) => {
              setSourceScope(event.target.value);
              setSource(null);
              setSourceTitle('');
            }}
          >
            <option value="">Workspace</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <TaskPicker
          label="Workflow source task"
          conversationId={sourceScope || null}
          exclude=""
          onPick={(task) => {
            setSource(task.id);
            setSourceTitle(task.title);
          }}
        />
        {source ? (
          <p>
            Source: {sourceTitle}{' '}
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setSource(null);
                setSourceTitle('');
              }}
            >
              Clear workflow source
            </Button>
          </p>
        ) : null}
      </div>
      {templates.items.map((template) => (
        <Card key={template.id} asChild>
          <article className="work-card">
            <h4>{template.name}</h4>
            <p>
              {template.kind} · latest revision {template.latest_revision} ·{' '}
              {template.archived
                ? 'Archived'
                : template.published_revision
                  ? 'Published revision ' + template.published_revision
                  : 'Unpublished'}
            </p>
            <div className="work-actions">
              <Button variant="outline" type="button" onClick={() => void revisions(template)}>
                Version history
              </Button>
              {manager(template) ? (
                <>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={async () => {
                      try {
                        const value = await api<WorkTemplate>('/work-templates/' + template.id);
                        if (alive.current) setEditor(value);
                      } catch (error) {
                        if (alive.current)
                          setError(
                            error instanceof Error ? error.message : 'Template unavailable.',
                          );
                      }
                    }}
                  >
                    Revise template
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/work-templates/${template.id}/publication`,
                        { version: template.version, revision: template.latest_revision },
                        'PUT',
                      )
                    }
                  >
                    Publish latest revision
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/work-templates/${template.id}/publication`,
                        {
                          version: template.version,
                          revision: template.published_revision ?? template.latest_revision,
                          archived: !template.archived,
                        },
                        'PUT',
                      )
                    }
                  >
                    {template.archived ? 'Restore template' : 'Archive template'}
                  </Button>
                </>
              ) : null}
              {template.published_revision && !template.archived ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    const result = await act(`/work-templates/${template.id}/start`, {
                      clientId: request.current,
                      revision: template.published_revision,
                      ...(source ? { sourceTaskId: source } : {}),
                    });
                    if (result?.id) {
                      setRunId(result.id);
                      onRun?.(result.id);
                    }
                  }}
                >
                  Run published template
                </Button>
              ) : null}
            </div>
            {template.kind === 'workflow' &&
            template.published_revision &&
            manager(template) &&
            !template.archived ? (
              <form
                className="work-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void act('/workflow-triggers', {
                    clientId: request.current,
                    templateId: template.id,
                    revision: template.published_revision,
                    event: data.get('event'),
                    ...(data.get('state') ? { state: data.get('state') } : {}),
                  });
                }}
              >
                <label>
                  Trigger event
                  <NativeSelect aria-label="Trigger event" name="event">
                    <option value="task.created">Task created</option>
                    <option value="task.updated">Task updated</option>
                    <option value="task.transitioned">Task state changed</option>
                    <option value="task.comment_created">Task comment added</option>
                  </NativeSelect>
                </label>
                <label>
                  Only when task state is
                  <NativeSelect aria-label="Only when task state is" name="state">
                    <option value="">Any state</option>
                    {[
                      'proposed',
                      'queued',
                      'active',
                      'blocked',
                      'awaiting_approval',
                      'awaiting_review',
                      'completed',
                      'failed',
                      'cancelled',
                    ].map((state) => (
                      <option key={state} value={state}>
                        {state.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <Button variant="outline" disabled={busy}>
                  Add event trigger
                </Button>
              </form>
            ) : null}
          </article>
        </Card>
      ))}
      <PageControls {...templates} onMore={templates.more} />
      {history ? (
        <Card asChild>
          <section aria-label="Template version history" className="work-card">
            <h4>{history.template.name}: version history</h4>
            {history.items.map((v) => (
              <div key={v.revision}>
                <strong>Revision {v.revision}</strong>
                <p>
                  {v.definition.steps.length} steps · {new Date(v.created_at).toLocaleString()}
                </p>
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      const value = await api<WorkTemplate>(
                        `/work-templates/${history.template.id}?revision=${v.revision}`,
                      );
                      if (alive.current)
                        setEditor({ ...value, latest_revision: history.template.latest_revision });
                    } catch (error) {
                      setError(error instanceof Error ? error.message : 'Revision unavailable.');
                    }
                  }}
                >
                  Create revision from revision {v.revision}
                </Button>
              </div>
            ))}
            {history.before ? (
              <Button
                variant="outline"
                onClick={() => void revisions(history.template, history.before!)}
              >
                Load older template revisions
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setHistory(null)}>
              Close version history
            </Button>
          </section>
        </Card>
      ) : null}
      <h4>Event triggers</h4>
      {triggers.items.map((trigger) => (
        <Card key={trigger.id} asChild>
          <article className="work-card">
            <strong>{trigger.template_name}</strong>
            <p>
              {trigger.event_type} · {trigger.enabled ? 'Enabled' : 'Disabled'}
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(
                  '/workflow-triggers/' + trigger.id,
                  { version: trigger.version, enabled: !trigger.enabled },
                  'PATCH',
                )
              }
            >
              {trigger.enabled ? 'Disable trigger' : 'Enable trigger'}
            </Button>
          </article>
        </Card>
      ))}
      <PageControls {...triggers} onMore={triggers.more} />
      <h4>Execution history</h4>
      {runs.items.map((item) => (
        <Button
          variant="outline"
          className="work-card work-run-button"
          key={item.id}
          onClick={() => {
            setRunId(item.id);
            onRun?.(item.id);
          }}
        >
          <strong>{item.template_name}</strong>
          <span>
            {item.status} · revision {item.template_revision} ·{' '}
            {new Date(item.created_at).toLocaleString()}
          </span>
        </Button>
      ))}
      <PageControls {...runs} onMore={runs.more} />
      {editor ? (
        <WorkflowEditor
          template={editor === 'new' ? undefined : editor}
          members={members}
          channels={channels}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
