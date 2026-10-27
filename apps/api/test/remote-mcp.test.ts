import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentOutput } from '@ao/contracts';
import type { HostedRuntime } from '../src/execution/types.js';
import type { RemoteMcp } from '../src/developer/remote-mcp.js';
import { messagingFixture } from './messaging-fixture.js';
import { ExecutionWorker } from '../src/execution/worker.js';
import { ToolActionWorker } from '../src/tools/worker.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
class Runtime implements HostedRuntime {
  configured = true;
  output: AgentOutput = { reply: 'Review the remote MCP action.', proposals: [] };
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
afterEach(async () => {
  await f?.close();
});
async function prepare(call: RemoteMcp['call']) {
  const runtime = new Runtime(),
    remote: RemoteMcp = {
      discover: async () => [
        {
          name: 'issue.update',
          description: 'Update an issue title',
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
            additionalProperties: false,
          },
        },
      ],
      call,
    };
  f = await messagingFixture(undefined, undefined, { runtime, remoteMcp: remote });
  const channel = f.ownerBoot.channels[0]!.id,
    created = await f.call(f.owner, 'POST', '/v1/execution/mcp', {
      name: 'Remote issues',
      url: 'https://mcp.example/server',
      token: 'remote-private-token',
      conversationIds: [channel],
    });
  expect(created.statusCode, created.body).toBe(201);
  const connection = created.json().id,
    publication = await f.call(f.owner, 'POST', `/v1/execution/mcp/${connection}/publication`, {
      version: 1,
      tools: [{ name: 'issue.update', effect: 'write' }],
    });
  expect(publication.statusCode, publication.body).toBe(200);
  const a = await f.call(f.owner, 'POST', '/v1/agents', {
      name: 'Remote writer',
      role: 'Propose reviewed remote writes',
      runtime: 'managed',
    }),
    agent = a.json().id,
    current = (await f.call(f.owner, 'GET', '/v1/agents/' + agent)).json();
  expect(
    (
      await f.call(f.owner, 'POST', `/v1/agents/${agent}/revisions`, {
        version: current.version,
        configuration: { ...current.configuration, tools: ['connection_action'] },
      })
    ).statusCode,
  ).toBe(200);
  const [member] = await f.db.query('SELECT membership_id FROM agents WHERE id=$1', [agent]);
  for (const memberId of [f.ownerBoot.me.id, member!.membership_id])
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/execution/connections/${connection}/grant`, {
          memberId,
          operations: ['mcp_0'],
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        })
      ).statusCode,
    ).toBe(200);
  runtime.output.proposals = [
    {
      tool: 'connection_action',
      parameters: {
        connectionId: connection,
        operation: 'mcp_0',
        payload: JSON.stringify({ title: 'Reviewed title' }),
      },
    },
  ];
  const run = await f.call(f.owner, 'POST', '/v1/runs', {
    agentId: agent,
    conversationId: channel,
    prompt: 'Propose the exact reviewed update',
    requestKey: randomUUID(),
  });
  expect(run.statusCode, run.body).toBe(201);
  const secrets = new IdentitySecrets(Buffer.alloc(32, 5).toString('base64')),
    execution = new ExecutionWorker(f.db, runtime, () => {}, secrets);
  await execution.tick();
  const [inv] = await f.db.query('SELECT * FROM tool_invocations WHERE run_id=$1', [run.json().id]);
  expect(inv).toBeDefined();
  const approve = await f.call(f.owner, 'POST', `/v1/approvals/${inv!.id}/decisions`, {
    decision: 'approved',
    digest: inv!.action_digest,
    reason: 'Reviewed the remote destination, arguments, and effects.',
  });
  expect(approve.statusCode, approve.body).toBe(200);
  await execution.tick();
  const [action] = await f.db.query('SELECT * FROM tool_actions WHERE invocation_id=$1', [inv!.id]);
  expect(action!.state).toBe('prepared');
  const worker = new ToolActionWorker(
    f.db,
    secrets,
    async () => {
      throw new Error('MCP must not use the generic adapter.');
    },
    async () => {
      throw new Error('No sandbox');
    },
    () => {},
    undefined,
    remote,
  );
  return { worker, action: action!, inv: inv!, connection, run: run.json().id };
}
describe('remote MCP approval integration', () => {
  it('uses owner grants, reviewed schemas, capabilities and the action ledger, while keeping remote credentials private', async () => {
    let writes = 0;
    const p = await prepare(async (url, token, name, args, _key, guard, tool) => {
      expect(url).toBe('https://mcp.example/server');
      expect(token).toBe('remote-private-token');
      expect(name).toBe('issue.update');
      expect(args).toEqual({ title: 'Reviewed title' });
      expect(tool?.inputSchema.required).toEqual(['title']);
      await guard();
      writes++;
      return { status: 'succeeded', receipt: 'mcp:test-receipt' };
    });
    await Promise.all([
      p.worker.process(f.ownerBoot.workspace.id, String(p.action.id)),
      p.worker.process(f.ownerBoot.workspace.id, String(p.action.id)),
    ]);
    expect(writes).toBe(1);
    expect(
      (await f.db.query('SELECT state FROM tool_actions WHERE id=$1', [p.action.id]))[0]!.state,
    ).toBe('succeeded');
    const detail = await f.call(f.owner, 'GET', '/v1/execution/actions/' + p.inv.id);
    expect(detail.body).not.toContain('remote-private-token');
  });
  it('does not repeat an uncertain MCP write during reconciliation', async () => {
    let calls = 0;
    const p = await prepare(async (_u, _t, _n, _a, _k, guard) => {
      await guard();
      calls++;
      throw new Error('Response lost after dispatch');
    });
    await p.worker.process(f.ownerBoot.workspace.id, String(p.action.id));
    expect(
      (await f.db.query('SELECT state FROM tool_actions WHERE id=$1', [p.action.id]))[0]!.state,
    ).toBe('outcome_unknown');
    await p.worker.process(f.ownerBoot.workspace.id, String(p.action.id));
    expect(calls).toBe(1);
  });
  it('invalidates approved actions after manifest refresh or credential rotation', async () => {
    let calls = 0;
    const p = await prepare(async () => {
      calls++;
      return { status: 'succeeded', receipt: 'unexpected' };
    });
    const refresh = await f.call(f.owner, 'POST', `/v1/execution/mcp/${p.connection}/refresh`, {});
    expect(refresh.statusCode, refresh.body).toBe(200);
    await p.worker.process(f.ownerBoot.workspace.id, String(p.action.id));
    expect(calls).toBe(0);
    expect(
      (await f.db.query('SELECT state FROM tool_actions WHERE id=$1', [p.action.id]))[0]!.state,
    ).toBe('failed');
  });
});
