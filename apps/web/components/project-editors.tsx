'use client';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import { Button } from './ui/button';
import { useEffect, useRef, useState } from 'react';
import type { Project, Milestone, Member, Channel } from '@ao/contracts';
import { projectStates, milestoneStates } from '@ao/contracts/projects';
import { api, post, HttpError } from '../lib/api';
import { useRequestIdentity } from '../lib/use-request-identity';
import { Dialog } from './dialog';
type ProjectDraft = {
  name: string;
  description: string;
  ownerId: string;
  status: Project['status'];
  startDate: string;
  targetDate: string;
  conversationId: string;
  version: number;
};
function projectDraft(project: Project | undefined, me: Member): ProjectDraft {
  return {
    name: project?.name ?? '',
    description: project?.description ?? '',
    ownerId: project?.owner_id ?? me.id,
    status: project?.status ?? 'planned',
    startDate: project?.start_date ?? '',
    targetDate: project?.target_date ?? '',
    conversationId: project?.conversation_id ?? '',
    version: project?.version ?? 0,
  };
}
export function ProjectEditor({
  project,
  me,
  members,
  channels,
  onClose,
  onSaved,
  onRefresh,
}: {
  project?: Project;
  me: Member;
  members: Member[];
  channels: Channel[];
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
  onRefresh?: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(() => projectDraft(project, me)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  const requestId = useRequestIdentity();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const input = {
        name: draft.name,
        description: draft.description,
        ownerId: draft.ownerId,
        status: draft.status,
        startDate: draft.startDate || null,
        targetDate: draft.targetDate || null,
      };
      const result = project
        ? await api<{ ok: true }>(`/projects/${project.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ...input, version: draft.version }),
          })
        : await post<{ id: string }>('/projects', {
            ...input,
            clientId: requestId({ ...input, conversationId: draft.conversationId }),
            ...(draft.conversationId ? { conversationId: draft.conversationId } : {}),
          });
      if (alive.current) await onSaved(project?.id ?? (result as { id: string }).id);
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to save project.');
        if (e instanceof HttpError && e.code === 'VERSION_CONFLICT') await onRefresh?.();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      title={project ? 'Edit project' : 'New project'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="organization-form" onSubmit={(e) => void save(e)}>
        {project && project.version !== draft.version && (
          <p role="status">This project changed. Cancel and reopen to review the latest version.</p>
        )}
        <label>
          Project name
          <Input
            aria-label="Project name"
            required
            minLength={2}
            maxLength={160}
            value={draft.name}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          Description
          <Textarea
            aria-label="Project description"
            maxLength={12000}
            rows={4}
            value={draft.description}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
        {!project && (
          <label>
            Audience
            <NativeSelect
              aria-label="Project audience"
              value={draft.conversationId}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, conversationId: e.target.value })}
            >
              <option value="">Entire workspace</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.visibility === 'private' ? ' · Private' : ''}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        <p className="muted">
          The project and all assigned tasks retain the same audience. The audience cannot be
          changed later.
        </p>
        <label>
          Owner
          <NativeSelect
            aria-label="Project owner"
            value={draft.ownerId}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, ownerId: e.target.value })}
          >
            {members
              .filter((m) => m.kind === 'human')
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            {!members.some((m) => m.id === draft.ownerId) && (
              <option value={draft.ownerId}>{project?.owner_name ?? 'Current owner'}</option>
            )}
          </NativeSelect>
        </label>
        <label>
          Status
          <NativeSelect
            aria-label="Project status"
            value={draft.status}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as Project['status'] })}
          >
            {projectStates.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </NativeSelect>
        </label>
        <div className="task-form-columns">
          <label>
            Start date
            <Input
              aria-label="Project start date"
              type="date"
              min="0001-01-01"
              max="9999-12-31"
              value={draft.startDate}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
            />
          </label>
          <label>
            Target date
            <Input
              aria-label="Project target date"
              type="date"
              min={draft.startDate || '0001-01-01'}
              max="9999-12-31"
              value={draft.targetDate}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, targetDate: e.target.value })}
            />
          </label>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button
          size="sm"
          className="primary small"
          disabled={busy || Boolean(project && project.version !== draft.version)}
        >
          {project ? 'Save project' : 'Create project'}
        </Button>
      </form>
    </Dialog>
  );
}
export function MilestoneEditor({
  project,
  milestone,
  latest,
  onClose,
  onSaved,
  onRefresh,
}: {
  project: Project;
  milestone: Milestone | null;
  latest: Milestone | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onRefresh?: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(() => ({
      title: milestone?.title ?? '',
      description: milestone?.description ?? '',
      status: milestone?.status ?? 'planned',
      dueDate: milestone?.due_date ?? '',
      version: milestone?.version ?? 0,
    })),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  const requestId = useRequestIdentity();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const input = {
        title: draft.title,
        description: draft.description,
        status: draft.status,
        dueDate: draft.dueDate || null,
      };
      if (milestone)
        await api(`/projects/${project.id}/milestones/${milestone.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...input, version: draft.version }),
        });
      else
        await post(`/projects/${project.id}/milestones`, { ...input, clientId: requestId(input) });
      if (alive.current) await onSaved();
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to save milestone.');
        if (e instanceof HttpError && e.code === 'VERSION_CONFLICT') await onRefresh?.();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const stale = Boolean(milestone && latest?.version !== draft.version);
  return (
    <Dialog
      title={milestone ? 'Edit milestone' : 'New milestone'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="organization-form" onSubmit={(e) => void save(e)}>
        {stale && (
          <p role="status">
            This milestone changed. Cancel and reopen to review its latest version.
          </p>
        )}
        <label>
          Title
          <Input
            aria-label="Milestone title"
            required
            minLength={2}
            maxLength={160}
            value={draft.title}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label>
          Description
          <Textarea
            aria-label="Milestone description"
            maxLength={12000}
            rows={3}
            value={draft.description}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
        <label>
          Due date
          <Input
            aria-label="Milestone due date"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            value={draft.dueDate}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
          />
        </label>
        <label>
          Status
          <NativeSelect
            aria-label="Milestone status"
            value={draft.status}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as Milestone['status'] })}
          >
            {milestoneStates.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </NativeSelect>
        </label>
        <p className="muted">
          Completed milestones require all assigned tasks to be completed or cancelled.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button size="sm" className="primary small" disabled={busy || stale}>
          {milestone ? 'Save milestone' : 'Create milestone'}
        </Button>
      </form>
    </Dialog>
  );
}
