'use client';
import { WorkspaceHeading } from './workspace-heading';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';
import { ToolControls } from './tool-controls';
import { ToolActionDetail, toolLabels } from './tool-action-detail';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Check,
  CheckCheck,
  LoaderCircle,
  Play,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import type { Agent, AgentRun, Bootstrap, ToolInvocation } from '@ao/contracts';
import { api, post } from '../lib/api';
import { Dialog } from './dialog';
import { Empty } from './primitives';
import { ExecutionPolicyControls, RunControls } from './execution-controls';
interface Capabilities {
  hostedRuntime: boolean;
  tools: string[];
  approvalPolicy: string;
}
const activeStates = new Set(['queued', 'running', 'awaiting_approval', 'outcome_unknown']);
const labels: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting review',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  outcome_unknown: 'Needs investigation',
  pending: 'Awaiting decision',
  executing: 'Executing approved action',
  approved: 'Approved · queued',
  rejected: 'Declined',
  expired: 'Expired',
};
export function ExecutionView({
  mode,
  boot,
  initialRunId,
  onRunOpened,
}: {
  mode: 'runs' | 'approvals';
  boot: Bootstrap;
  initialRunId?: string | null;
  onRunOpened?: () => void;
}) {
  const scope = `${boot.workspace.id}:${boot.me.id}`,
    runPage = useCursorPage<AgentRun>(scope, '/collections/runs'),
    actionPage = useCursorPage<ToolInvocation>(scope, '/collections/approvals'),
    agentPage = useCursorPage<Agent>(scope, '/collections/agents');
  const runs = runPage.items,
    actions = actionPage.items,
    agents = agentPage.items;
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [runDialog, setRunDialog] = useState(false),
    [toolDialog, setToolDialog] = useState(false),
    [review, setReview] = useState<ToolInvocation | null>(null),
    [requestKey, setRequestKey] = useState('');
  const [selectedRun, setSelectedRun] = useState<AgentRun | null>(null);
  useEffect(() => {
    if (!initialRunId || mode !== 'runs') return;
    const controller = new AbortController();
    void api<AgentRun>(`/runs/${initialRunId}`, { signal: controller.signal })
      .then((run) => {
        if (!controller.signal.aborted) {
          setSelectedRun(run);
          onRunOpened?.();
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [initialRunId, mode, onRunOpened]);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const options = signal ? { signal } : {};
        const [, , , c] = await Promise.all([
          runPage.refresh(),
          actionPage.refresh(),
          agentPage.refresh(),
          api<Capabilities>('/execution/capabilities', options),
        ]);
        if (signal?.aborted) return;
        setCapabilities(c);
      } catch (error) {
        if (!signal?.aborted)
          setError(error instanceof Error ? error.message : 'Unable to load execution history.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [runPage.refresh, actionPage.refresh, agentPage.refresh],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    let polling = false;
    const timer = setInterval(async () => {
      if (polling || document.visibilityState === 'hidden') return;
      polling = true;
      try {
        await refresh(controller.signal);
      } finally {
        polling = false;
      }
    }, 2500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  const managed = agents.filter(
    (agent) => agent.runtime === 'managed' && agent.status === 'active',
  );
  const canApprove = boot.me.kind === 'human' && ['owner', 'admin'].includes(boot.me.role);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await post('/runs', {
        agentId: form.get('agentId'),
        conversationId: form.get('conversationId'),
        prompt: form.get('prompt'),
        requestKey,
      });
      setRunDialog(false);
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to queue run.');
    } finally {
      setBusy(false);
    }
  }
  async function decide(decision: 'approved' | 'rejected', form: HTMLFormElement) {
    if (!review) return;
    setBusy(true);
    setError('');
    try {
      await post(`/approvals/${review.id}/decisions`, {
        decision,
        digest: review.action_digest,
        reason: new FormData(form).get('reason') ?? '',
      });
      setReview(null);
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to record decision.');
    } finally {
      setBusy(false);
    }
  }
  async function cancel(run: AgentRun) {
    setBusy(true);
    setError('');
    try {
      await post(`/runs/${run.id}/cancel`, {});
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to cancel run.');
    } finally {
      setBusy(false);
    }
  }
  async function reconcile(run: AgentRun) {
    setBusy(true);
    setError('');
    try {
      await post(`/runs/${run.id}/reconcile`, {});
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to reconcile the hosted result.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page-content execution-view">
      <div className="execution-heading">
        <WorkspaceHeading
          icon={mode === 'runs' ? Activity : ShieldCheck}
          eyebrow={mode === 'runs' ? 'A clear trail of work' : 'Your review matters'}
          title={mode === 'runs' ? 'Run history' : 'Pending approvals'}
          description={
            mode === 'runs'
              ? 'Follow hosted work from request to result. Important actions wait for your review.'
              : 'Review proposed actions with their context, scope, and expected result.'
          }
        />
        {mode === 'runs' && (
          <Button
            size="sm"
            className="primary small"
            disabled={!capabilities?.hostedRuntime || !managed.length}
            onClick={() => {
              setRequestKey(crypto.randomUUID());
              setRunDialog(true);
              setError('');
            }}
          >
            <Play size={15} />
            Run agent
          </Button>
        )}
      </div>
      <Button variant="outline" className="subtle-button" onClick={() => setToolDialog(true)}>
        Tools and provider connections
      </Button>
      {toolDialog && (
        <Dialog title="Tools and provider connections" onClose={() => setToolDialog(false)}>
          <ToolControls boot={boot} />
        </Dialog>
      )}
      {capabilities && !capabilities.hostedRuntime && (
        <div className="runtime-notice">
          <ShieldCheck size={19} />
          <p>
            <strong>Hosted execution needs an operator connection.</strong>
            <br />
            The managed runtime is not configured. Existing approvals can still be reviewed. Setup
            instructions are in the repository’s implementation guide.
          </p>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {mode === 'runs' && canApprove && (
        <ExecutionPolicyControls
          canManage={canApprove && boot.me.permissions?.['execution.manage'] !== false}
        />
      )}
      {loading ? (
        <div className="empty">
          <LoaderCircle className="spin" />
          <p>Loading execution history…</p>
        </div>
      ) : mode === 'runs' ? (
        runs.length === 0 ? (
          <Empty
            icon={Activity}
            title="A clear view of the work ahead"
            description={
              managed.length
                ? 'Choose a hosted agent and give it a request in a channel.'
                : 'Create a hosted agent from the Agents screen, then start a run here.'
            }
          />
        ) : (
          <div className="run-list">
            {runs.map((run) => (
              <Card key={run.id} asChild>
                <article className="run-card">
                  <Card asChild>
                    <div className="run-card-header">
                      <Badge variant="outline" className={`state ${run.status}`}>
                        {labels[run.status]}
                      </Badge>
                      <small>{new Date(run.created_at).toLocaleString()}</small>
                    </div>
                  </Card>
                  <h3>
                    {run.agent_name}
                    <span> · #{run.channel_name}</span>
                  </h3>
                  <p>{run.prompt}</p>
                  <Button
                    variant="outline"
                    className="subtle-button"
                    onClick={() => setSelectedRun(run)}
                  >
                    Run details and coordination
                  </Button>
                  {run.error_code && (
                    <p className="error">
                      {run.error_code === 'LEASE_EXPIRED'
                        ? 'The worker was interrupted. The model request will not be sent again automatically. Check for a settled result without repeating the model request.'
                        : run.error_code === 'RUNTIME_TIMEOUT'
                          ? 'Execution timed out. Inspect runtime history to confirm its outcome.'
                          : `Execution stopped: ${run.error_code.replaceAll('_', ' ').toLowerCase()}.`}
                    </p>
                  )}
                  {run.status === 'outcome_unknown' && (
                    <Button
                      variant="outline"
                      disabled={busy || !capabilities?.hostedRuntime}
                      className="subtle-button"
                      onClick={() => void reconcile(run)}
                    >
                      Check hosted result
                    </Button>
                  )}
                  {activeStates.has(run.status) && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      className="subtle-button"
                      onClick={() => void cancel(run)}
                    >
                      <Square size={12} />
                      Cancel run
                    </Button>
                  )}
                </article>
              </Card>
            ))}
          </div>
        )
      ) : actions.length === 0 ? (
        <Empty
          icon={ShieldCheck}
          title="Nothing waiting for your judgment"
          description="When a hosted agent proposes creating a task or saving knowledge, you can review its exact content here."
        />
      ) : (
        <div className="run-list">
          {actions.map((action) => (
            <Card key={action.id} asChild>
              <article className="run-card approval-card">
                <Card asChild>
                  <div className="run-card-header">
                    <Badge variant="outline" className={`state ${action.status}`}>
                      {labels[action.status]}
                    </Badge>
                    <small>
                      {action.agent_name} · #{action.channel_name}
                    </small>
                  </div>
                </Card>
                <h3>{toolLabels[action.tool_name]}</h3>
                <ToolActionDetail action={action} canReconcile={boot.me.role === 'owner'} />
                <h4>{action.parameters.title}</h4>
                <p>{action.parameters.description ?? action.parameters.body}</p>
                {action.parameters.priority && (
                  <small>Priority: {action.parameters.priority}</small>
                )}
                {action.tool_name === 'delegate_agent' && (
                  <DelegationProposal action={action} boot={boot} agents={agents} />
                )}
                {action.status === 'pending' && (
                  <div className="approval-footer">
                    <small>Expires {new Date(action.expires_at).toLocaleString()}</small>
                    <Button
                      size="sm"
                      className="primary small"
                      disabled={
                        !canApprove || busy || new Date(action.expires_at).getTime() <= Date.now()
                      }
                      onClick={() => {
                        setReview(action);
                        setError('');
                      }}
                    >
                      <ShieldCheck size={15} />
                      Review action
                    </Button>
                  </div>
                )}
                {action.status === 'succeeded' && (
                  <p className="execution-success">
                    <CheckCheck size={15} />
                    Applied once with a recorded approval.
                  </p>
                )}
                {action.error_code && (
                  <p className="error">
                    Action stopped: {action.error_code.replaceAll('_', ' ').toLowerCase()}.
                  </p>
                )}
              </article>
            </Card>
          ))}
        </div>
      )}
      <PageControls
        {...(mode === 'runs' ? runPage : actionPage)}
        onMore={mode === 'runs' ? runPage.more : actionPage.more}
      />
      {selectedRun && (
        <RunControls
          run={selectedRun}
          boot={boot}
          onClose={() => setSelectedRun(null)}
          onChanged={() => refresh()}
        />
      )}
      {runDialog && (
        <Dialog
          title="Start a hosted run"
          onClose={() => {
            if (!busy) setRunDialog(false);
          }}
        >
          <form onSubmit={submit}>
            <label>
              Agent
              <NativeSelect name="agentId" aria-label="Agent">
                {managed.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <PageControls {...agentPage} onMore={agentPage.more} />
            <label>
              Channel
              <NativeSelect name="conversationId" aria-label="Channel">
                {boot.channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Request
              <Textarea
                name="prompt"
                required
                minLength={1}
                maxLength={12000}
                rows={5}
                placeholder="What should this agent help with?"
              />
            </label>
            <p className="muted">
              Only the selected channel’s recent messages are supplied. The agent must already have
              access to private channels. Tool proposals wait for separate approval.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button disabled={busy} className="primary">
              {busy ? 'Queuing…' : 'Start run'}
              <Play size={15} />
            </Button>
          </form>
        </Dialog>
      )}
      {review && (
        <Dialog
          title="Review proposed action"
          onClose={() => {
            if (!busy) setReview(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void decide('approved', event.currentTarget);
            }}
          >
            <div className="review-summary">
              <p>
                <strong>{toolLabels[review.tool_name]}</strong> in #{review.channel_name}
              </p>
              <ToolActionDetail action={review} canReconcile={boot.me.role === 'owner'} />
              <h3>{review.parameters.title}</h3>
              <p>{review.parameters.description ?? review.parameters.body}</p>
              {review.parameters.priority && <p>Priority: {review.parameters.priority}</p>}
              {review.tool_name === 'delegate_agent' && (
                <DelegationProposal action={review} boot={boot} agents={agents} />
              )}
            </div>
            <p className="muted">
              This approval applies only to the displayed content. The original agent and requester
              must still have channel access when it executes.
            </p>
            <label>
              Decision note
              <Textarea name="reason" maxLength={1000} rows={2} />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="decision-buttons">
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                className="subtle-button"
                onClick={(event) => {
                  const form = event.currentTarget.closest('form');
                  if (form) void decide('rejected', form);
                }}
              >
                <X size={15} />
                Decline
              </Button>
              <Button disabled={busy} className="primary">
                <Check size={15} />
                {busy ? 'Saving…' : 'Approve action'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
function DelegationProposal({
  action,
  boot,
  agents,
}: {
  action: ToolInvocation;
  boot: Bootstrap;
  agents: Agent[];
}) {
  const input = action.parameters;
  return (
    <div>
      <p>Agent: {agents.find((agent) => agent.id === input.agentId)?.name ?? input.agentId}</p>
      <p>
        Owner: {boot.members.find((member) => member.id === input.ownerId)?.name ?? input.ownerId} ·
        Verifier:{' '}
        {boot.members.find((member) => member.id === input.verifierId)?.name ?? input.verifierId}
      </p>
      <p>{input.prompt}</p>
      <p>Output contract: {input.outputContract}</p>
      <p>Stop condition: {input.stopCondition}</p>
      <p>
        Deadline: {new Date(String(input.deadline)).toLocaleString()} · Budget: USD{' '}
        {(Number(input.budgetMicros) / 1000000).toFixed(4)}
      </p>
    </div>
  );
}
