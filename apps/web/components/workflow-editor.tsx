'use client';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { useRef, useState } from 'react';
import type { Agent, Channel, Member } from '@ao/contracts';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkTemplate,
  BusinessCalendar,
} from '@ao/contracts/workflows';
import { templateDefinition } from '@ao/contracts/workflows';
import { api } from '../lib/api';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
import { Dialog } from './dialog';
const titles = {
  create_task: 'Create a task',
  transition_task: 'Change task state',
  wait_for_task: 'Wait for a task',
  approval: 'Request human approval',
  run_agent: 'Run an agent',
};
function newStep(type: WorkflowStep['type'], key: string): WorkflowStep {
  if (type === 'create_task')
    return { key, type, title: '', description: '', priority: 'normal', criteria: [] };
  if (type === 'transition_task')
    return { key, type, target: 'source', state: 'queued', evidence: '' };
  if (type === 'wait_for_task') return { key, type, target: 'source', states: ['completed'] };
  if (type === 'approval') return { key, type, instructions: '' };
  return { key, type, target: 'source', agentId: '', prompt: '' };
}
export function WorkflowEditor({
  template,
  members,
  channels,
  onClose,
  onSaved,
}: {
  template?: WorkTemplate | undefined;
  members: Member[];
  channels: Channel[];
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(template?.name ?? ''),
    [kind, setKind] = useState<'task' | 'workflow'>(template?.kind ?? 'workflow'),
    [conversation, setConversation] = useState(template?.conversation_id ?? ''),
    [definition, setDefinition] = useState<WorkflowDefinition>(
      template?.definition ?? { steps: [newStep('create_task', 'step_1')], timeoutMinutes: 1440 },
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const agents = useCursorPage<Agent>('workflow-editor', '/collections/agents'),
    calendars = useCursorPage<BusinessCalendar>('workflow-editor', '/business-calendars');
  function update(index: number, step: WorkflowStep) {
    setDefinition((v) => ({ ...v, steps: v.steps.map((old, i) => (i === index ? step : old)) }));
  }
  return (
    <Dialog title={template ? 'Create template revision' : 'New work template'} onClose={onClose}>
      <form
        className="workflow-editor"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const parsed = templateDefinition.parse({
                ...definition,
                steps: definition.steps.map((step) =>
                  step.type === 'create_task'
                    ? {
                        ...step,
                        criteria: step.criteria.map((text) => text.trim()).filter(Boolean),
                      }
                    : step,
                ),
              }),
              result = await api<{ id?: string }>(
                template ? `/work-templates/${template.id}/revisions` : '/work-templates',
                {
                  method: 'POST',
                  body: JSON.stringify(
                    template
                      ? { version: template.version, name, definition: parsed }
                      : {
                          clientId: requestId.current,
                          name,
                          kind,
                          ...(conversation ? { conversationId: conversation } : {}),
                          definition: parsed,
                        },
                  ),
                },
              );
            await onSaved(template?.id ?? result.id!);
          } catch (error) {
            setError(error instanceof Error ? error.message : 'Unable to save the template.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Template name
          <Input
            value={name}
            required
            minLength={2}
            maxLength={160}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {!template ? (
          <>
            <label>
              Template type
              <NativeSelect
                aria-label="Template type"
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                <option value="workflow">Workflow</option>
                <option value="task">Task template</option>
              </NativeSelect>
            </label>
            <label>
              Template audience
              <NativeSelect
                aria-label="Template audience"
                value={conversation}
                onChange={(event) => setConversation(event.target.value)}
              >
                <option value="">Workspace</option>
                {channels
                  .filter((c) => !c.archived_at)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </NativeSelect>
            </label>
          </>
        ) : (
          <p className="muted">
            Saving creates an immutable revision. Existing runs keep their starting revision.
          </p>
        )}
        {definition.steps.map((step, index) => (
          <fieldset className="workflow-step-editor" key={step.key}>
            <legend>Step {index + 1}</legend>
            <label>
              Step action
              <NativeSelect
                aria-label="Step action"
                value={step.type}
                onChange={(event) =>
                  update(index, newStep(event.target.value as WorkflowStep['type'], step.key))
                }
              >
                {Object.entries(titles)
                  .filter(([type]) => kind === 'workflow' || type === 'create_task')
                  .map(([type, title]) => (
                    <option key={type} value={type}>
                      {title}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            {'target' in step ? (
              <label>
                Task to use
                <NativeSelect
                  aria-label="Task to use"
                  value={step.target}
                  onChange={(event) => update(index, { ...step, target: event.target.value })}
                >
                  <option value="source">Source task</option>
                  {definition.steps
                    .slice(0, index)
                    .filter((s) => s.type === 'create_task')
                    .map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.type === 'create_task'
                          ? s.title || `Step ${definition.steps.indexOf(s) + 1}`
                          : s.key}
                      </option>
                    ))}
                </NativeSelect>
              </label>
            ) : null}
            {step.type === 'create_task' ? (
              <>
                <label>
                  New task title
                  <Input
                    value={step.title}
                    required
                    minLength={3}
                    maxLength={200}
                    onChange={(event) => update(index, { ...step, title: event.target.value })}
                  />
                </label>
                <label>
                  Task description
                  <Textarea
                    value={step.description}
                    maxLength={12000}
                    onChange={(event) =>
                      update(index, { ...step, description: event.target.value })
                    }
                  />
                </label>
                <label>
                  Task owner
                  <NativeSelect
                    aria-label="Task owner"
                    value={step.assigneeId ?? ''}
                    onChange={(event) => {
                      const { assigneeId: _old, ...rest } = step;
                      update(
                        index,
                        event.target.value ? { ...rest, assigneeId: event.target.value } : rest,
                      );
                    }}
                  >
                    <option value="">Unassigned</option>
                    {members
                      .filter((m) => m.status !== 'suspended')
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
                <label>
                  Task priority
                  <NativeSelect
                    aria-label="Task priority"
                    value={step.priority}
                    onChange={(event) =>
                      update(index, {
                        ...step,
                        priority: event.target.value as typeof step.priority,
                      })
                    }
                  >
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </NativeSelect>
                </label>
                <label>
                  Due days after execution
                  <Input
                    type="number"
                    min={0}
                    max={366}
                    value={step.dueDays ?? ''}
                    onChange={(event) => {
                      const { dueDays: _old, ...rest } = step;
                      update(
                        index,
                        event.target.value === ''
                          ? rest
                          : { ...rest, dueDays: Number(event.target.value) },
                      );
                    }}
                  />
                </label>
                <label>
                  Count days with
                  <NativeSelect
                    aria-label="Count days with"
                    value={step.businessCalendarId ?? ''}
                    onChange={(event) => {
                      const { businessCalendarId: _old, ...rest } = step;
                      update(
                        index,
                        event.target.value
                          ? { ...rest, businessCalendarId: event.target.value }
                          : rest,
                      );
                    }}
                  >
                    <option value="">Calendar days</option>
                    {calendars.items.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  Acceptance criteria, one per line
                  <Textarea
                    value={step.criteria.join('\n')}
                    maxLength={20000}
                    onChange={(event) =>
                      update(index, { ...step, criteria: event.target.value.split('\n') })
                    }
                  />
                </label>
                <label>
                  Parent task from earlier step
                  <NativeSelect
                    aria-label="Parent task from earlier step"
                    value={step.parentStep ?? ''}
                    onChange={(event) => {
                      const { parentStep: _old, ...rest } = step;
                      update(
                        index,
                        event.target.value ? { ...rest, parentStep: event.target.value } : rest,
                      );
                    }}
                  >
                    <option value="">No parent</option>
                    {definition.steps
                      .slice(0, index)
                      .filter((s) => s.type === 'create_task')
                      .map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.type === 'create_task' ? s.title : s.key}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
              </>
            ) : null}
            {step.type === 'approval' ? (
              <label>
                Approval instructions
                <Textarea
                  required
                  value={step.instructions}
                  maxLength={4000}
                  onChange={(event) => update(index, { ...step, instructions: event.target.value })}
                />
              </label>
            ) : null}
            {step.type === 'transition_task' ? (
              <label>
                Next task state
                <NativeSelect
                  aria-label="Next task state"
                  value={step.state}
                  onChange={(event) =>
                    update(index, { ...step, state: event.target.value as typeof step.state })
                  }
                >
                  {['queued', 'active', 'blocked', 'awaiting_review', 'cancelled'].map((state) => (
                    <option key={state} value={state}>
                      {state.replaceAll('_', ' ')}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            ) : null}
            {step.type === 'wait_for_task' ? (
              <label>
                Wait until
                <NativeSelect
                  aria-label="Wait until"
                  value={step.states[0]}
                  onChange={(event) =>
                    update(index, {
                      ...step,
                      states: [event.target.value as (typeof step.states)[number]],
                    })
                  }
                >
                  {[
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
            ) : null}
            {step.type === 'run_agent' ? (
              <>
                <label>
                  Workflow agent
                  <NativeSelect
                    aria-label="Workflow agent"
                    required
                    value={step.agentId}
                    onChange={(event) => update(index, { ...step, agentId: event.target.value })}
                  >
                    <option value="">Choose an agent</option>
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
                  Agent instructions
                  <Textarea
                    required
                    maxLength={12000}
                    value={step.prompt}
                    onChange={(event) => update(index, { ...step, prompt: event.target.value })}
                  />
                </label>
              </>
            ) : null}
            <Button
              variant="outline"
              type="button"
              disabled={definition.steps.length === 1}
              onClick={() =>
                setDefinition((v) => ({ ...v, steps: v.steps.filter((_, i) => i !== index) }))
              }
            >
              Remove step {index + 1}
            </Button>
          </fieldset>
        ))}
        <Button
          variant="outline"
          type="button"
          disabled={definition.steps.length >= 50}
          onClick={() =>
            setDefinition((v) => ({
              ...v,
              steps: [
                ...v.steps,
                newStep('create_task', 'step_' + crypto.randomUUID().replaceAll('-', '')),
              ],
            }))
          }
        >
          Add workflow step
        </Button>
        <label>
          Workflow deadline in minutes
          <Input
            type="number"
            min={1}
            max={10080}
            value={definition.timeoutMinutes}
            onChange={(event) =>
              setDefinition((v) => ({ ...v, timeoutMinutes: Number(event.target.value) }))
            }
          />
        </label>
        <label>
          Escalate failures to
          <NativeSelect
            aria-label="Escalate failures to"
            value={definition.escalationMemberId ?? ''}
            onChange={(event) => {
              const { escalationMemberId: _old, ...rest } = definition;
              setDefinition(
                event.target.value ? { ...rest, escalationMemberId: event.target.value } : rest,
              );
            }}
          >
            <option value="">Workflow owner</option>
            {members
              .filter((m) => m.kind === 'human' && m.status !== 'suspended')
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </NativeSelect>
        </label>
        <PageControls {...agents} onMore={agents.more} />
        <PageControls {...calendars} onMore={calendars.more} />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <Button className="primary" disabled={busy}>
          {template ? 'Save new revision' : 'Create template'}
        </Button>
      </form>
    </Dialog>
  );
}
