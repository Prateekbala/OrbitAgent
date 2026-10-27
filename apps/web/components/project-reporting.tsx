'use client';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { useEffect, useState } from 'react';
import type { Project, Channel, Member } from '@ao/contracts';
import type { ProjectReport } from '@ao/contracts/workflows';
import { api } from '../lib/api';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
export function ProjectReporting({ id, revision }: { id: string; revision: number }) {
  const [report, setReport] = useState<ProjectReport | null>(null),
    [error, setError] = useState(''),
    [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10)),
    [through, setThrough] = useState(() =>
      new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
    );
  const timeline = useCursorPage<{
    id: string;
    title: string;
    state: string;
    start_date: string | null;
    due_date: string | null;
    estimate: number | null;
    assignee_name: string | null;
    dependency_ids: string[];
  }>(id, `/projects/${id}/timeline?from=${from}&through=${through}`, revision);
  useEffect(() => {
    const request = new AbortController();
    void api<ProjectReport>(`/projects/${id}/report`, { signal: request.signal })
      .then((value) => {
        if (!request.signal.aborted) {
          setReport(value);
          setError('');
        }
      })
      .catch((error) => {
        if (!request.signal.aborted) {
          setReport(null);
          setError(error instanceof Error ? error.message : 'Unable to load project report.');
        }
      });
    return () => request.abort();
  }, [id, revision]);
  const span = Math.max(
    86400000,
    new Date(through).getTime() - new Date(from).getTime() + 86400000,
  );
  return (
    <Card asChild>
      <section className="task-section project-report" aria-label="Project reporting and timeline">
        <h3>Delivery report</h3>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        {report ? (
          <>
            <div className="work-metrics">
              <div>
                <strong>{report.totals.tasks}</strong>
                <span>Tasks</span>
              </div>
              <div>
                <strong>{report.totals.completed}</strong>
                <span>Completed</span>
              </div>
              <div>
                <strong>{report.totals.overdue}</strong>
                <span>Overdue, UTC</span>
              </div>
              <div>
                <strong>{report.totals.blocked}</strong>
                <span>Blocked</span>
              </div>
              <div>
                <strong>
                  {report.totals.completed_estimate}/{report.totals.estimated}
                </strong>
                <span>Estimated effort completed</span>
              </div>
            </div>
            <h4>Work by state</h4>
            {report.states.map((state) => (
              <div className="work-inline" key={state.state}>
                <span>{state.state.replaceAll('_', ' ')}</span>
                <progress
                  aria-label={`${state.state} task count`}
                  max={Math.max(1, report.totals.tasks)}
                  value={state.count}
                />
                <span>
                  {state.count} tasks · {state.estimate} effort
                </span>
              </div>
            ))}
            <h4>Team workload</h4>
            {report.assignees.map((person, i) => (
              <p key={person.name + ':' + i}>
                {person.name}: {person.count} tasks · {person.overdue} overdue · {person.estimate}{' '}
                estimated effort
              </p>
            ))}
            <h4>Completion trend, last 12 weeks</h4>
            {report.velocity.length ? (
              report.velocity.map((week) => (
                <p key={week.week}>
                  Week of {week.week}: {week.completed} completed
                </p>
              ))
            ) : (
              <p className="muted">No completions in this period.</p>
            )}
          </>
        ) : null}
        <h3>Project timeline</h3>
        <div className="work-inline">
          <label>
            Timeline from
            <Input
              type="date"
              value={from}
              max={through}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            Timeline through
            <Input
              type="date"
              value={through}
              min={from}
              onChange={(event) => setThrough(event.target.value)}
            />
          </label>
        </div>
        <div className="project-timeline" role="list" aria-label="Scheduled project tasks">
          {timeline.items.map((task) => {
            const start = task.start_date ?? task.due_date,
              end = task.due_date ?? task.start_date,
              left = start
                ? Math.max(
                    0,
                    Math.min(
                      100,
                      ((new Date(start).getTime() - new Date(from).getTime()) / span) * 100,
                    ),
                  )
                : 0,
              width =
                start && end
                  ? Math.max(
                      1,
                      Math.min(
                        100 - left,
                        ((new Date(end).getTime() - new Date(start).getTime() + 86400000) / span) *
                          100,
                      ),
                    )
                  : 0;
            return (
              <article role="listitem" className="timeline-row" key={task.id}>
                <strong>{task.title}</strong>
                <small>
                  {task.state.replaceAll('_', ' ')} · {start ?? 'Unscheduled'}
                  {end && end !== start ? ' → ' + end : ''} · {task.assignee_name ?? 'Unassigned'}
                  {task.dependency_ids.length
                    ? ` · ${task.dependency_ids.length} prerequisites`
                    : ''}
                </small>
                <div className="timeline-track" aria-hidden="true">
                  {start ? (
                    <span
                      style={{ marginLeft: left + '%', width: width + '%' }}
                      className={'timeline-bar ' + task.state}
                    />
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
        <PageControls {...timeline} onMore={timeline.more} />
      </section>
    </Card>
  );
}
interface Portfolio {
  id: string;
  name: string;
  conversation_id: string | null;
  created_by: string;
  version: number;
  project_count: number;
}
interface Rollup {
  project_ids: string[];
  portfolio: Portfolio;
  totals: {
    projects: number;
    tasks: number;
    completed: number;
    blocked: number;
    overdue: number;
    estimate: number;
  };
  items: {
    id: string;
    name: string;
    status: string;
    tasks: number;
    completed: number;
    blocked: number;
    overdue: number;
    estimate: number;
  }[];
  next_after: string | null;
}
export function PortfolioHub({
  revision,
  me,
  channels,
  onChanged,
}: {
  revision: number;
  me: Member;
  channels: Channel[];
  onChanged: () => Promise<unknown>;
}) {
  const portfolios = useCursorPage<Portfolio>(me.id, '/portfolios', revision);
  const [selected, setSelected] = useState<string | null>(null),
    [data, setData] = useState<Rollup | null>(null),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState<Portfolio | null>(null),
    [name, setName] = useState(''),
    [scope, setScope] = useState(''),
    [ids, setIds] = useState<string[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  const projects = useCursorPage<Project>(
    creating || editing ? me.id : null,
    '/projects?' + (scope ? 'conversationId=' + scope : 'workspaceOnly=true'),
    revision,
  );
  useEffect(() => {
    if (!selected) return;
    const request = new AbortController();
    void api<Rollup>(`/portfolios/${selected}/report`, { signal: request.signal })
      .then((value) => {
        if (!request.signal.aborted) setData(value);
      })
      .catch((error) => {
        if (!request.signal.aborted) {
          setData(null);
          setError(error instanceof Error ? error.message : 'Unable to load portfolio.');
        }
      });
    return () => request.abort();
  }, [selected, revision]);
  return (
    <section className="work-hub" aria-label="Project portfolios">
      <div className="task-section-heading">
        <h3>Portfolios</h3>
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setCreating(true);
            setEditing(null);
            setIds([]);
            setName('');
            setScope('');
            setKey(crypto.randomUUID());
          }}
        >
          New portfolio
        </Button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {portfolios.items.map((portfolio) => (
        <Card key={portfolio.id} asChild>
          <article className="work-card">
            <Button
              variant="ghost"
              className="task-title-button"
              onClick={() => setSelected(portfolio.id)}
            >
              {portfolio.name}
            </Button>
            <p>
              {portfolio.project_count} projects ·{' '}
              {portfolio.conversation_id ? 'Conversation audience' : 'Workspace audience'}
            </p>
          </article>
        </Card>
      ))}
      <PageControls {...portfolios} onMore={portfolios.more} />
      {data && selected ? (
        <Card asChild>
          <section className="work-card" aria-label="Portfolio report">
            <h4>{data.portfolio.name}</h4>
            <div className="work-metrics">
              {Object.entries(data.totals).map(([label, value]) => (
                <div key={label}>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            {data.items.map((project) => (
              <article className="work-inline" key={project.id}>
                <strong>{project.name}</strong>
                <span>
                  {project.status} · {project.completed}/{project.tasks} completed ·{' '}
                  {project.blocked} blocked · {project.overdue} overdue
                </span>
                <progress
                  aria-label={`${project.name} portfolio completion`}
                  max={Math.max(1, project.tasks)}
                  value={project.completed}
                />
              </article>
            ))}
            {data.next_after ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const next = await api<Rollup>(
                      `/portfolios/${selected}/report?after=${data.next_after}`,
                    );
                    setData({ ...next, items: [...data.items, ...next.items] });
                  } catch (error) {
                    setError(error instanceof Error ? error.message : 'Unable to load projects.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Load more portfolio projects
              </Button>
            ) : null}
            {data.portfolio.created_by === me.id || ['owner', 'admin'].includes(me.role) ? (
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(data.portfolio);
                  setCreating(false);
                  setName(data.portfolio.name);
                  setScope(data.portfolio.conversation_id ?? '');
                  setIds(data.project_ids);
                }}
              >
                Edit portfolio
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => {
                setSelected(null);
                setData(null);
              }}
            >
              Close portfolio report
            </Button>
          </section>
        </Card>
      ) : null}
      {creating || editing ? (
        <Card asChild>
          <form
            className="work-card work-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError('');
              try {
                const result = await api<{ id?: string }>(
                  editing ? '/portfolios/' + editing.id : '/portfolios',
                  {
                    method: editing ? 'PUT' : 'POST',
                    body: JSON.stringify(
                      editing
                        ? { version: editing.version, name, projectIds: ids }
                        : {
                            clientId: key,
                            name,
                            projectIds: ids,
                            ...(scope ? { conversationId: scope } : {}),
                          },
                    ),
                  },
                );
                setCreating(false);
                setEditing(null);
                setSelected(editing?.id ?? result.id!);
                await onChanged();
              } catch (error) {
                setError(error instanceof Error ? error.message : 'Unable to save portfolio.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Portfolio name
              <Input
                value={name}
                required
                minLength={2}
                maxLength={160}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {!editing ? (
              <label>
                Portfolio audience
                <NativeSelect
                  value={scope}
                  onChange={(event) => {
                    setScope(event.target.value);
                    setIds([]);
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
            ) : null}
            <fieldset>
              <legend>Projects in portfolio</legend>
              {projects.items.map((project) => (
                <label className="checkbox-label" key={project.id}>
                  <Input
                    type="checkbox"
                    checked={ids.includes(project.id)}
                    onChange={(event) =>
                      setIds((v) =>
                        event.target.checked
                          ? [...v, project.id]
                          : v.filter((id) => id !== project.id),
                      )
                    }
                  />
                  {project.name}
                </label>
              ))}
            </fieldset>
            <PageControls {...projects} onMore={projects.more} />
            <Button size="sm" className="primary small" disabled={busy}>
              Save portfolio
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              Cancel portfolio edit
            </Button>
          </form>
        </Card>
      ) : null}
    </section>
  );
}
