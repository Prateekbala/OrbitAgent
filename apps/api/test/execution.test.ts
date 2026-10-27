import { testEmail, verifyFixtureAccount } from './email.js';
import { AccountService } from '../src/identity/service.js';
import { consumeAccountToken } from '../src/identity/tokens.js';
import { testDatabase } from './database.js';
import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  migrate,
  scopedDatabase,
  tenantScope,
  workerScope,
  identifyPrincipal,
  type Database,
} from '@ao/database';
import type { AgentOutput, ToolInvocation } from '@ao/contracts';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { ExecutionWorker } from '../src/execution/worker.js';
import { ToolGateway } from '../src/execution/gateway.js';
import type { HostedRuntime, RuntimeRequest } from '../src/execution/types.js';
import type { Identity } from '../src/lib/policy.js';
class TestRuntime implements HostedRuntime {
  configured = true;
  calls = 0;
  lastRequest: RuntimeRequest | null = null;
  cancelled: string[] = [];
  output: AgentOutput = {
    reply: 'I drafted the next step. It requires approval.',
    proposals: [
      {
        tool: 'create_task',
        parameters: {
          title: 'Review release',
          description: 'Verify release evidence.',
          priority: 'normal',
        },
      },
    ],
  };
  async createSession() {
    return randomUUID();
  }
  async generate(_session: string, request: RuntimeRequest, _signal: AbortSignal) {
    this.calls++;
    this.lastRequest = request;
    return this.output;
  }
  async recover() {
    return this.output;
  }
  async cancel(session: string) {
    this.cancelled.push(session);
  }
}
let db: Database,
  app: FastifyInstance,
  runtime: TestRuntime,
  worker: ExecutionWorker,
  ownerCookie: string,
  otherCookie: string,
  identity: Identity,
  channelId: string;
const cookie = (value: string) => ({ cookie: `ao_session=${value}` });
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
  runtime = new TestRuntime();
  app = await buildApp(db, { runtime, email: testEmail() });
  worker = new ExecutionWorker(db, runtime);
  for (const email of ['operator@example.test', 'outsider@example.test']) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        name: email.split('@')[0],
        email,
        password: 'execution-test-password',
        workspace: 'Execution Workspace',
      },
    });
    expect(response.statusCode).toBe(201);
    await verifyFixtureAccount(db, email);
    if (email.startsWith('operator')) ownerCookie = response.cookies[0]!.value;
    else otherCookie = response.cookies[0]!.value;
  }
  const bootstrap = (
    await app.inject({ url: '/v1/bootstrap', headers: cookie(ownerCookie) })
  ).json();
  channelId = bootstrap.channels[0].id;
  identity = {
    workspaceId: bootstrap.workspace.id,
    membershipId: bootstrap.me.id,
    name: bootstrap.me.name,
    kind: 'human',
    role: 'owner',
  };
}, 30000);
afterAll(async () => {
  await app.close();
  await db.close();
});
afterEach(async () => {
  await db.query(
    "UPDATE agent_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL WHERE status='outcome_unknown'",
  );
});
function testGateway() {
  const gateway = new ToolGateway(scopedDatabase(db));
  return {
    execute: (id: string) => workerScope(identity.workspaceId, () => gateway.execute(id)),
    decide: (...args: Parameters<ToolGateway['decide']>) =>
      tenantScope(identity.workspaceId, () => {
        identifyPrincipal(args[0].membershipId, args[0].accessType ?? 'member');
        return gateway.decide(...args);
      }),
  };
}
async function managedAgent() {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: cookie(ownerCookie),
    payload: {
      name: 'Managed-' + randomUUID().slice(0, 8),
      role: 'Plan work with evidence.',
      runtime: 'managed',
    },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().key).toBeUndefined();
  return response.json().id as string;
}
async function queue(agentId?: string, conversationId = channelId, session = ownerCookie) {
  const id = agentId ?? (await managedAgent());
  const input = {
    agentId: id,
    conversationId,
    prompt: 'Plan the release review.',
    requestKey: randomUUID(),
  };
  const response = await app.inject({
    method: 'POST',
    url: '/v1/runs',
    headers: cookie(session),
    payload: input,
  });
  expect(response.statusCode).toBe(201);
  return { id: response.json().id as string, input };
}
async function actions(runId: string) {
  return (await app.inject({ url: '/v1/approvals', headers: cookie(ownerCookie) }))
    .json<ToolInvocation[]>()
    .filter((a) => a.run_id === runId);
}
async function approve(action: ToolInvocation, override: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/v1/approvals/${action.id}/decisions`,
    headers: cookie(ownerCookie),
    payload: { decision: 'approved', digest: action.action_digest, ...override },
  });
}
async function state(runId: string) {
  const [row] = await db.query('SELECT status,error_code FROM agent_runs WHERE id=$1', [runId]);
  return row;
}
describe('hosted execution and tool approval', () => {
  it('deduplicates queued run requests and rejects conflicting reuse', async () => {
    const run = await queue();
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: cookie(ownerCookie),
      payload: run.input,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().id).toBe(run.id);
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: cookie(ownerCookie),
      payload: { ...run.input, prompt: 'changed' },
    });
    expect(conflict.statusCode).toBe(409);
    await worker.tick();
  });
  it('publishes an attributed reply but does not mutate tasks before approval', async () => {
    const run = await queue();
    const before = await db.query('SELECT id FROM tasks');
    await worker.tick();
    expect((await state(run.id))?.status).toBe('awaiting_approval');
    const [action] = await actions(run.id);
    expect(action?.status).toBe('pending');
    expect(await db.query('SELECT id FROM tasks')).toHaveLength(before.length);
    const [reply] = await db.query(
      'SELECT m.body,a.kind FROM messages m JOIN memberships a ON a.id=m.author_id WHERE m.client_id=$1',
      [run.id],
    );
    expect(reply?.kind).toBe('agent');
    expect(runtime.lastRequest?.runId).toBe(run.id);
  });
  it('executes an approved action atomically once, including concurrent duplicate attempts', async () => {
    const run = await queue();
    await worker.tick();
    const [action] = await actions(run.id);
    expect((await approve(action!)).statusCode).toBe(200);
    const gateway = testGateway();
    await Promise.all([gateway.execute(action!.id), gateway.execute(action!.id)]);
    const [stored] = await actions(run.id);
    expect(stored?.status).toBe('succeeded');
    expect((await state(run.id))?.status).toBe('succeeded');
    expect(
      await db.query('SELECT id FROM tasks WHERE id=$1', [stored!.result!.resourceId]),
    ).toHaveLength(1);
    expect((await approve(action!)).statusCode).toBe(409);
  });
  it('rejects cross-tenant approval and stale action digests', async () => {
    const run = await queue();
    await worker.tick();
    const [action] = await actions(run.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/approvals/${action!.id}/decisions`,
          headers: cookie(otherCookie),
          payload: { decision: 'approved', digest: action!.action_digest },
        })
      ).statusCode,
    ).toBe(404);
    expect((await approve(action!, { digest: '0'.repeat(64) })).statusCode).toBe(409);
    expect((await actions(run.id))[0]?.status).toBe('pending');
  });
  it('expires pending approval without executing a tool', async () => {
    const run = await queue();
    await worker.tick();
    const [action] = await actions(run.id);
    await db.query("UPDATE tool_invocations SET expires_at=now()-interval '1 second' WHERE id=$1", [
      action!.id,
    ]);
    expect((await approve(action!)).statusCode).toBe(409);
    await worker.tick();
    expect((await actions(run.id))[0]?.status).toBe('expired');
  });
  it('does not execute a rejected action', async () => {
    const run = await queue();
    await worker.tick();
    const [action] = await actions(run.id);
    expect(
      (await approve(action!, { decision: 'rejected', reason: 'The request needs clarification.' }))
        .statusCode,
    ).toBe(200);
    await testGateway().execute(action!.id);
    expect((await actions(run.id))[0]?.status).toBe('rejected');
  });
  it('cancellation fences already approved actions', async () => {
    const run = await queue();
    await worker.tick();
    const [action] = await actions(run.id);
    await approve(action!);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/runs/${run.id}/cancel`,
          headers: cookie(ownerCookie),
        })
      ).statusCode,
    ).toBe(200);
    await testGateway().execute(action!.id);
    expect((await actions(run.id))[0]?.status).toBe('cancelled');
    expect((await state(run.id))?.status).toBe('cancelled');
  });
  it('rechecks approval parameters at execution time', async () => {
    const run = await queue();
    await worker.tick();
    const [action] = await actions(run.id);
    await approve(action!);
    await db.query('UPDATE tool_invocations SET parameters=$1 WHERE id=$2', [
      JSON.stringify({
        title: 'Tampered title',
        description: 'Changed after approval',
        priority: 'high',
      }),
      action!.id,
    ]);
    await expect(testGateway().execute(action!.id)).rejects.toThrow(
      'Approval authority or action parameters changed.',
    );
  });
  it('pausing an agent cancels its pending runs and approvals', async () => {
    const agentId = await managedAgent(),
      run = await queue(agentId);
    await worker.tick();
    const [action] = await actions(run.id);
    await approve(action!);
    await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${agentId}`,
      headers: cookie(ownerCookie),
      payload: { status: 'paused' },
    });
    await testGateway().execute(action!.id);
    expect((await state(run.id))?.status).toBe('cancelled');
    expect((await actions(run.id))[0]?.status).toBe('cancelled');
  });
  it('marks a lost execution lease unknown and never redispatches it', async () => {
    const run = await queue();
    await db.query(
      "UPDATE agent_runs SET status='running',lease_expires_at=now()-interval '1 second',dispatch_started=true WHERE id=$1",
      [run.id],
    );
    const before = runtime.calls;
    await worker.tick();
    expect((await state(run.id))?.status).toBe('outcome_unknown');
    expect(runtime.calls).toBe(before);
  });
  it('does not cross private-conversation boundaries in context or tool artifacts', async () => {
    const privateChannel = (
      await app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: cookie(ownerCookie),
        payload: { name: 'private-execution', visibility: 'private' },
      })
    ).json().id;
    const agentId = await managedAgent();
    const [member] = await db.query('SELECT membership_id FROM agents WHERE id=$1', [agentId]);
    await app.inject({
      method: 'POST',
      url: `/v1/conversations/${privateChannel}/members`,
      headers: cookie(ownerCookie),
      payload: { membershipId: member!.membership_id },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/conversations/${channelId}/messages`,
      headers: cookie(ownerCookie),
      payload: { body: 'public-source-not-for-private-context', clientId: randomUUID() },
    });
    const run = await queue(agentId, privateChannel);
    await worker.tick();
    expect(runtime.lastRequest?.context).not.toContain('public-source-not-for-private-context');
    const [action] = await actions(run.id);
    await approve(action!);
    await testGateway().execute(action!.id);
    const [task] = await db.query('SELECT conversation_id FROM tasks WHERE id=$1', [
      (await actions(run.id))[0]!.result!.resourceId,
    ]);
    expect(task?.conversation_id).toBe(privateChannel);
    const outsiderTasks = (
      await app.inject({ url: '/v1/tasks', headers: cookie(otherCookie) })
    ).json();
    expect(outsiderTasks).toEqual([]);
  });
  it('reconciles a settled hosted result without sending a new model request', async () => {
    const run = await queue();
    const sessionId = randomUUID();
    await db.query("UPDATE agent_runs SET status='outcome_unknown',session_id=$1 WHERE id=$2", [
      sessionId,
      run.id,
    ]);
    const before = runtime.calls;
    const response = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/reconcile`,
      headers: cookie(ownerCookie),
    });
    expect(response.statusCode).toBe(200);
    expect(runtime.calls).toBe(before);
    expect((await state(run.id))?.status).toBe('awaiting_approval');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/runs/${run.id}/reconcile`,
          headers: cookie(ownerCookie),
        })
      ).statusCode,
    ).toBe(409);
    expect(await db.query('SELECT id FROM messages WHERE client_id=$1', [run.id])).toHaveLength(1);
  });
  it('saves knowledge only in the run audience after approval', async () => {
    const original = runtime.output;
    runtime.output = {
      reply: 'I proposed a decision record.',
      proposals: [
        {
          tool: 'save_knowledge',
          parameters: {
            title: 'Review procedure',
            body: 'Verify the evidence before accepting release work.',
          },
        },
      ],
    };
    try {
      const run = await queue();
      await worker.tick();
      const [action] = await actions(run.id);
      await approve(action!);
      await testGateway().execute(action!.id);
      const resource = (await actions(run.id))[0]!.result!.resourceId;
      const [page] = await db.query('SELECT conversation_id FROM knowledge_pages WHERE id=$1', [
        resource,
      ]);
      expect(page?.conversation_id).toBe(channelId);
      expect(
        await db.query('SELECT id FROM knowledge_versions WHERE page_id=$1', [resource]),
      ).toHaveLength(1);
    } finally {
      runtime.output = original;
    }
  });
  it('rechecks source access before executing an approved tool', async () => {
    const privateChannel = (
      await app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: cookie(ownerCookie),
        payload: { name: 'revocation-' + randomUUID().slice(0, 8), visibility: 'private' },
      })
    ).json().id;
    const agent = await managedAgent();
    const [membership] = await db.query('SELECT membership_id FROM agents WHERE id=$1', [agent]);
    await app.inject({
      method: 'POST',
      url: `/v1/conversations/${privateChannel}/members`,
      headers: cookie(ownerCookie),
      payload: { membershipId: membership!.membership_id },
    });
    const run = await queue(agent, privateChannel);
    await worker.tick();
    const [action] = await actions(run.id);
    await approve(action!);
    await db.query(
      'DELETE FROM conversation_members WHERE conversation_id=$1 AND membership_id=$2',
      [privateChannel, membership!.membership_id],
    );
    await expect(testGateway().execute(action!.id)).rejects.toThrow(
      'The requested resource is unavailable.',
    );
  });
  it('fences a late model result after cancellation', async () => {
    const run = await queue();
    let markStarted: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = new TestRuntime();
    delayed.generate = async () => {
      markStarted();
      await gate;
      return delayed.output;
    };
    const active = new ExecutionWorker(db, delayed).tick();
    await started;
    await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: cookie(ownerCookie),
    });
    release();
    await active;
    expect((await state(run.id))?.status).toBe('cancelled');
    expect(await actions(run.id)).toEqual([]);
    expect(await db.query('SELECT id FROM messages WHERE client_id=$1', [run.id])).toEqual([]);
  });
  it('does not publish or execute anything after a runtime transport failure', async () => {
    const run = await queue();
    const unavailable = new TestRuntime();
    unavailable.generate = async () => {
      throw new Error('simulated transport interruption');
    };
    await new ExecutionWorker(db, unavailable).tick();
    expect((await state(run.id))?.status).toBe('outcome_unknown');
    expect(await actions(run.id)).toEqual([]);
    expect(await db.query('SELECT id FROM messages WHERE client_id=$1', [run.id])).toEqual([]);
  });
  it('requires a current human administrator for approval', async () => {
    const run = await queue();
    await worker.tick();
    const [action] = await actions(run.id);
    await expect(
      testGateway().decide(
        { ...identity, kind: 'agent', role: 'member' },
        action!.id,
        'approved',
        action!.action_digest,
        '',
      ),
    ).rejects.toThrow('An administrator must perform this action.');
  });
  it('fails closed when the managed runtime is not configured', async () => {
    const unavailable = await buildApp(db, { email: testEmail() });
    try {
      const response = await unavailable.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: cookie(ownerCookie),
        payload: {
          agentId: await managedAgent(),
          conversationId: channelId,
          prompt: 'Request',
          requestKey: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await unavailable.close();
    }
  });
  async function invitedPerson(role: 'admin' | 'member') {
    const email = `${randomUUID()}@execution.test`;
    const link = await app.inject({
      method: 'POST',
      url: '/v1/invitations',
      headers: cookie(ownerCookie),
      payload: { email, role },
    });
    expect(link.statusCode).toBe(201);
    const joined = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: {
        token: link.json().token,
        name: 'Execution Teammate',
        password: 'execution-invited-password',
      },
    });
    expect(joined.statusCode).toBe(201);
    await verifyFixtureAccount(db, email);
    const session = joined.cookies[0]!.value;
    const boot = (await app.inject({ url: '/v1/bootstrap', headers: cookie(session) })).json();
    return { id: boot.me.id as string, session, email };
  }
  it('fences queued work and pending proposals when their requester is suspended', async () => {
    const person = await invitedPerson('member');
    const pending = await queue(undefined, channelId, person.session);
    await worker.tick();
    const queued = await queue(undefined, channelId, person.session);
    const uncertain = await queue(undefined, channelId, person.session);
    await db.query("UPDATE agent_runs SET status='outcome_unknown' WHERE id=$1", [uncertain.id]);
    const suspended = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${person.id}`,
      headers: cookie(ownerCookie),
      payload: { status: 'suspended', version: 1 },
    });
    expect(suspended.statusCode).toBe(200);
    expect((await state(pending.id))?.status).toBe('cancelled');
    expect((await state(queued.id))?.status).toBe('cancelled');
    expect((await state(uncertain.id))?.status).toBe('cancelled');
    expect((await actions(pending.id)).every((action) => action.status === 'cancelled')).toBe(true);
  });
  it('does not execute a recorded approval after its approver is suspended', async () => {
    const person = await invitedPerson('admin');
    const run = await queue();
    await worker.tick();
    const [action] = await actions(run.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/approvals/${action!.id}/decisions`,
          headers: cookie(person.session),
          payload: { decision: 'approved', digest: action!.action_digest },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/members/${person.id}`,
          headers: cookie(ownerCookie),
          payload: { status: 'suspended', version: 1 },
        })
      ).statusCode,
    ).toBe(200);
    await expect(testGateway().execute(action!.id)).rejects.toThrow(
      'Approval authority or action parameters changed.',
    );
    await worker.tick();
    expect((await actions(run.id))[0]?.status).toBe('failed');
  });
  async function recoverPerson(email: string) {
    await new AccountService(scopedDatabase(db), testEmail()).request(email, 'reset_password');
    const [job] = await db.query(
      "SELECT j.id,j.ciphertext FROM email_jobs j JOIN account_tokens t ON t.id=j.account_token_id JOIN accounts a ON a.id=t.account_id WHERE a.email=$1 AND t.purpose='reset_password' AND t.consumed_at IS NULL",
      [email],
    );
    const message = testEmail().decrypt(String(job!.id), String(job!.ciphertext));
    const token = message.text.match(/#([A-Za-z0-9_-]{43})/)![1]!;
    await consumeAccountToken(
      scopedDatabase(db),
      token,
      'reset_password',
      'recovered-execution-password',
    );
  }
  it('refuses queued execution under a credential version superseded by password recovery', async () => {
    const person = await invitedPerson('member');
    const run = await queue(undefined, channelId, person.session);
    const before = runtime.calls;
    await recoverPerson(person.email);
    await worker.tick();
    expect(runtime.calls).toBe(before);
    expect((await state(run.id))?.status).toBe('failed');
    expect(await actions(run.id)).toHaveLength(0);
  });
  it('invalidates a recorded approval after its approver recovers their password', async () => {
    const person = await invitedPerson('admin');
    const run = await queue();
    await worker.tick();
    const [action] = await actions(run.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/approvals/${action!.id}/decisions`,
          headers: cookie(person.session),
          payload: { decision: 'approved', digest: action!.action_digest },
        })
      ).statusCode,
    ).toBe(200);
    await recoverPerson(person.email);
    await expect(testGateway().execute(action!.id)).rejects.toThrow(
      'Approval authority or action parameters changed.',
    );
    await worker.tick();
    expect((await actions(run.id))[0]?.status).toBe('failed');
  });
});
