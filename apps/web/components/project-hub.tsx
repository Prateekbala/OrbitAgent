'use client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Card } from './ui/card';
import { ProjectReporting } from './project-reporting';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Channel,
  Member,
  Project,
  ProjectDetails,
  ProjectPage,
  Milestone,
  MilestonePage,
} from '@ao/contracts';
import { projectStates } from '@ao/contracts/projects';
import { api, HttpError } from '../lib/api';
import { ProjectEditor, MilestoneEditor } from './project-editors';
import { dueLabel } from '../lib/task-display';
export function ProjectHub({
  revision,
  me,
  members,
  channels,
  selectedId,
  onSelect,
  onTasks,
  onChanged,
}: {
  revision: number;
  me: Member;
  members: Member[];
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onTasks: (project: Project, milestone?: Milestone) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [items, setItems] = useState<Project[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [q, setQ] = useState(''),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState(''),
    [source, setSource] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [creating, setCreating] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (next: string | null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setError('');
      try {
        const params = new URLSearchParams({ q: query, limit: '30' });
        if (status) params.set('status', status);
        if (source === 'workspace') params.set('workspaceOnly', 'true');
        else if (source) params.set('conversationId', source);
        if (next) params.set('after', next);
        const page = await api<ProjectPage>(`/projects?${params}`, { signal: request.signal });
        if (!request.signal.aborted) {
          setItems((old) =>
            next
              ? [...new Map([...old, ...page.items].map((p) => [p.id, p])).values()]
              : page.items,
          );
          setAfter(page.next_after);
        }
      } catch (e) {
        if (!request.signal.aborted) {
          setItems([]);
          setAfter(null);
          setError(e instanceof Error ? e.message : 'Unable to load projects.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [query, status, source],
  );
  useEffect(() => {
    setItems([]);
    setAfter(null);
    if (!selectedId) void load(null);
    return () => controller.current?.abort();
  }, [load, revision, selectedId]);
  if (selectedId)
    return (
      <ProjectDetail
        key={selectedId}
        id={selectedId}
        revision={revision}
        me={me}
        members={members}
        channels={channels}
        onBack={() => onSelect(null)}
        onTasks={onTasks}
        onChanged={onChanged}
      />
    );
  return (
    <section className="project-hub" aria-label="Projects">
      <div className="task-section-heading">
        <h3>Projects</h3>
        <Button size="sm" type="button" className="primary small" onClick={() => setCreating(true)}>
          New project
        </Button>
      </div>
      <p className="muted">Coordinate outcomes, milestones and progress within a fixed audience.</p>
      <form
        className="project-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <label>
          Find projects
          <Input
            aria-label="Find projects"
            value={q}
            maxLength={200}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label>
          Status
          <NativeSelect
            aria-label="Project status filter"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {projectStates.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          Audience
          <NativeSelect
            aria-label="Project audience filter"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">All accessible projects</option>
            <option value="workspace">Workspace only</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <Button variant="outline" type="submit">
          Find projects
        </Button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {items.map((project) => (
        <Card key={project.id} asChild>
          <article className="project-card">
            <div>
              <Button
                variant="ghost"
                type="button"
                className="task-title-button"
                onClick={() => onSelect(project.id)}
              >
                {project.name}
              </Button>
              <p>{project.description || 'No description yet.'}</p>
              <small>
                {project.owner_name} · {project.status} ·{' '}
                {project.conversation_id
                  ? (channels.find((c) => c.id === project.conversation_id)?.name ??
                    'Conversation audience')
                  : 'Workspace audience'}
              </small>
            </div>
            <ProjectProgress project={project} />
            {project.target_date && (
              <time dateTime={project.target_date}>Target {dueLabel(project.target_date)}</time>
            )}
          </article>
        </Card>
      ))}
      {busy && <p role="status">Loading projects…</p>}
      {!busy && !items.length && !error && (
        <p className="muted">No projects match these filters.</p>
      )}
      {after && (
        <Button variant="outline" type="button" disabled={busy} onClick={() => void load(after)}>
          Load more projects
        </Button>
      )}
      {creating && (
        <ProjectEditor
          me={me}
          members={members}
          channels={channels}
          onClose={() => setCreating(false)}
          onSaved={async (id) => {
            setCreating(false);
            onSelect(id);
            await onChanged();
          }}
        />
      )}
    </section>
  );
}
function ProjectProgress({
  project,
}: {
  project: Pick<Project, 'task_count' | 'completed_count' | 'cancelled_count' | 'overdue_count'>;
}) {
  return (
    <div className="project-progress">
      <progress
        aria-label="Project task completion"
        aria-valuetext={`${project.completed_count} of ${project.task_count} tasks completed`}
        max={Math.max(1, project.task_count)}
        value={project.completed_count}
      />
      <small>
        {project.completed_count}/{project.task_count} completed · {project.cancelled_count}{' '}
        cancelled{project.overdue_count > 0 ? ` · ${project.overdue_count} overdue (UTC)` : ''}
      </small>
    </div>
  );
}
function ProjectDetail({
  id,
  revision,
  me,
  members,
  channels,
  onBack,
  onTasks,
  onChanged,
}: {
  id: string;
  revision: number;
  me: Member;
  members: Member[];
  channels: Channel[];
  onBack: () => void;
  onTasks: (project: Project, milestone?: Milestone) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [data, setData] = useState<ProjectDetails | null>(null),
    [milestones, setMilestones] = useState<Milestone[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [editing, setEditing] = useState(false),
    [milestoneEdit, setMilestoneEdit] = useState<Milestone | 'new' | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const load = useCallback(
    async (next: string | null) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setError('');
      try {
        const [details, page] = await Promise.all([
          api<ProjectDetails>(`/projects/${id}`, { signal: request.signal }),
          api<MilestonePage>(`/projects/${id}/milestones?limit=30${next ? `&after=${next}` : ''}`, {
            signal: request.signal,
          }),
        ]);
        if (!request.signal.aborted) {
          setData(details);
          setMilestones((old) =>
            next
              ? [...new Map([...old, ...page.items].map((m) => [m.id, m])).values()]
              : page.items,
          );
          setAfter(page.next_after);
        }
      } catch (e) {
        if (!request.signal.aborted) {
          if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
            setData(null);
            setMilestones([]);
            setAfter(null);
            setEditing(false);
            setMilestoneEdit(null);
          }
          setError(e instanceof Error ? e.message : 'Unable to load project.');
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [id],
  );
  useEffect(() => {
    void load(null);
    return () => controller.current?.abort();
  }, [load, revision]);
  const project = data?.project;
  return (
    <section className="project-detail" aria-label="Project details">
      <Button variant="link" type="button" className="text-button" onClick={onBack}>
        ← All projects
      </Button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!project ? (
        <p role="status">{error ? 'Project unavailable.' : 'Loading project…'}</p>
      ) : (
        <>
          <div className="project-detail-heading">
            <div>
              <span className="eyebrow">
                {project.status} ·{' '}
                {project.conversation_id
                  ? (channels.find((c) => c.id === project.conversation_id)?.name ??
                    'Conversation audience')
                  : 'Workspace audience'}
              </span>
              <h3>{project.name}</h3>
              <p className="muted">
                Owner: {project.owner_name} · version {project.version}
              </p>
            </div>
            {data.can_manage && (
              <Button variant="outline" type="button" onClick={() => setEditing(true)}>
                Edit project
              </Button>
            )}
          </div>
          <p className="task-description">{project.description || 'No description yet.'}</p>
          <p className="muted">
            {project.start_date ? `Starts ${dueLabel(project.start_date)}` : 'No start date'} ·{' '}
            {project.target_date ? `Target ${dueLabel(project.target_date)}` : 'No target date'}
          </p>
          <ProjectProgress project={project} />
          <ProjectReporting id={project.id} revision={revision} />
          <Button variant="outline" type="button" onClick={() => onTasks(project)}>
            View project tasks
          </Button>
          <section className="task-section">
            <div className="task-section-heading">
              <h3>Milestones</h3>
              {data.can_manage && !['completed', 'archived'].includes(project.status) && (
                <Button variant="outline" type="button" onClick={() => setMilestoneEdit('new')}>
                  New milestone
                </Button>
              )}
            </div>
            {milestones.map((m) => (
              <Card key={m.id} asChild>
                <article className="milestone-card">
                  <div>
                    <h4>{m.title}</h4>
                    <p>{m.description || 'No description yet.'}</p>
                    <small>
                      {m.status} · {m.due_date ? dueLabel(m.due_date) : 'No due date'} · v
                      {m.version}
                    </small>
                  </div>
                  <div>
                    <progress
                      aria-label={`${m.title} task completion`}
                      aria-valuetext={`${m.completed_count} of ${m.task_count} tasks completed`}
                      max={Math.max(1, m.task_count)}
                      value={m.completed_count}
                    />
                    <small>
                      {m.completed_count}/{m.task_count} completed · {m.cancelled_count} cancelled
                    </small>
                  </div>
                  <div className="document-actions">
                    <Button variant="outline" type="button" onClick={() => onTasks(project, m)}>
                      View milestone tasks
                    </Button>
                    {data.can_manage && (
                      <Button
                        variant="outline"
                        type="button"
                        aria-label={`Edit milestone ${m.title}`}
                        onClick={() => setMilestoneEdit(m)}
                      >
                        Edit milestone
                      </Button>
                    )}
                  </div>
                </article>
              </Card>
            ))}
            {busy && <p role="status">Loading milestones…</p>}
            {!busy && !milestones.length && <p className="muted">No milestones yet.</p>}
            {after && (
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => void load(after)}
              >
                Load more milestones
              </Button>
            )}
          </section>
          {editing && data.can_manage && (
            <ProjectEditor
              key={`project-${project.id}`}
              project={project}
              onRefresh={onChanged}
              me={me}
              members={members}
              channels={channels}
              onClose={() => setEditing(false)}
              onSaved={async () => {
                if (alive.current) {
                  setEditing(false);
                  await onChanged();
                }
              }}
            />
          )}
          {milestoneEdit && data.can_manage && (
            <MilestoneEditor
              project={project}
              onRefresh={onChanged}
              milestone={milestoneEdit === 'new' ? null : milestoneEdit}
              latest={
                milestoneEdit === 'new'
                  ? null
                  : (milestones.find((m) => m.id === milestoneEdit.id) ?? null)
              }
              onClose={() => setMilestoneEdit(null)}
              onSaved={async () => {
                if (alive.current) {
                  setMilestoneEdit(null);
                  await onChanged();
                }
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
