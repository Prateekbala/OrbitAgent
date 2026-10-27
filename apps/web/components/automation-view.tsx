'use client';
import { WorkspaceHeading } from './workspace-heading';
import { Workflow } from 'lucide-react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { useEffect, useRef, useState } from 'react';
import type { Agent, Bootstrap } from '@ao/contracts';
import type { AutomationDefinition } from '@ao/contracts/automations';
import { automationDefinition } from '@ao/contracts/automations';
import { api, post } from '../lib/api';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
import { Dialog } from './dialog';
interface Automation {
  id: string;
  name: string;
  owner_id: string;
  conversation_id: string;
  revision: number;
  version: number;
  status: string;
  next_at: string | null;
  transfer_to: string | null;
  definition: AutomationDefinition;
  upcoming: string[];
  report?: {
    occurrences: number;
    failures: number;
    suppressed: number;
    spent_or_reserved_micros: string;
  };
}
interface Occurrence {
  id: string;
  status: string;
  reason: string | null;
  suppression_reason?: string | null;
  revision: number;
  scheduled_at: string;
  agent_run_id: string | null;
  workflow_run_id: string | null;
  replay_of: string | null;
}
interface Template {
  id: string;
  name: string;
  conversation_id: string | null;
  published_revision: number | null;
  archived: boolean;
}
export function AutomationView({ boot, initialId }: { boot: Bootstrap; initialId: string | null }) {
  const [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<Automation | null>(null),
    [editing, setEditing] = useState<Automation | 'new' | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const scope = boot.workspace.id + ':' + boot.me.id,
    page = useCursorPage<Automation>(scope, '/automations', revision);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (initialId) void open(initialId);
  }, [initialId]);
  const manage =
    boot.me.kind === 'human' &&
    boot.me.access_type !== 'guest' &&
    boot.me.access_type !== 'service' &&
    boot.me.permissions?.['execution.manage'] !== false;
  async function open(id: string) {
    request.current?.abort();
    const c = new AbortController();
    request.current = c;
    try {
      const detail = await api<Automation>('/automations/' + id, { signal: c.signal });
      if (!c.signal.aborted) setSelected(detail);
    } catch (e) {
      if (!c.signal.aborted) {
        setSelected(null);
        setError(e instanceof Error ? e.message : 'Automation unavailable.');
      }
    }
  }
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setRevision((v) => v + 1);
      if (selected) await open(selected.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The automation action failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="domain-view platform-view" aria-label="Automation platform">
      <WorkspaceHeading
        icon={Workflow}
        eyebrow="Let good work repeat"
        title="Workspace automations"
        description="Schedule recurring checks and event-driven workflows, with clear owners and visible history."
      />
      <div className="view-toolbar">
        <p>Recurring checks and workflows with explicit ownership and publication controls.</p>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setRevision((v) => v + 1);
            if (selected) void open(selected.id);
          }}
        >
          Refresh automations
        </Button>
        {manage && (
          <Button className="primary" onClick={() => setEditing('new')}>
            New automation
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="platform-columns">
        <div aria-label="Automation definitions">
          {page.items.map((a) => (
            <Card key={a.id} asChild>
              <article className="work-card">
                <Button variant="outline" onClick={() => void open(a.id)}>
                  {a.name}
                </Button>
                <p>
                  {a.status} · revision {a.revision} ·{' '}
                  {boot.members.find((m) => m.id === a.owner_id)?.name ?? 'Owner unavailable'}
                </p>
                {a.next_at && <small>Next: {new Date(a.next_at).toLocaleString()}</small>}
              </article>
            </Card>
          ))}
          {!page.items.length && !page.busy && (
            <p className="collection-empty">No automations yet.</p>
          )}
          <PageControls next={page.next} busy={page.busy} error={page.error} onMore={page.more} />
        </div>
        {selected && (
          <div className="platform-detail" aria-label="Automation details">
            <h2>{selected.name}</h2>
            <p>
              {selected.status} · revision {selected.revision}
            </p>
            <p>
              Destination:{' '}
              {boot.channels.find((c) => c.id === selected.conversation_id)?.name ?? 'Unavailable'}
            </p>
            <p>
              {selected.definition.trigger.kind === 'schedule'
                ? `${selected.definition.trigger.cron} · ${selected.definition.trigger.timezone} · ${selected.definition.trigger.missed.replace('_', ' ')}`
                : 'On ' + selected.definition.trigger.events.join(', ')}
            </p>
            <p>
              Overlap: {selected.definition.overlap} · concurrency {selected.definition.concurrency}{' '}
              · daily starts {selected.definition.maxRunsPerDay}
            </p>
            {manage &&
              (selected.owner_id === boot.me.id || ['owner', 'admin'].includes(boot.me.role)) && (
                <div className="action-row">
                  <Button variant="outline" disabled={busy} onClick={() => setEditing(selected)}>
                    Edit automation
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      selected.status === 'archived' ||
                      (selected.status !== 'active' && selected.owner_id !== boot.me.id)
                    }
                    onClick={() =>
                      void action(() =>
                        post('/automations/' + selected.id + '/control', {
                          version: selected.version,
                          action: selected.status === 'active' ? 'pause' : 'resume',
                        }),
                      )
                    }
                  >
                    {selected.status === 'active' ? 'Pause automation' : 'Resume automation'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || selected.status === 'archived'}
                    onClick={() =>
                      void action(() =>
                        post('/automations/' + selected.id + '/control', {
                          version: selected.version,
                          action: 'archive',
                        }),
                      )
                    }
                  >
                    Archive automation
                  </Button>
                </div>
              )}
            {selected.report && (
              <p>
                {selected.report.occurrences} occurrences · {selected.report.failures} failures ·{' '}
                {selected.report.suppressed} quiet results ·{' '}
                {selected.report.spent_or_reserved_micros} micro-units spent or reserved
              </p>
            )}
            <h3>Upcoming runs</h3>
            {selected.upcoming.length ? (
              <ol>
                {selected.upcoming.map((v) => (
                  <li key={v}>{new Date(v).toLocaleString()}</li>
                ))}
              </ol>
            ) : (
              <p>No scheduled occurrences while paused or using event rules.</p>
            )}
            {manage && selected.owner_id === boot.me.id && (
              <form
                className="platform-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void action(() =>
                    post('/automations/' + selected.id + '/transfer', {
                      version: selected.version,
                      membershipId: data.get('member'),
                    }),
                  );
                }}
              >
                <label>
                  New automation owner
                  <NativeSelect name="member" required defaultValue="">
                    <option value="" disabled>
                      Choose a member
                    </option>
                    {boot.members
                      .filter((m) => m.kind === 'human' && m.id !== boot.me.id)
                      .map((m) => (
                        <option value={m.id} key={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
                <Button variant="outline" disabled={busy}>
                  Offer ownership transfer
                </Button>
                <small>The automation pauses until the recipient accepts and reviews it.</small>
              </form>
            )}
            {selected.transfer_to === boot.me.id && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    post('/automations/' + selected.id + '/transfer/accept', {
                      version: selected.version,
                    }),
                  )
                }
              >
                Accept automation ownership
              </Button>
            )}
            <AutomationHistory
              key={selected.id + ':' + revision}
              scope={scope}
              automation={selected}
              manage={
                manage &&
                (selected.owner_id === boot.me.id || ['owner', 'admin'].includes(boot.me.role))
              }
              onAction={action}
            />
            <AutomationRevisions
              key={'versions:' + selected.id + ':' + revision}
              id={selected.id}
            />
          </div>
        )}
      </div>
      {editing && (
        <AutomationEditor
          key={editing === 'new' ? 'new' : editing.id + ':' + editing.version}
          boot={boot}
          current={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (id) => {
            setEditing(null);
            setRevision((v) => v + 1);
            await open(id);
          }}
        />
      )}
    </section>
  );
}
function AutomationHistory({
  scope,
  automation,
  manage,
  onAction,
}: {
  scope: string;
  automation: Automation;
  manage: boolean;
  onAction: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const page = useCursorPage<Occurrence>(scope, '/automations/' + automation.id + '/history');
  const [reason, setReason] = useState('');
  const keys = useRef<Record<string, { reason: string; key: string }>>({});
  const replay = (id: string) => {
    let request = keys.current[id];
    if (!request || request.reason !== reason) {
      request = { reason, key: crypto.randomUUID() };
      keys.current[id] = request;
    }
    return post('/automation-occurrences/' + id + '/replay', { clientId: request.key, reason });
  };
  return (
    <section aria-label="Automation run history">
      <h3>Run history</h3>
      <label>
        Replay reason
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </label>
      {page.items.map((r) => (
        <Card key={r.id} asChild>
          <article className="work-card">
            <strong>{r.status}</strong>
            <p>
              {new Date(r.scheduled_at).toLocaleString()} · revision {r.revision}
              {r.reason ? ' · ' + r.reason.replaceAll('_', ' ') : ''}
              {r.suppression_reason
                ? ' · Public update skipped: ' + r.suppression_reason.replaceAll('_', ' ')
                : ''}
            </p>
            {r.agent_run_id && <small>Hosted run {r.agent_run_id}</small>}
            {r.workflow_run_id && <small>Workflow {r.workflow_run_id}</small>}
            {manage &&
              automation.status === 'active' &&
              ['failed', 'cancelled', 'succeeded', 'skipped'].includes(r.status) && (
                <Button
                  variant="outline"
                  disabled={reason.trim().length < 3}
                  onClick={() => void onAction(() => replay(r.id))}
                >
                  Replay occurrence
                </Button>
              )}
          </article>
        </Card>
      ))}
      {!page.items.length && <p>No runs recorded.</p>}
      <PageControls next={page.next} busy={page.busy} error={page.error} onMore={page.more} />
    </section>
  );
}
function AutomationRevisions({ id }: { id: string }) {
  const [items, setItems] = useState<{ revision: number; created_at: string }[]>([]),
    [before, setBefore] = useState<number | null>(null),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  async function load(cursor?: number) {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    try {
      const p = await api<{ items: typeof items; next_before: number | null }>(
        '/automations/' + id + '/revisions?limit=10' + (cursor ? '&before=' + cursor : ''),
        { signal: c.signal },
      );
      if (!c.signal.aborted) {
        setItems((old) => (cursor ? [...old, ...p.items] : p.items));
        setBefore(p.next_before);
      }
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : 'Revision history unavailable.');
    }
  }
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [id]);
  return (
    <section aria-label="Automation revision history">
      <h3>Version history</h3>
      {items.map((v) => (
        <p key={v.revision}>
          Revision {v.revision} · {new Date(v.created_at).toLocaleString()}
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
      {before && (
        <Button variant="outline" onClick={() => void load(before)}>
          Earlier revisions
        </Button>
      )}
    </section>
  );
}
function AutomationEditor({
  boot,
  current,
  onClose,
  onSaved,
}: {
  boot: Bootstrap;
  current: Automation | null;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const d = current?.definition,
    [trigger, setTrigger] = useState<'schedule' | 'event'>(d?.trigger.kind ?? 'schedule'),
    [kind, setKind] = useState<'agent' | 'workflow'>(d?.action.kind ?? 'agent'),
    [conversation, setConversation] = useState(
      d?.conversationId ?? boot.channels.find((c) => !c.archived_at)?.id ?? '',
    ),
    [agents, setAgents] = useState<Agent[]>([]),
    [templates, setTemplates] = useState<Template[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [clientId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    const c = new AbortController();
    void Promise.all([
      api<Agent[]>('/agents', { signal: c.signal }),
      api<{ items: Template[] }>('/work-templates?limit=100', { signal: c.signal }),
    ])
      .then(([a, t]) => {
        if (!c.signal.aborted) {
          setAgents(a);
          setTemplates(t.items);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e instanceof Error ? e.message : 'Actions unavailable.');
      });
    return () => c.abort();
  }, []);
  const schedule = d?.trigger.kind === 'schedule' ? d.trigger : null,
    quiet = d?.participation.quietHours;
  return (
    <Dialog title={current ? 'Edit automation' : 'New automation'} onClose={onClose}>
      <form
        className="platform-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          const v = new FormData(e.currentTarget),
            number = (key: string) => Number(v.get(key));
          try {
            const agent = agents.find((a) => a.id === v.get('agent')),
              template = templates.find((t) => t.id === v.get('template'));
            const definition = automationDefinition.parse({
              conversationId: conversation,
              trigger:
                trigger === 'schedule'
                  ? {
                      kind: trigger,
                      cron: v.get('cron'),
                      timezone: v.get('timezone'),
                      dst: v.get('dst'),
                      missed: v.get('missed'),
                      catchUpLimit: number('catchUpLimit'),
                      graceSeconds: number('graceSeconds'),
                    }
                  : {
                      kind: trigger,
                      events: v.getAll('events'),
                      ignoreOwner: v.get('ignoreOwner') === 'on',
                    },
              action:
                kind === 'agent'
                  ? {
                      kind,
                      agentId: agent?.id,
                      agentRevision: agent?.revision ?? 1,
                      prompt: v.get('prompt'),
                    }
                  : {
                      kind,
                      templateId: template?.id,
                      revision: template?.published_revision,
                      ...(v.get('sourceTaskId') ? { sourceTaskId: v.get('sourceTaskId') } : {}),
                      ...(d?.action.kind === 'workflow' && d.action.projectId
                        ? { projectId: d.action.projectId }
                        : {}),
                    },
              overlap: v.get('overlap'),
              concurrency: number('concurrency'),
              maxDailySpendMicros: number('maxDailySpendMicros'),
              maxRunsPerDay: number('maxRunsPerDay'),
              timeoutMinutes: number('timeoutMinutes'),
              ...(v.get('escalation') ? { escalationMemberId: v.get('escalation') } : {}),
              participation: {
                enabled: v.get('participation') === 'on',
                onlyMeaningfulChanges: v.get('meaningful') === 'on',
                cooldownMinutes: number('cooldown'),
                maxPublicationsPerDay: number('publications'),
                ...(v.get('quiet') === 'on'
                  ? {
                      quietHours: {
                        timezone: v.get('quietTimezone'),
                        startHour: number('quietStart'),
                        endHour: number('quietEnd'),
                      },
                    }
                  : {}),
              },
            });
            const result = await post<{ id?: string }>(
              current ? '/automations/' + current.id + '/revisions' : '/automations',
              {
                name: v.get('name'),
                definition,
                ...(current ? { version: current.version } : { clientId }),
              },
            );
            await onSaved(current?.id ?? result.id!);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Automation could not be saved.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Definitions start paused. Review the destination, grants and upcoming times before
          resuming.
        </p>
        <label>
          Automation name
          <Input name="name" defaultValue={current?.name} required minLength={2} maxLength={120} />
        </label>
        <label>
          Automation destination
          <NativeSelect
            aria-label="Automation destination"
            value={conversation}
            onChange={(e) => setConversation(e.target.value)}
            required
          >
            {boot.channels
              .filter((c) => !c.archived_at)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </NativeSelect>
        </label>
        <label>
          Trigger
          <NativeSelect
            value={trigger}
            onChange={(e) => setTrigger(e.target.value as typeof trigger)}
          >
            <option value="schedule">Schedule</option>
            <option value="event">Event rule</option>
          </NativeSelect>
        </label>
        {trigger === 'schedule' ? (
          <fieldset>
            <legend>Schedule policy</legend>
            <label>
              Cron schedule
              <Input
                name="cron"
                defaultValue={schedule?.cron ?? '0 9 * * 1-5'}
                required
                placeholder="0 9 * * 1-5"
              />
            </label>
            <small>Minute, hour, day of month, month, weekday.</small>
            <label>
              Schedule timezone
              <Input
                name="timezone"
                defaultValue={
                  schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
                }
                required
              />
            </label>
            <label>
              DST gaps
              <NativeSelect name="dst" defaultValue={schedule?.dst ?? 'skip_gap'}>
                <option value="skip_gap">Skip nonexistent times</option>
                <option value="shift_gap">Shift past the gap</option>
              </NativeSelect>
            </label>
            <p>Repeated wall times run once on the first occurrence.</p>
            <label>
              Missed runs
              <NativeSelect name="missed" defaultValue={schedule?.missed ?? 'coalesce'}>
                <option value="skip">Skip</option>
                <option value="coalesce">Coalesce into one check</option>
                <option value="catch_up">Bounded catch-up</option>
              </NativeSelect>
            </label>
            <label>
              Catch-up limit
              <Input
                type="number"
                name="catchUpLimit"
                defaultValue={schedule?.catchUpLimit ?? 3}
                min={1}
                max={10}
                required
              />
            </label>
            <label>
              Missed-run grace in seconds
              <Input
                type="number"
                name="graceSeconds"
                defaultValue={schedule?.graceSeconds ?? 300}
                min={60}
                max={86400}
                required
              />
            </label>
          </fieldset>
        ) : (
          <fieldset>
            <legend>Trigger events</legend>
            {[
              'message.created',
              'message.updated',
              'task.created',
              'task.updated',
              'task.transitioned',
              'task.comment_created',
              'knowledge.created',
              'knowledge.updated',
              'connection.resource_imported',
            ].map((event) => (
              <label key={event}>
                <Input
                  type="checkbox"
                  name="events"
                  value={event}
                  defaultChecked={
                    d?.trigger.kind === 'event'
                      ? d.trigger.events.includes(event as never)
                      : event === 'message.created'
                  }
                />
                {event.replaceAll('.', ' ')}
              </label>
            ))}
            <label>
              <Input
                type="checkbox"
                name="ignoreOwner"
                defaultChecked={d?.trigger.kind === 'event' && d.trigger.ignoreOwner}
              />
              Ignore the owner’s own events
            </label>
          </fieldset>
        )}
        <label>
          Automation action
          <NativeSelect
            aria-label="Automation action"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="agent">Hosted agent check</option>
            <option value="workflow">Recurring workflow</option>
          </NativeSelect>
        </label>
        {kind === 'agent' ? (
          <>
            <label>
              Automation agent
              <NativeSelect
                aria-label="Automation agent"
                name="agent"
                defaultValue={d?.action.kind === 'agent' ? d.action.agentId : ''}
                required
              >
                <option value="" disabled>
                  Choose a managed agent
                </option>
                {agents
                  .filter((a) => a.runtime === 'managed' && a.status === 'active')
                  .map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.name} · revision {a.revision ?? 1}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            <label>
              Check instructions
              <Textarea
                name="prompt"
                defaultValue={d?.action.kind === 'agent' ? d.action.prompt : ''}
                required
                maxLength={12000}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Automation workflow
              <NativeSelect
                aria-label="Automation workflow"
                name="template"
                defaultValue={d?.action.kind === 'workflow' ? d.action.templateId : ''}
                required
              >
                <option value="" disabled>
                  Choose a published workflow
                </option>
                {templates
                  .filter(
                    (t) =>
                      !t.archived && t.published_revision && t.conversation_id === conversation,
                  )
                  .map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.name} · revision {t.published_revision}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            <AutomationSourceTask
              conversation={conversation}
              initial={d?.action.kind === 'workflow' ? d.action.sourceTaskId : undefined}
            />
          </>
        )}
        <fieldset>
          <legend>Execution and escalation</legend>
          <label>
            Overlapping runs
            <NativeSelect name="overlap" defaultValue={d?.overlap ?? 'skip'}>
              <option value="skip">Skip overlapping checks</option>
              <option value="queue">Queue within the pending-run limit</option>
            </NativeSelect>
          </label>
          <label>
            Automation concurrency
            <Input
              type="number"
              name="concurrency"
              min={1}
              max={10}
              required
              defaultValue={d?.concurrency ?? 1}
            />
          </label>
          <label>
            Daily spending allowance in micro-units (UTC)
            <Input
              type="number"
              name="maxDailySpendMicros"
              min={0}
              max={1_000_000_000_000}
              required
              defaultValue={d?.maxDailySpendMicros ?? 5_000_000}
            />
          </label>
          <label>
            Daily run limit (UTC)
            <Input
              type="number"
              name="maxRunsPerDay"
              min={1}
              max={1440}
              required
              defaultValue={d?.maxRunsPerDay ?? 24}
            />
          </label>
          <label>
            Run deadline in minutes
            <Input
              type="number"
              name="timeoutMinutes"
              min={1}
              max={10080}
              required
              defaultValue={d?.timeoutMinutes ?? 60}
            />
          </label>
          <label>
            Escalation recipient
            <NativeSelect name="escalation" defaultValue={d?.escalationMemberId ?? ''}>
              <option value="">Automation owner</option>
              {boot.members
                .filter((m) => m.kind === 'human')
                .map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.name}
                  </option>
                ))}
            </NativeSelect>
          </label>
        </fieldset>
        <fieldset>
          <legend>Proactive participation</legend>
          <label>
            <Input
              name="participation"
              type="checkbox"
              defaultChecked={d?.participation.enabled ?? true}
            />
            Enable participation
          </label>
          <label>
            <Input
              name="meaningful"
              type="checkbox"
              defaultChecked={d?.participation.onlyMeaningfulChanges ?? true}
            />
            Publish meaningful changes only
          </label>
          <label>
            Publication cooldown in minutes
            <Input
              name="cooldown"
              type="number"
              min={0}
              max={10080}
              defaultValue={d?.participation.cooldownMinutes ?? 30}
              required
            />
          </label>
          <label>
            Daily publication limit (UTC)
            <Input
              name="publications"
              type="number"
              min={1}
              max={100}
              defaultValue={d?.participation.maxPublicationsPerDay ?? 12}
              required
            />
          </label>
          <label>
            <Input name="quiet" type="checkbox" defaultChecked={Boolean(quiet)} />
            Observe quiet hours
          </label>
          <label>
            Quiet-hours timezone
            <Input
              name="quietTimezone"
              defaultValue={quiet?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
            />
          </label>
          <label>
            Quiet-hours start
            <Input
              name="quietStart"
              type="number"
              min={0}
              max={23}
              defaultValue={quiet?.startHour ?? 22}
            />
          </label>
          <label>
            Quiet-hours end
            <Input
              name="quietEnd"
              type="number"
              min={0}
              max={23}
              defaultValue={quiet?.endHour ?? 8}
            />
          </label>
        </fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save paused automation'}
        </Button>
      </form>
    </Dialog>
  );
}

function AutomationSourceTask({
  conversation,
  initial,
}: {
  conversation: string;
  initial: string | undefined;
}) {
  const [query, setQuery] = useState(''),
    [tasks, setTasks] = useState<{ id: string; title: string }[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    const timer = setTimeout(() => {
      void api<{ items: typeof tasks }>(
        '/tasks/list?limit=50&conversationId=' + conversation + '&q=' + encodeURIComponent(query),
        { signal: c.signal },
      )
        .then((p) => {
          if (!c.signal.aborted) setTasks(p.items);
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(e instanceof Error ? e.message : 'Tasks unavailable.');
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [conversation, query]);
  return (
    <fieldset>
      <legend>Optional source task</legend>
      <label>
        Find source task
        <Input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <label>
        Source task
        <NativeSelect aria-label="Source task" name="sourceTaskId" defaultValue={initial ?? ''}>
          <option value="">No source task</option>
          {initial && !tasks.some((t) => t.id === initial) && (
            <option value={initial}>Current source task</option>
          )}
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </NativeSelect>
      </label>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
