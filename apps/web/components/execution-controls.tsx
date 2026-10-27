'use client';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import { useEffect, useState } from 'react';
import type { Agent, AgentRun, Bootstrap, Member } from '@ao/contracts';
import { api, post } from '../lib/api';
import { Dialog } from './dialog';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
interface Policy {
  version: number;
  budget_micros: string;
  spent_micros: string;
  reserved_micros: string;
  max_open_runs: number;
  max_concurrent_runs: number;
  max_agent_concurrent: number;
  max_requester_concurrent: number;
  max_delegation_depth: number;
  max_delegation_children: number;
}
const dollars = (micros: string | number) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(Number(micros) / 1000000);
export function ExecutionPolicyControls({ canManage }: { canManage: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card asChild>
      <div className="work-panel">
        <Button
          variant="outline"
          className="subtle-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Close execution limits' : 'Execution limits and spending'}
        </Button>
        {open && <ExecutionPolicyForm canManage={canManage} />}
      </div>
    </Card>
  );
}
function ExecutionPolicyForm({ canManage }: { canManage: boolean }) {
  const [policy, setPolicy] = useState<Policy | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<Policy>('/execution/policy', { signal: controller.signal })
      .then(setPolicy)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <section aria-label="Execution limits and spending">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {policy ? (
        <form
          key={policy.version}
          className="work-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setBusy(true);
            setError('');
            try {
              await api('/execution/policy', {
                method: 'PUT',
                body: JSON.stringify({
                  version: policy.version,
                  budgetMicros: Math.round(Number(data.get('budget')) * 1000000),
                  ...Object.fromEntries(
                    [
                      'maxOpenRuns',
                      'maxConcurrentRuns',
                      'maxAgentConcurrent',
                      'maxRequesterConcurrent',
                      'maxDelegationDepth',
                      'maxDelegationChildren',
                    ].map((key) => [key, Number(data.get(key))]),
                  ),
                }),
              });
              setPolicy(await api<Policy>('/execution/policy'));
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Unable to save policy.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            Budget {dollars(policy.budget_micros)} · Spent {dollars(policy.spent_micros)} · Reserved{' '}
            {dollars(policy.reserved_micros)}
          </p>
          <p className="muted">
            Reservations include uncertain provider outcomes until reconciled. Missing provider
            costs are charged at the full reservation.
          </p>
          <label>
            Workspace execution budget (USD)
            <Input
              name="budget"
              type="number"
              step="0.000001"
              min={0}
              max={1000000}
              required
              defaultValue={Number(policy.budget_micros) / 1000000}
            />
          </label>
          <div className="work-form-grid">
            {(
              [
                ['maxOpenRuns', 'Open run limit', 'max_open_runs', 1, 500],
                ['maxConcurrentRuns', 'Workspace concurrency', 'max_concurrent_runs', 1, 32],
                ['maxAgentConcurrent', 'Agent concurrency', 'max_agent_concurrent', 1, 8],
                [
                  'maxRequesterConcurrent',
                  'Requester concurrency',
                  'max_requester_concurrent',
                  1,
                  16,
                ],
                ['maxDelegationDepth', 'Delegation depth', 'max_delegation_depth', 0, 5],
                [
                  'maxDelegationChildren',
                  'Children per delegation',
                  'max_delegation_children',
                  0,
                  20,
                ],
              ] as const
            ).map(([name, label, key, min, max]) => (
              <label key={name}>
                {label}
                <Input
                  name={name}
                  type="number"
                  min={min}
                  max={max}
                  required
                  defaultValue={policy[key]}
                />
              </label>
            ))}
          </div>
          <Button className="primary" disabled={!canManage || busy}>
            Save execution policy
          </Button>
        </form>
      ) : (
        <p>Loading execution policy…</p>
      )}
    </section>
  );
}
interface RunDetail {
  coordination_status: string;
  status: string;
  agent_revision: number;
  parent_run_id: string | null;
  resumed_from: string | null;
  owner_id: string | null;
  verifier_id: string | null;
  verification_status: string;
  verification_evidence: string | null;
  output_contract: string | null;
  stop_condition: string | null;
  delegation_deadline: string | null;
  spending: {
    amount_micros: string;
    actual_micros: string | null;
    state: string;
    receipt: string | null;
  } | null;
  tasks: { id: string; title: string; state: string }[];
  children: {
    id: string;
    status: string;
    verification_status: string;
    output_contract: string;
    delegation_deadline: string;
  }[];
  checkpoints: { ordinal: number; kind: string; summary: string; created_at: string }[];
}
interface Trace {
  id: string;
  kind: string;
  summary: string;
  created_at: string;
}
export function RunControls({
  run,
  boot,
  onClose,
  onChanged,
}: {
  run: AgentRun;
  boot: Bootstrap;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [delegate, setDelegate] = useState(false),
    [requestKey] = useState(() => crypto.randomUUID());
  const traces = useCursorPage<Trace>(run.id, `/runs/${run.id}/traces`);
  const canManage = boot.me.kind === 'human' && boot.me.permissions?.['execution.manage'] !== false;
  useEffect(() => {
    const controller = new AbortController();
    void api<RunDetail>(`/runs/${run.id}/detail`, { signal: controller.signal })
      .then(setDetail)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [run.id]);
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const timer = setInterval(async () => {
      if (polling || document.visibilityState === 'hidden') return;
      polling = true;
      try {
        const [current] = await Promise.all([
          api<RunDetail>(`/runs/${run.id}/detail`, { signal: controller.signal }),
          traces.refresh(),
        ]);
        if (!controller.signal.aborted) setDetail(current);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error ? error.message : 'Unable to refresh execution progress.',
          );
      } finally {
        polling = false;
      }
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [run.id, traces.refresh]);
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await post(path, body);
      setDetail(await api<RunDetail>(`/runs/${run.id}/detail`));
      await traces.refresh();
      await onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update the run.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`${run.agent_name} · Run details`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <section aria-label="Run controls">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {detail ? (
          <>
            <p>
              Agent revision {detail.agent_revision ?? 'legacy'} · {detail.status} · Coordination:{' '}
              {detail.coordination_status.replaceAll('_', ' ')}
            </p>
            {detail.spending && (
              <p>
                Reservation {dollars(detail.spending.amount_micros)} · {detail.spending.state}
                {detail.spending.actual_micros !== null
                  ? ` · Charged ${dollars(detail.spending.actual_micros)}`
                  : ''}
              </p>
            )}
            {detail.output_contract && (
              <Card asChild>
                <article className="work-card">
                  <h3>Delegation contract</h3>
                  <p>{detail.output_contract}</p>
                  <p>Stop condition: {detail.stop_condition}</p>
                  <p>
                    Deadline: {new Date(detail.delegation_deadline!).toLocaleString()} ·
                    Verification: {detail.verification_status}
                  </p>
                  {detail.verification_evidence && <p>{detail.verification_evidence}</p>}
                </article>
              </Card>
            )}
            <a className="subtle-button" href={`/api/v1/runs/${run.id}/export`} download>
              Export run artifacts and public trace
            </a>
            {canManage && detail.status === 'outcome_unknown' && (
              <Button
                variant="outline"
                disabled={busy}
                className="subtle-button"
                onClick={() => void action(`/runs/${run.id}/resume`, {})}
              >
                Resume existing session observation
              </Button>
            )}
            {canManage &&
              ['failed', 'cancelled'].includes(detail.status) &&
              !detail.parent_run_id &&
              detail.spending?.state !== 'reserved' && (
                <Button
                  variant="outline"
                  disabled={busy}
                  className="subtle-button"
                  onClick={() => void action(`/runs/${run.id}/restart`, { requestKey })}
                >
                  Restart as a new run
                </Button>
              )}
            {canManage &&
              ['outcome_unknown', 'failed', 'cancelled'].includes(detail.status) &&
              detail.spending?.state === 'reserved' &&
              ['owner', 'admin'].includes(boot.me.role) && (
                <form
                  className="work-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void action(`/runs/${run.id}/spending`, {
                      actualMicros: Math.round(Number(data.get('cost')) * 1000000),
                      receipt: data.get('receipt'),
                    });
                  }}
                >
                  <h3>Reconcile provider spending</h3>
                  <label>
                    Confirmed provider cost (USD)
                    <Input name="cost" type="number" step="0.000001" min={0} max={1000} required />
                  </label>
                  <label>
                    Provider receipt or reconciliation evidence
                    <Textarea name="receipt" minLength={10} maxLength={2000} required />
                  </label>
                  <Button className="primary" disabled={busy}>
                    Settle reservation
                  </Button>
                </form>
              )}
            {canManage &&
              detail.verifier_id === boot.me.id &&
              detail.status === 'succeeded' &&
              ['pending', 'escalated'].includes(detail.verification_status) && (
                <form
                  className="work-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void action(`/runs/${run.id}/verification`, {
                      decision: data.get('decision'),
                      evidence: data.get('evidence'),
                    });
                  }}
                >
                  <h3>Independent verification</h3>
                  <label>
                    Verification decision
                    <NativeSelect aria-label="Verification decision" name="decision">
                      <option value="accepted">Accept result</option>
                      <option value="rejected">Reject result</option>
                    </NativeSelect>
                  </label>
                  <label>
                    Verification evidence
                    <Textarea name="evidence" required minLength={10} maxLength={4000} />
                  </label>
                  <Button disabled={busy} className="primary">
                    Record independent verification
                  </Button>
                </form>
              )}
            {canManage && ['running', 'awaiting_approval', 'succeeded'].includes(detail.status) && (
              <Button
                variant="outline"
                className="subtle-button"
                aria-expanded={delegate}
                onClick={() => setDelegate(!delegate)}
              >
                Delegate work
              </Button>
            )}
            {delegate && (
              <DelegationForm
                runId={run.id}
                scope={`${boot.workspace.id}:${boot.me.id}`}
                disabled={busy}
                onCreated={async () => {
                  setDelegate(false);
                  setDetail(await api(`/runs/${run.id}/detail`));
                  await onChanged();
                }}
              />
            )}
            <h3>Linked tasks</h3>
            {detail.tasks.length ? (
              detail.tasks.map((task) => (
                <p key={task.id}>
                  {task.title} · {task.state}
                </p>
              ))
            ) : (
              <p className="muted">No linked tasks.</p>
            )}
            <h3>Delegated work</h3>
            {detail.children.length ? (
              detail.children.map((child) => (
                <Card key={child.id} asChild>
                  <article className="work-card">
                    <strong>{child.output_contract}</strong>
                    <p>
                      {child.status} · {child.verification_status}
                    </p>
                    <small>Due {new Date(child.delegation_deadline).toLocaleString()}</small>
                  </article>
                </Card>
              ))
            ) : (
              <p className="muted">No delegated work.</p>
            )}
            <h3>Durable checkpoints</h3>
            {detail.checkpoints.map((checkpoint) => (
              <p key={checkpoint.ordinal}>
                {checkpoint.kind}: {checkpoint.summary}
              </p>
            ))}
          </>
        ) : (
          <p>Loading run details…</p>
        )}
        <h3>Public action and result trace</h3>
        <p className="muted">
          This trace records execution states and actions. Private model reasoning and service
          credentials are excluded.
        </p>
        {traces.items.map((trace) => (
          <Card key={trace.id} asChild>
            <article className="work-card">
              <strong>{trace.kind}</strong>
              <p>{trace.summary}</p>
              <small>{new Date(trace.created_at).toLocaleString()}</small>
            </article>
          </Card>
        ))}
        <PageControls {...traces} onMore={traces.more} />
      </section>
    </Dialog>
  );
}
function DelegationForm({
  runId,
  scope,
  disabled,
  onCreated,
}: {
  runId: string;
  scope: string;
  disabled: boolean;
  onCreated: () => Promise<void>;
}) {
  const agents = useCursorPage<Agent>(scope, '/collections/agents'),
    members = useCursorPage<Member>(scope, '/collections/members');
  const [key] = useState(() => crypto.randomUUID()),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="work-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setBusy(true);
        setError('');
        try {
          await post(`/runs/${runId}/delegations`, {
            requestKey: key,
            agentId: data.get('agentId'),
            ownerId: data.get('ownerId'),
            verifierId: data.get('verifierId'),
            prompt: data.get('prompt'),
            outputContract: data.get('contract'),
            stopCondition: data.get('stop'),
            deadline: new Date(String(data.get('deadline'))).toISOString(),
            budgetMicros: Math.round(Number(data.get('budget')) * 1000000),
          });
          await onCreated();
        } catch (error) {
          setError(error instanceof Error ? error.message : 'Unable to delegate work.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Delegate with an explicit contract</h3>
      <label>
        Delegate agent
        <NativeSelect aria-label="Delegate agent" name="agentId" required>
          {agents.items
            .filter((agent) => agent.runtime === 'managed' && agent.status === 'active')
            .map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
        </NativeSelect>
      </label>
      <PageControls {...agents} onMore={agents.more} />
      {(['ownerId', 'verifierId'] as const).map((name) => (
        <label key={name}>
          {name === 'ownerId' ? 'Delegation owner' : 'Independent verifier'}
          <NativeSelect
            aria-label={name === 'ownerId' ? 'Delegation owner' : 'Independent verifier'}
            name={name}
            required
          >
            {members.items
              .filter(
                (member) =>
                  member.kind === 'human' &&
                  member.status !== 'suspended' &&
                  member.access_type !== 'guest',
              )
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
          </NativeSelect>
        </label>
      ))}
      <PageControls {...members} onMore={members.more} />
      <label>
        Delegation request
        <Textarea name="prompt" required minLength={3} maxLength={12000} />
      </label>
      <label>
        Required output contract
        <Textarea name="contract" required minLength={10} maxLength={4000} />
      </label>
      <label>
        Stop condition
        <Textarea name="stop" required minLength={5} maxLength={2000} />
      </label>
      <label>
        Delegation deadline
        <Input name="deadline" type="datetime-local" required />
      </label>
      <label>
        Delegation budget (USD)
        <Input
          name="budget"
          type="number"
          min={0.000001}
          step="0.000001"
          defaultValue={0.5}
          max={100}
          required
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Button className="primary" disabled={disabled || busy}>
        Create delegation
      </Button>
    </form>
  );
}
