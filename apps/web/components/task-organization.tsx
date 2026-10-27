'use client';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useEffect, useRef, useState } from 'react';
import type { Task, TaskLabelRef } from '@ao/contracts';
import { api } from '../lib/api';
import { ProjectPicker, MilestoneSelect, LabelPicker } from './organization-pickers';
import type { TaskFilters } from '../lib/task-filters';
export type OrganizationChoice = {
  projectId: string;
  projectName: string;
  milestoneId: string;
  milestoneTitle: string;
  labels: TaskLabelRef[];
};
export const emptyOrganization: OrganizationChoice = {
  projectId: '',
  projectName: '',
  milestoneId: '',
  milestoneTitle: '',
  labels: [],
};
export function TaskBadges({
  task,
}: {
  task: Pick<Task, 'project_name' | 'milestone_title' | 'labels'>;
}) {
  return (
    <div className="task-organization-badges">
      {task.project_name && (
        <Badge variant="outline" className="project-badge">
          {task.project_name}
          {task.milestone_title ? ` / ${task.milestone_title}` : ''}
        </Badge>
      )}
      {task.labels.map((label) => (
        <Badge
          variant="outline"
          key={label.id}
          className={`work-label label-${label.color}`}
          title={label.archived ? 'Archived label' : undefined}
        >
          {label.name}
          {label.archived ? ' · Archived' : ''}
        </Badge>
      ))}
    </div>
  );
}
export function TaskOrganizationFields({
  source,
  value,
  onChange,
  disabled = false,
}: {
  source: string | null;
  value: OrganizationChoice;
  onChange: (value: OrganizationChoice) => void;
  disabled?: boolean;
}) {
  const [projects, setProjects] = useState(false),
    [labels, setLabels] = useState(false);
  return (
    <div className="organization-fields">
      <div className="document-actions">
        <span>
          Project: <strong>{value.projectName || 'None'}</strong>
        </span>
        <Button
          variant="outline"
          type="button"
          disabled={disabled}
          onClick={() => setProjects((v) => !v)}
        >
          Choose project
        </Button>
        {value.projectId && (
          <Button
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...value,
                projectId: '',
                projectName: '',
                milestoneId: '',
                milestoneTitle: '',
              })
            }
          >
            Clear project
          </Button>
        )}
      </div>
      {projects && (
        <ProjectPicker
          source={source}
          disabled={disabled}
          onPick={(project) => {
            onChange({
              ...value,
              projectId: project.id,
              projectName: project.name,
              milestoneId: '',
              milestoneTitle: '',
            });
            setProjects(false);
          }}
        />
      )}
      {value.projectId && (
        <MilestoneSelect
          key={value.projectId}
          projectId={value.projectId}
          value={value.milestoneId}
          title={value.milestoneTitle}
          disabled={disabled}
          onChange={(m) =>
            onChange({ ...value, milestoneId: m?.id ?? '', milestoneTitle: m?.title ?? '' })
          }
        />
      )}
      <div className="organization-label-selection">
        {value.labels.map((l) => (
          <Button
            variant="outline"
            type="button"
            className={`work-label label-${l.color}`}
            key={l.id}
            disabled={disabled}
            aria-label={`Remove label ${l.name}`}
            onClick={() =>
              onChange({ ...value, labels: value.labels.filter((label) => label.id !== l.id) })
            }
          >
            {l.name} ×
          </Button>
        ))}
      </div>
      <Button
        variant="outline"
        type="button"
        disabled={disabled}
        onClick={() => setLabels((v) => !v)}
      >
        Choose labels
      </Button>
      {labels && (
        <LabelPicker
          selected={value.labels}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, labels: next })}
        />
      )}
    </div>
  );
}
export function TaskOrganizationPanel({
  task,
  canManage,
  onChanged,
}: {
  task: Task;
  canManage: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<(OrganizationChoice & { version: number }) | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!canManage) setDraft(null);
  }, [canManage]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: draft.version,
          projectId: draft.projectId || null,
          milestoneId: draft.milestoneId || null,
          labelIds: draft.labels.map((l) => l.id),
        }),
      });
      if (alive.current) {
        setDraft(null);
        await onChanged();
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Unable to organize task.');
        await onChanged();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="task-section task-organization">
      <h3>Project, milestone and labels</h3>
      <TaskBadges task={task} />
      {!task.project_id && !task.labels.length && (
        <p className="muted">No project or labels assigned.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {canManage &&
        (draft ? (
          <form onSubmit={(e) => void save(e)} className="task-edit-form">
            {draft.version !== task.version && (
              <p role="status">
                This task changed. Cancel and reopen organization settings to review the latest
                version.
              </p>
            )}
            <TaskOrganizationFields
              source={task.conversation_id}
              value={draft}
              disabled={busy}
              onChange={(next) => setDraft({ ...next, version: draft.version })}
            />
            <div className="document-actions">
              <Button
                size="sm"
                className="primary small"
                disabled={busy || draft.version !== task.version}
              >
                Save task organization
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                Cancel organization edit
              </Button>
            </div>
          </form>
        ) : (
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              setError('');
              setDraft({
                version: task.version,
                projectId: task.project_id ?? '',
                projectName: task.project_name ?? '',
                milestoneId: task.milestone_id ?? '',
                milestoneTitle: task.milestone_title ?? '',
                labels: task.labels,
              });
            }}
          >
            Edit task organization
          </Button>
        ))}
    </section>
  );
}
export function OrganizationFilters({
  value,
  onChange,
}: {
  value: TaskFilters;
  onChange: (value: TaskFilters) => void;
}) {
  const [projects, setProjects] = useState(false),
    [labels, setLabels] = useState(false);
  return (
    <div className="organization-filter-fields">
      <div className="document-actions">
        <span>Project: {value.projectName || 'Any'}</span>
        <Button variant="outline" type="button" onClick={() => setProjects((v) => !v)}>
          Filter by project
        </Button>
        {value.projectId && (
          <Button
            variant="outline"
            type="button"
            onClick={() =>
              onChange({
                ...value,
                projectId: '',
                projectName: '',
                milestoneId: '',
                milestoneTitle: '',
              })
            }
          >
            Clear project filter
          </Button>
        )}
        <span>Label: {value.labelName || 'Any'}</span>
        <Button variant="outline" type="button" onClick={() => setLabels((v) => !v)}>
          Filter by label
        </Button>
        {value.labelId && (
          <Button
            variant="outline"
            type="button"
            onClick={() => onChange({ ...value, labelId: '', labelName: '' })}
          >
            Clear label filter
          </Button>
        )}
      </div>
      {projects && (
        <ProjectPicker
          allowClosed
          onPick={(project) => {
            onChange({
              ...value,
              projectId: project.id,
              projectName: project.name,
              milestoneId: '',
              milestoneTitle: '',
            });
            setProjects(false);
          }}
        />
      )}
      {value.projectId && (
        <MilestoneSelect
          key={value.projectId}
          projectId={value.projectId}
          value={value.milestoneId ?? ''}
          title={value.milestoneTitle ?? ''}
          allowClosed
          onChange={(m) =>
            onChange({ ...value, milestoneId: m?.id ?? '', milestoneTitle: m?.title ?? '' })
          }
        />
      )}
      {labels && (
        <LabelPicker
          selected={
            value.labelId
              ? [{ id: value.labelId, name: value.labelName ?? '', color: 'sage', archived: false }]
              : []
          }
          single
          onChange={(next) => {
            const label = next[0];
            onChange({ ...value, labelId: label?.id ?? '', labelName: label?.name ?? '' });
            setLabels(false);
          }}
        />
      )}
    </div>
  );
}
