import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentOutput } from '@ao/contracts';
import type { HostedRuntime } from '../src/execution/types.js';
import { messagingFixture } from './messaging-fixture.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
import { ExecutionWorker } from '../src/execution/worker.js';
import { ToolActionWorker } from '../src/tools/worker.js';
import { ConnectionService } from '../src/connections/service.js';
import { NativeConnectorActions } from '../src/connections/native-actions.js';
import { nativeWriteProvider } from '../src/connections/mutations.js';
import type { Plan, ProviderTransport } from '../src/connections/provider.js';

class Runtime implements HostedRuntime {
  configured = true;
  output: AgentOutput = { reply: 'Review this exact update.', proposals: [] };
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
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => f?.close());
async function prepared(transport: ProviderTransport) {
  const runtime = new Runtime();
  f = await messagingFixture(undefined, undefined, { runtime });
  const secrets = new IdentitySecrets(Buffer.alloc(32, 5).toString('base64'));
  const execution = new ExecutionWorker(f.db, runtime, () => {}, secrets);
  const created = await f.call(f.owner, 'POST', '/v1/connections', {
    provider: 'github',
    name: 'Native repository',
    audience: 'workspace',
    credential: 'private-native-secret',
    allowWrites: true,
  });
  expect(created.statusCode, created.body).toBe(201);
  const connection = created.json().id;
  const a = await f.call(f.owner, 'POST', '/v1/agents', {
    name: 'Native writer',
    role: 'Propose explicitly requested field changes',
    runtime: 'managed',
  });
  const agentId = a.json().id,
    current = (await f.call(f.owner, 'GET', '/v1/agents/' + agentId)).json();
  const revised = await f.call(f.owner, 'POST', `/v1/agents/${agentId}/revisions`, {
    version: current.version,
    configuration: { ...current.configuration, tools: ['connection_action'] },
  });
  expect(revised.statusCode, revised.body).toBe(200);
  const [agent] = await f.db.query('SELECT membership_id FROM agents WHERE id=$1', [agentId]);
  const granted = await f.call(f.owner, 'PUT', `/v1/connections/${connection}/grants`, {
    memberId: agent!.membership_id,
    resources: ['acme/orbit/7'],
    operations: ['issue.update'],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  expect(granted.statusCode, granted.body).toBe(200);
  runtime.output.proposals = [
    {
      tool: 'connection_action',
      parameters: {
        connectionId: connection,
        operation: 'issue.update',
        payload: JSON.stringify({
          resource: 'acme/orbit/7',
          patch: { title: 'After' },
          expected: { title: 'Before' },
        }),
      },
    },
  ];
  const run = await f.call(f.owner, 'POST', '/v1/runs', {
    agentId,
    conversationId: f.ownerBoot.channels[0]!.id,
    prompt: 'Propose the reviewed repository issue update.',
    requestKey: randomUUID(),
  });
  expect(run.statusCode, run.body).toBe(201);
  await execution.tick();
  const [inv] = await f.db.query('SELECT * FROM tool_invocations WHERE run_id=$1', [run.json().id]);
  expect(inv).toBeDefined();
  const approved = await f.call(f.owner, 'POST', `/v1/approvals/${inv!.id}/decisions`, {
    decision: 'approved',
    digest: inv!.action_digest,
    reason: 'I reviewed the destination, changed fields and previous values.',
  });
  expect(approved.statusCode, approved.body).toBe(200);
  await execution.tick();
  const [action] = await f.db.query('SELECT * FROM tool_actions WHERE invocation_id=$1', [inv!.id]);
  expect(action!.state).toBe('prepared');
  const connections = new ConnectionService(f.db, secrets, {
    read: async () => {
      throw new Error('Unexpected import');
    },
  });
  const native = new NativeConnectorActions(f.db, connections, nativeWriteProvider(transport));
  const worker = new ToolActionWorker(
    f.db,
    secrets,
    async () => {
      throw new Error('Native actions must not use a generic proxy');
    },
    async () => {
      throw new Error('No sandbox');
    },
    () => {},
    native,
  );
  return { connection, agent: agent!.membership_id, inv: inv!, action: action!, worker };
}
describe('native connector writes through the hosted approval ledger', () => {
  it('requires grants and approval, dispatches once, and keeps credentials out of traces', async () => {
    const calls: Plan[] = [];
    const p = await prepared(async (plan) => {
      calls.push(plan);
      expect(plan.headers.authorization).toBe('Bearer private-native-secret');
      return {
        status: 200,
        body: JSON.stringify({ title: calls.length >= 2 ? 'After' : 'Before' }),
        retryAfter: 2,
      };
    });
    expect(calls).toHaveLength(0);
    await Promise.all([
      p.worker.process(f.ownerBoot.workspace.id, String(p.action.id)),
      p.worker.process(f.ownerBoot.workspace.id, String(p.action.id)),
    ]);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    const [ledger] = await f.db.query('SELECT * FROM tool_actions WHERE id=$1', [p.action.id]);
    expect(ledger!.state).toBe('succeeded');
    const detail = await f.call(f.owner, 'GET', `/v1/execution/actions/${p.inv.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.body).not.toContain('private-native-secret');
  });
  it('checks revocation again after preflight and before sending any write', async () => {
    let calls = 0;
    const p = await prepared(async () => {
      calls++;
      await f.db.query('UPDATE connection_grants SET revoked_at=now() WHERE connection_id=$1', [
        p.connection,
      ]);
      return { status: 200, body: JSON.stringify({ title: 'Before' }), retryAfter: 2 };
    });
    await p.worker.process(f.ownerBoot.workspace.id, String(p.action.id));
    expect(calls).toBe(1);
    const [ledger] = await f.db.query('SELECT state FROM tool_actions WHERE id=$1', [p.action.id]);
    expect(ledger!.state).toBe('failed');
  });
  it('reconciles a committed timeout without dispatching another mutation', async () => {
    let writes = 0,
      applied = false;
    const p = await prepared(async (plan) => {
      if (plan.method === 'PATCH') {
        writes++;
        applied = true;
        throw new Error('Timed out after provider commit');
      }
      return {
        status: 200,
        body: JSON.stringify({ title: applied ? 'After' : 'Before' }),
        retryAfter: 2,
      };
    });
    await p.worker.process(f.ownerBoot.workspace.id, String(p.action.id));
    let [ledger] = await f.db.query('SELECT * FROM tool_actions WHERE id=$1', [p.action.id]);
    expect(ledger!.state).toBe('outcome_unknown');
    await f.db.query(
      "UPDATE connections SET next_request_at=now()-interval '1 second' WHERE id=$1",
      [p.connection],
    );
    await p.worker.process(f.ownerBoot.workspace.id, String(p.action.id));
    [ledger] = await f.db.query('SELECT * FROM tool_actions WHERE id=$1', [p.action.id]);
    expect(ledger!.state).toBe('succeeded');
    expect(writes).toBe(1);
  });
  it('refuses native write grants on a read-only connection', async () => {
    f = await messagingFixture();
    const c = await f.call(f.owner, 'POST', '/v1/connections', {
      provider: 'github',
      name: 'Read-only repository',
      audience: 'workspace',
      credential: 'read-token',
    });
    const denied = await f.call(f.owner, 'PUT', `/v1/connections/${c.json().id}/grants`, {
      memberId: f.mateBoot.me.id,
      resources: ['acme/orbit/7'],
      operations: ['issue.update'],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(denied.statusCode).toBe(409);
  });
});
