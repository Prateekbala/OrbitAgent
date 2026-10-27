import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AgentOutput, ToolProposal } from '@ao/contracts';
import { toolEffects } from '@ao/contracts/tools';
import type { HostedRuntime } from '../src/execution/types.js';
import { messagingFixture } from './messaging-fixture.js';
import { ExecutionWorker } from '../src/execution/worker.js';
import { ToolActionWorker } from '../src/tools/worker.js';
import type { ProviderRequest } from '../src/tools/provider.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
import { sandboxExecutor } from '../src/tools/sandbox.js';
class Runtime implements HostedRuntime {
  configured = true;
  output: AgentOutput = { reply: 'A reviewed operation is proposed.', proposals: [] };
  async createSession() {
    return randomUUID();
  }
  async generate() {
    return this.output;
  }
  async recover() {
    return null;
  }
  async cancel() {}
}
let f: Awaited<ReturnType<typeof messagingFixture>>, runtime: Runtime, worker: ExecutionWorker;
afterEach(async () => f?.close());
async function setup() {
  runtime = new Runtime();
  f = await messagingFixture(undefined, undefined, {
    runtime,
    toolProviderHosts: ['93.184.216.34'],
  });
  worker = new ExecutionWorker(f.db, runtime, () => {}, secrets());
}
async function connection() {
  const r = await f.call(f.owner, 'POST', '/v1/execution/connections', {
    name: 'Owned publisher',
    endpoint: 'https://93.184.216.34/orbit',
    secret: 'fixture-secret-not-for-output',
    operations: [
      {
        name: 'publish_document',
        effect: 'publish',
        description: 'Publish to the owned fixture account.',
      },
    ],
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function agent(tool: ToolProposal['tool']) {
  const r = await f.call(f.owner, 'POST', '/v1/agents', {
    name: 'Controlled ' + randomUUID().slice(0, 8),
    role: 'Propose only explicitly requested operations.',
    runtime: 'managed',
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id as string,
    current = (await f.call(f.owner, 'GET', `/v1/agents/${id}`)).json();
  const revised = await f.call(f.owner, 'POST', `/v1/agents/${id}/revisions`, {
    version: current.version,
    configuration: { ...current.configuration, tools: [tool] },
  });
  expect(revised.statusCode, revised.body).toBe(200);
  const [member] = await f.db.query('SELECT membership_id FROM agents WHERE id=$1', [id]);
  return { id, memberId: String(member!.membership_id) };
}
async function grant(connectionId: string, memberId: string) {
  const r = await f.call(f.owner, 'POST', `/v1/execution/connections/${connectionId}/grant`, {
    memberId,
    operations: ['publish_document'],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  expect(r.statusCode, r.body).toBe(200);
}
async function propose(proposal: ToolProposal, agentId?: string) {
  const a = agentId ?? (await agent(proposal.tool)).id;
  runtime.output = { reply: 'Proposed exact action for human review.', proposals: [proposal] };
  const r = await f.call(f.owner, 'POST', '/v1/runs', {
    agentId: a,
    conversationId: f.ownerBoot.channels[0]!.id,
    prompt: 'Prepare the requested operation.',
    requestKey: randomUUID(),
  });
  expect(r.statusCode, r.body).toBe(201);
  await worker.tick();
  const [inv] = await f.db.query('SELECT * FROM tool_invocations WHERE run_id=$1', [r.json().id]);
  return { inv, runId: r.json().id as string };
}
async function approve(inv: Record<string, unknown>, session = f.owner) {
  return f.call(session, 'POST', `/v1/approvals/${inv.id}/decisions`, {
    decision: 'approved',
    digest: inv.action_digest,
    reason: 'Reviewed the exact destination and effect.',
  });
}
const proposal = (connectionId: string): ToolProposal => ({
  tool: 'connection_action',
  parameters: { connectionId, operation: 'publish_document', payload: '{"document":"approved"}' },
});
async function preparedConnection() {
  const c = await connection(),
    a = await agent('connection_action');
  await grant(c, f.ownerBoot.me.id);
  await grant(c, a.memberId);
  const { inv, runId } = await propose(proposal(c), a.id);
  expect(inv).toBeDefined();
  expect((await approve(inv!)).statusCode).toBe(200);
  await worker.tick();
  const [ledger] = await f.db.query('SELECT * FROM tool_actions WHERE invocation_id=$1', [inv!.id]);
  expect(ledger?.state).toBe('prepared');
  return { c, a, inv: inv!, runId, ledger: ledger! };
}
const secrets = () => new IdentitySecrets(Buffer.alloc(32, 5).toString('base64'));
describe('versioned tools and secure execution', () => {
  it('publishes an explicit registry and rejects unapproved or private network adapter destinations', async () => {
    await setup();
    const registry = (await f.call(f.owner, 'GET', '/v1/execution/tools')).json();
    expect(registry.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining([
        'read_tasks',
        'connection_action',
        'execute_code',
        'interactive_form',
      ]),
    );
    const r = await f.call(f.owner, 'POST', '/v1/execution/connections', {
      name: 'Private service',
      endpoint: 'https://127.0.0.1/adapter',
      secret: 'a-secret-that-is-long-enough',
      operations: [
        { name: 'delete_records', effect: 'destructive', description: 'Delete provider records.' },
      ],
    });
    expect(r.statusCode).toBe(400);
    expect(await f.db.query('SELECT * FROM tool_connections')).toHaveLength(0);
  });
  it('requires explicit connection-owner grants to both the requester and agent', async () => {
    await setup();
    const c = await connection(),
      a = await agent('connection_action');
    await grant(c, f.ownerBoot.me.id);
    const { inv, runId } = await propose(proposal(c), a.id);
    expect(inv).toBeUndefined();
    expect(
      (await f.db.query('SELECT error_code FROM agent_runs WHERE id=$1', [runId]))[0]?.error_code,
    ).toBe('CONNECTION_OWNER_AUTHORIZATION_REQUIRED');
    expect(
      (
        await f.call(f.mate, 'POST', `/v1/execution/connections/${c}/grant`, {
          memberId: a.memberId,
          operations: ['publish_document'],
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        })
      ).statusCode,
    ).toBe(404);
  });
  it('binds owner connection version and effect previews into exact approvals', async () => {
    await setup();
    const c = await connection(),
      a = await agent('connection_action');
    await grant(c, f.ownerBoot.me.id);
    await grant(c, a.memberId);
    const { inv } = await propose(proposal(c), a.id);
    const previews = (await f.call(f.owner, 'GET', '/v1/approvals')).json();
    expect(
      previews.find((i: { id: string }) => i.id === inv!.id).authorization_snapshot,
    ).toMatchObject({
      effect: 'publish',
      destination: 'https://93.184.216.34/orbit',
      connectionName: 'Owned publisher',
    });
    expect(JSON.stringify(previews)).not.toContain('fixture-secret');
    await grant(c, a.memberId);
    const r = await approve(inv!);
    expect(r.json().error.code).toBe('ACTION_POLICY_CHANGED');
  });
  it('enforces independent approval and policy revisions even after a decision', async () => {
    await setup();
    const policy = (await f.call(f.owner, 'GET', '/v1/execution/tool-policy')).json();
    policy.rules.write.independent = true;
    expect((await f.call(f.owner, 'PUT', '/v1/execution/tool-policy', policy)).statusCode).toBe(
      200,
    );
    const { inv } = await propose({
      tool: 'create_task',
      parameters: { title: 'Reviewed task', description: '', priority: 'normal' },
    });
    expect((await approve(inv!)).json().error.code).toBe('INDEPENDENT_APPROVAL_REQUIRED');
    await f.db.query("UPDATE memberships SET role='admin',version=version+1 WHERE id=$1", [
      f.mateBoot.me.id,
    ]);
    expect((await approve(inv!, f.mate)).statusCode).toBe(200);
    const next = (await f.call(f.owner, 'GET', '/v1/execution/tool-policy')).json();
    next.rules.write.approval = 'deny';
    await f.call(f.owner, 'PUT', '/v1/execution/tool-policy', next);
    await worker.tick();
    expect(
      (
        await f.db.query('SELECT status,error_code FROM tool_invocations WHERE id=$1', [inv!.id])
      )[0],
    ).toMatchObject({ status: 'failed', error_code: 'TOOL_POLICY_DENIED' });
    expect(await f.db.query("SELECT id FROM tasks WHERE title='Reviewed task'")).toEqual([]);
  });
  it('dispatches once across replicas and reconciles a lost response by receipt lookup without replay', async () => {
    await setup();
    const { inv, ledger } = await preparedConnection(),
      calls: ProviderRequest[] = [];
    const send = async (input: ProviderRequest) => {
      calls.push(input);
      if (!input.reconcile) throw new Error('Response lost after provider commit.');
      return { status: 'succeeded' as const, receipt: 'provider:durable-receipt' };
    };
    const first = new ToolActionWorker(f.db, secrets(), send, sandboxExecutor(false)),
      second = new ToolActionWorker(f.db, secrets(), send, sandboxExecutor(false));
    await Promise.all([first.tick(), second.tick()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe(ledger.idempotency_key);
    expect(
      (await f.db.query('SELECT state FROM tool_actions WHERE id=$1', [ledger.id]))[0]?.state,
    ).toBe('outcome_unknown');
    await first.process(f.ownerBoot.workspace.id, String(ledger.id));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.reconcile).toBe(true);
    expect(calls[1]?.key).toBe(calls[0]?.key);
    expect(
      (await f.db.query('SELECT status FROM tool_invocations WHERE id=$1', [inv.id]))[0]?.status,
    ).toBe('succeeded');
    const receipt = await f.call(f.owner, 'GET', `/v1/execution/actions/${inv.id}`);
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().events.map((e: { state: string }) => e.state)).toEqual([
      'succeeded',
      'outcome_unknown',
      'dispatched',
      'prepared',
    ]);
    expect(receipt.body).not.toContain('fixture-secret');
    expect((await f.call(f.other, 'GET', `/v1/execution/actions/${inv.id}`)).statusCode).toBe(404);
    await expect(
      f.db.query("UPDATE tool_actions SET state='dispatched' WHERE id=$1", [ledger.id]),
    ).rejects.toThrow('immutable');
  });
  it('fences revoked grants and expired single-use capabilities before provider dispatch', async () => {
    await setup();
    const { c, a, ledger } = await preparedConnection();
    await f.call(f.owner, 'POST', `/v1/execution/connections/${c}/revoke`, {
      memberId: a.memberId,
    });
    let calls = 0;
    const actions = new ToolActionWorker(
      f.db,
      secrets(),
      async () => {
        calls++;
        return { status: 'succeeded', receipt: 'unexpected' };
      },
      sandboxExecutor(false),
    );
    await actions.tick();
    expect(calls).toBe(0);
    expect(
      (await f.db.query('SELECT state,error_code FROM tool_actions WHERE id=$1', [ledger.id]))[0],
    ).toMatchObject({ state: 'failed', error_code: 'CONNECTION_OWNER_AUTHORIZATION_REQUIRED' });
  });
  it('fails closed when isolated execution is not configured and never invokes a host shell', async () => {
    await setup();
    const { inv } = await propose({
      tool: 'execute_code',
      parameters: { language: 'shell', code: 'echo isolated-only', timeoutSeconds: 5 },
    });
    expect((await approve(inv!)).statusCode).toBe(200);
    await worker.tick();
    await new ToolActionWorker(
      f.db,
      secrets(),
      async () => ({ status: 'unknown' }),
      sandboxExecutor(false),
    ).tick();
    expect(
      (
        await f.db.query('SELECT state,receipt FROM tool_actions WHERE invocation_id=$1', [inv!.id])
      )[0],
    ).toMatchObject({ state: 'failed', receipt: 'sandbox:not-configured' });
  });
  it('validates and audits interactive form submissions with source ACLs and retry identity', async () => {
    await setup();
    const { inv } = await propose({
      tool: 'interactive_form',
      parameters: {
        title: 'Release review',
        description: 'Confirm the requested evidence.',
        fields: '[{"name":"evidence","label":"Evidence","type":"text","required":true}]',
      },
    });
    expect((await approve(inv!)).statusCode).toBe(200);
    await worker.tick();
    const [form] = await f.db.query('SELECT id FROM tool_forms WHERE invocation_id=$1', [inv!.id]);
    expect(form).toBeDefined();
    const url = `/v1/execution/forms/${form!.id}`,
      clientId = randomUUID();
    expect(
      (await f.call(f.owner, 'POST', url + '/submissions', { clientId, values: { evidence: 123 } }))
        .statusCode,
    ).toBe(400);
    const r = await f.call(f.owner, 'POST', url + '/submissions', {
      clientId,
      values: { evidence: 'Reviewed build output' },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(
      (
        await f.call(f.owner, 'POST', url + '/submissions', {
          clientId,
          values: { evidence: 'Reviewed build output' },
        })
      ).json().replayed,
    ).toBe(true);
    expect((await f.call(f.other, 'GET', url)).statusCode).toBe(404);
  });
  it('denies sensitive operations through a complete configurable effect policy', async () => {
    await setup();
    const rules = Object.fromEntries(
      toolEffects.map((effect) => [
        effect,
        { approval: 'deny', independent: true, expiresInMinutes: 15 },
      ]),
    );
    expect(
      (await f.call(f.owner, 'PUT', '/v1/execution/tool-policy', { version: 1, rules })).statusCode,
    ).toBe(200);
    const { runId, inv } = await propose({
      tool: 'execute_code',
      parameters: { language: 'python', code: 'print(2+2)', timeoutSeconds: 5 },
    });
    expect(inv).toBeUndefined();
    expect(
      (await f.db.query('SELECT error_code FROM agent_runs WHERE id=$1', [runId]))[0]?.error_code,
    ).toBe('TOOL_POLICY_DENIED');
  });
  it('returns bounded task and knowledge reads from the source audience', async () => {
    await setup();
    const conversationId = f.ownerBoot.channels[0]!.id;
    await f.call(f.owner, 'POST', '/v1/tasks', { title: 'Source task', conversationId });
    const read = await propose({ tool: 'read_tasks', parameters: { query: 'Source' } });
    expect((await approve(read.inv!)).statusCode).toBe(200);
    await worker.tick();
    expect(
      (await f.db.query('SELECT result FROM tool_invocations WHERE id=$1', [read.inv!.id]))[0]
        ?.result,
    ).toMatchObject({ items: [{ title: 'Source task' }] });
    await f.call(f.owner, 'POST', '/v1/knowledge', {
      title: 'Source guide',
      body: 'Reviewed scoped content',
      conversationId,
    });
    const knowledge = await propose({ tool: 'read_knowledge', parameters: { query: 'Source' } });
    expect((await approve(knowledge.inv!)).statusCode).toBe(200);
    await worker.tick();
    expect(
      (await f.db.query('SELECT result FROM tool_invocations WHERE id=$1', [knowledge.inv!.id]))[0]
        ?.result,
    ).toMatchObject({ items: [{ title: 'Source guide', body: 'Reviewed scoped content' }] });
  });
  it('expires sealed execution capabilities before dispatch without reissuing them', async () => {
    await setup();
    const { ledger } = await preparedConnection();
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
    try {
      await new ToolActionWorker(
        f.db,
        secrets(),
        async () => {
          calls++;
          return { status: 'succeeded', receipt: 'unexpected' };
        },
        sandboxExecutor(false),
      ).tick();
    } finally {
      clock.mockRestore();
    }
    expect(calls).toBe(0);
    expect(
      (await f.db.query('SELECT state,error_code FROM tool_actions WHERE id=$1', [ledger.id]))[0],
    ).toMatchObject({ state: 'failed', error_code: 'CAPABILITY_EXPIRED' });
  });
  it('records owner-attested evidence for an uncertain sandbox result without replaying code', async () => {
    await setup();
    const { inv } = await propose({
      tool: 'execute_code',
      parameters: { language: 'python', code: 'print(4)', timeoutSeconds: 5 },
    });
    await approve(inv!);
    await worker.tick();
    let calls = 0;
    await new ToolActionWorker(
      f.db,
      secrets(),
      async () => ({ status: 'unknown' }),
      async () => {
        calls++;
        throw new Error('Sandbox result lost.');
      },
    ).tick();
    const input = {
      outcome: 'succeeded',
      receipt: 'sandbox:verified-fixture-receipt',
      evidence: 'Operator inspected the isolated sandbox receipt and confirmed exit code zero.',
    };
    expect(
      (await f.call(f.mate, 'POST', `/v1/execution/actions/${inv!.id}/reconcile`, input))
        .statusCode,
    ).toBe(403);
    const reconciled = await f.call(
      f.owner,
      'POST',
      `/v1/execution/actions/${inv!.id}/reconcile`,
      input,
    );
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(calls).toBe(1);
    const evidence = await f.db.query(
      "SELECT actor_id,receipt FROM tool_action_events WHERE state='operator_evidence'",
    );
    expect(evidence[0]).toMatchObject({ actor_id: f.ownerBoot.me.id, receipt: input.evidence });
    expect(
      (await f.call(f.owner, 'POST', `/v1/execution/actions/${inv!.id}/reconcile`, input)).json()
        .error.code,
    ).toBe('ACTION_NOT_UNCERTAIN');
  });
});
