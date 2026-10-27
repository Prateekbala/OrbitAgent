import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  identifyAgentCredential,
  identifyPrincipal,
  scopedDatabase,
  tenantScope,
} from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { ExecutionWorker } from '../src/execution/worker.js';
import {
  AgentDeliveryWorker,
  validateWebhookUrl,
  webhookSignature,
} from '../src/agents/webhooks.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
import type { AgentOutput } from '@ao/contracts';
import type { HostedRuntime, RuntimeRequest } from '../src/execution/types.js';
class Runtime implements HostedRuntime {
  configured = true;
  capabilities = {
    models: ['approved/test'],
    durableCheckpoints: true,
    resumeObservation: true,
    maxSeconds: 86400,
  };
  calls = 0;
  observations = 0;
  requests: RuntimeRequest[] = [];
  fail = false;
  output: AgentOutput = { reply: 'Verified result from supplied evidence.', proposals: [] };
  async createSession() {
    return randomUUID();
  }
  async generate(_session: string, request: RuntimeRequest) {
    this.calls++;
    this.requests.push(request);
    if (this.fail) throw new Error('Provider response lost.');
    return this.output;
  }
  async recover() {
    return this.output;
  }
  async observe() {
    this.observations++;
    return {
      output: this.output,
      usage: { inputTokens: 100, outputTokens: 20, costMicros: 10000 },
    };
  }
  async cancel() {}
}
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
async function agent(
  runtime: 'managed' | 'external' = 'managed',
  name = 'Agent ' + randomUUID().slice(0, 8),
) {
  const response = await f.call(f.owner, 'POST', '/v1/agents', {
    name,
    role: 'Plan and verify work using supplied evidence.',
    runtime,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; key?: string };
}
async function queue(agentId: string, key = randomUUID(), session = f.owner) {
  const response = await f.call(session, 'POST', '/v1/runs', {
    agentId,
    conversationId: f.ownerBoot.channels[0]!.id,
    prompt: 'Verify the release plan.',
    requestKey: key,
  });
  expect([200, 201], response.body).toContain(response.statusCode);
  return response.json().id as string;
}
async function detail(id: string) {
  return (await f.call(f.owner, 'GET', `/v1/agents/${id}`)).json();
}
async function revise(id: string, extra: Record<string, unknown>) {
  const current = await detail(id);
  const response = await f.call(f.owner, 'POST', `/v1/agents/${id}/revisions`, {
    version: current.version,
    configuration: { ...current.configuration, ...extra },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response;
}
async function bearer(key: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return f.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${key}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}
async function mention(id: string) {
  const [member] = await f.db.query('SELECT membership_id FROM agents WHERE id=$1', [id]);
  const sent = await f.call(
    f.owner,
    'POST',
    `/v1/conversations/${f.ownerBoot.channels[0]!.id}/messages`,
    {
      body: `[@Agent](mention:${member!.membership_id}) investigate this release`,
      format: 'markdown',
      clientId: randomUUID(),
    },
  );
  expect(sent.statusCode, sent.body).toBe(201);
  return sent.json().id as string;
}
async function delegation(parent: string, target: string, extra: Record<string, unknown> = {}) {
  return f.call(f.owner, 'POST', `/v1/runs/${parent}/delegations`, {
    requestKey: randomUUID(),
    agentId: target,
    ownerId: f.ownerBoot.me.id,
    verifierId: f.mateBoot.me.id,
    prompt: 'Independently prepare release evidence.',
    outputContract: 'Return reproducible checks and unresolved findings.',
    stopCondition: 'Stop if supplied evidence is incomplete.',
    deadline: new Date(Date.now() + 3600000).toISOString(),
    budgetMicros: 500000,
    ...extra,
  });
}

describe('agent lifecycle and scoped credentials', () => {
  it('fences active hosted work when its source message is deleted and preserves its delivery accounting', async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
        release = resolve;
      }),
      runtime = new Runtime();
    runtime.generate = async () => {
      runtime.calls++;
      await pending;
      return runtime.output;
    };
    f = await messagingFixture(undefined, undefined, { runtime });
    const a = await agent(),
      source = await mention(a.id),
      worker = new ExecutionWorker(f.db, runtime);
    await worker.tick(false);
    await expect.poll(() => runtime.calls).toBe(1);
    const [delivery] = await f.db.query('SELECT id,run_id FROM agent_inbox WHERE message_id=$1', [
      source,
    ]);
    expect(delivery?.run_id).toBeTruthy();
    const removed = await f.call(f.owner, 'DELETE', `/v1/messages/${source}`, { version: 1 });
    expect(removed.statusCode, removed.body).toBe(200);
    release();
    await expect
      .poll(
        async () =>
          (
            await f.db.query('SELECT state FROM execution_reservations WHERE run_id=$1', [
              delivery!.run_id,
            ])
          )[0]!.state,
      )
      .toBe('settled');
    expect(
      (await f.db.query('SELECT status FROM agent_runs WHERE id=$1', [delivery!.run_id]))[0]!
        .status,
    ).toBe('cancelled');
    expect(
      await f.db.query('SELECT id FROM messages WHERE client_id=$1', [delivery!.run_id]),
    ).toHaveLength(0);
    expect(
      (await f.db.query('SELECT state FROM agent_inbox WHERE id=$1', [delivery!.id]))[0]!.state,
    ).toBe('dead');
  });
  it('versions immutable instructions, fences prior runs, and preserves conflict drafts at the API boundary', async () => {
    const runtime = new Runtime();
    f = await messagingFixture(undefined, undefined, { runtime });
    const a = await agent(),
      run = await queue(a.id),
      initial = await detail(a.id);
    await revise(a.id, {
      instructions: 'Use the new reviewed instructions.',
      skills: ['verification'],
      tools: [],
      activation: 'manual',
    });
    expect((await f.db.query('SELECT status FROM agent_runs WHERE id=$1', [run]))[0]!.status).toBe(
      'cancelled',
    );
    const stale = await f.call(f.owner, 'POST', `/v1/agents/${a.id}/revisions`, {
      version: initial.version,
      configuration: initial.configuration,
    });
    expect(stale.statusCode).toBe(409);
    const revisions = (await f.call(f.owner, 'GET', `/v1/agents/${a.id}/revisions`)).json();
    expect(revisions.items.map((v: { revision: number }) => v.revision)).toEqual([2, 1]);
    await expect(
      f.db.query('UPDATE agent_revisions SET configuration=$2 WHERE agent_id=$1', [
        a.id,
        JSON.stringify(initial.configuration),
      ]),
    ).rejects.toThrow('immutable');
    expect((await f.call(f.other, 'GET', `/v1/agents/${a.id}`)).statusCode).toBe(404);
  });
  it('scopes credential permissions and conversations at the database boundary, then expires and revokes them', async () => {
    f = await messagingFixture();
    const a = await agent('external'),
      allowed = f.ownerBoot.channels[0]!.id,
      hidden = f.ownerBoot.channels[1]!.id;
    await f.send(f.owner, allowed, 'Allowed delivery content');
    await f.send(f.owner, hidden, 'Hidden scoped credential content');
    const created = await f.call(f.owner, 'POST', `/v1/agents/${a.id}/credentials`, {
      name: 'Narrow receiver',
      scopes: ['messages.read'],
      conversationIds: [allowed],
      expiresInDays: 1,
    });
    expect(created.statusCode, created.body).toBe(200);
    const { id, key } = created.json();
    expect((await bearer(key, 'GET', `/v1/conversations/${allowed}/messages`)).json()).toHaveLength(
      1,
    );
    expect((await bearer(key, 'GET', `/v1/conversations/${hidden}/messages`)).statusCode).toBe(404);
    expect((await bearer(key, 'GET', '/v1/agent/inbox')).statusCode).toBe(403);
    const member = (await f.db.query('SELECT membership_id FROM agents WHERE id=$1', [a.id]))[0]!
      .membership_id as string;
    const rows = await tenantScope(f.ownerBoot.workspace.id, () => {
      identifyPrincipal(member, 'member');
      identifyAgentCredential(id);
      return scopedDatabase(f.db).query('SELECT body FROM messages');
    });
    expect(rows.map((row) => row.body)).toEqual(['Allowed delivery content']);
    expect(JSON.stringify(await detail(a.id))).not.toContain(key);
    await f.db.query(
      "UPDATE agent_credentials SET expires_at=now()-interval '1 second',created_at=now()-interval '1 day' WHERE id=$1",
      [id],
    );
    expect((await bearer(key, 'GET', `/v1/conversations/${allowed}/messages`)).statusCode).toBe(
      401,
    );
    await f.db.query(
      "UPDATE agent_credentials SET created_at=now(),expires_at=now()+interval '1 day' WHERE id=$1",
      [id],
    );
    const revoke = await f.call(f.owner, 'DELETE', `/v1/agents/${a.id}/credentials/${id}`);
    expect(revoke.statusCode).toBe(200);
    expect((await bearer(key, 'GET', `/v1/conversations/${allowed}/messages`)).statusCode).toBe(
      401,
    );
    const rotated = await f.call(f.owner, 'POST', `/v1/agents/${a.id}/credentials/rotate`, {});
    expect(rotated.statusCode, rotated.body).toBe(200);
    const [replacement] = await f.db.query(
      'SELECT scopes,conversation_ids FROM agent_credentials WHERE id=$1',
      [rotated.json().id],
    );
    expect(replacement).toMatchObject({ scopes: ['messages.read'], conversation_ids: [allowed] });
  });
  it('transfers ownership, revokes every old connection, archives and restores without erasing history', async () => {
    f = await messagingFixture();
    const a = await agent('external');
    let current = await detail(a.id);
    const transfer = await f.call(f.owner, 'POST', `/v1/agents/${a.id}/lifecycle`, {
      version: current.version,
      status: 'active',
      ownerId: f.mateBoot.me.id,
    });
    expect(transfer.statusCode, transfer.body).toBe(200);
    current = await detail(a.id);
    expect(current.status).toBe('paused');
    expect(current.owner_id).toBe(f.mateBoot.me.id);
    expect((await bearer(a.key!, 'GET', '/v1/agent/inbox')).statusCode).toBe(401);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/agents/${a.id}/lifecycle`, {
          version: current.version,
          status: 'archived',
        })
      ).statusCode,
    ).toBe(200);
    current = await detail(a.id);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/agents/${a.id}/credentials`, {
          name: 'Forbidden archived key',
          scopes: ['inbox.read'],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/agents/${a.id}/lifecycle`, {
          version: current.version,
          status: 'paused',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await detail(a.id)).credentials.every((value: { revoked_at: string }) =>
        Boolean(value.revoked_at),
      ),
    ).toBe(true);
  });
  it('leases exactly once, fences stale receivers, retries expired leases and records idempotent completion', async () => {
    f = await messagingFixture();
    const a = await agent('external');
    await mention(a.id);
    const inbox = (await bearer(a.key!, 'GET', '/v1/agent/inbox')).json();
    expect(inbox).toHaveLength(1);
    const delivery = inbox[0].id;
    const claims = await Promise.all([
      bearer(a.key!, 'POST', `/v1/agent/inbox/${delivery}/lease`, {}),
      bearer(a.key!, 'POST', `/v1/agent/inbox/${delivery}/lease`, {}),
    ]);
    expect(claims.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const lease = claims.find((r) => r.statusCode === 200)!.json();
    await f.db.query(
      "UPDATE agent_inbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [delivery],
    );
    await bearer(a.key!, 'GET', '/v1/agent/inbox');
    await f.db.query("UPDATE agent_inbox SET available_at=now()-interval '1 second' WHERE id=$1", [
      delivery,
    ]);
    const renewed = (await bearer(a.key!, 'POST', `/v1/agent/inbox/${delivery}/lease`, {})).json();
    expect(renewed.fence).toBeGreaterThan(lease.fence);
    const report = {
      leaseToken: lease.lease_token,
      fence: lease.fence,
      outcome: 'completed',
      summary: 'Durably completed the requested investigation.',
    };
    expect(
      (await bearer(a.key!, 'POST', `/v1/agent/inbox/${delivery}/result`, report)).statusCode,
    ).toBe(409);
    report.leaseToken = renewed.lease_token;
    report.fence = renewed.fence;
    expect(
      (
        await bearer(a.key!, 'POST', `/v1/agent/inbox/${delivery}/heartbeat`, {
          leaseToken: renewed.lease_token,
          fence: renewed.fence,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await bearer(a.key!, 'POST', `/v1/agent/inbox/${delivery}/result`, report)).statusCode,
    ).toBe(200);
    expect(
      (await bearer(a.key!, 'POST', `/v1/agent/inbox/${delivery}/result`, report)).json().replayed,
    ).toBe(true);
    expect(
      (await f.db.query('SELECT state,attempts FROM agent_inbox WHERE id=$1', [delivery]))[0],
    ).toMatchObject({ state: 'completed', attempts: 2 });
  });
  it('dead-letters exhausted deliveries and requires an administrator for explicit redelivery', async () => {
    f = await messagingFixture();
    const a = await agent('external');
    await mention(a.id);
    const delivery = (await bearer(a.key!, 'GET', '/v1/agent/inbox')).json()[0].id;
    await bearer(a.key!, 'POST', `/v1/agent/inbox/${delivery}/lease`, {});
    await f.db.query(
      "UPDATE agent_inbox SET attempts=5,lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [delivery],
    );
    await bearer(a.key!, 'GET', '/v1/agent/inbox');
    expect(
      (await f.db.query('SELECT state FROM agent_inbox WHERE id=$1', [delivery]))[0]!.state,
    ).toBe('dead');
    expect(
      (await f.call(f.mate, 'POST', `/v1/agents/${a.id}/deliveries/${delivery}/retry`, {}))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.call(f.owner, 'POST', `/v1/agents/${a.id}/deliveries/${delivery}/retry`, {}))
        .statusCode,
    ).toBe(200);
    expect((await bearer(a.key!, 'GET', '/v1/agent/inbox')).json()).toHaveLength(1);
  });
  it('delivers signed, retryable wake-ups without message content and publishes recipient-private realtime events', async () => {
    f = await messagingFixture();
    const a = await agent('external'),
      secrets = new IdentitySecrets(Buffer.alloc(32, 5).toString('base64')),
      signing = 'test-signing-secret';
    await f.db.query(
      'INSERT INTO agent_webhooks(workspace_id,agent_id,url,encrypted_secret) VALUES($1,$2,$3,$4)',
      [
        f.ownerBoot.workspace.id,
        a.id,
        'https://receiver.example.test/hook',
        secrets.seal(`agent-webhook:${f.ownerBoot.workspace.id}:${a.id}`, signing),
      ],
    );
    await mention(a.id);
    const deliveries: { headers: Record<string, string>; body: string }[] = [];
    const worker = new AgentDeliveryWorker(f.db, secrets, async (_url, headers, body) => {
      deliveries.push({ headers, body });
      return deliveries.length === 1 ? 503 : 204;
    });
    await worker.tick();
    await f.db.query("UPDATE agent_wakeups SET available_at=now()-interval '1 second'");
    await worker.tick();
    expect(deliveries).toHaveLength(2);
    expect(JSON.parse(deliveries[0]!.body).id).toBe(JSON.parse(deliveries[1]!.body).id);
    const first = deliveries[0]!;
    expect(first.headers['webhook-signature']).toBe(
      'v1=' +
        webhookSignature(
          signing,
          first.headers['webhook-id']!,
          first.headers['webhook-timestamp']!,
          first.body,
        ),
    );
    expect(first.body).not.toContain('investigate this release');
    expect((await f.db.query('SELECT state,attempts FROM agent_wakeups'))[0]).toMatchObject({
      state: 'delivered',
      attempts: 2,
    });
    expect(
      (await bearer(a.key!, 'GET', '/v1/events'))
        .json()
        .events.some((event: { event_type: string }) => event.event_type === 'agent.inbox_ready'),
    ).toBe(true);
    expect(
      (await f.call(f.owner, 'GET', '/v1/events'))
        .json()
        .events.some((event: { event_type: string }) => event.event_type === 'agent.inbox_ready'),
    ).toBe(false);
    await expect(validateWebhookUrl('http://127.0.0.1/hook', ['127.0.0.1'])).rejects.toThrow(
      'HTTPS',
    );
    await expect(validateWebhookUrl('https://127.0.0.1/hook', ['127.0.0.1'])).rejects.toThrow(
      'public',
    );
  });
});

describe('hosted admission, recovery and coordination', () => {
  it('rechecks resource capabilities after approval and omits task content from execution projections when task access is denied', async () => {
    const runtime = new Runtime();
    runtime.output = {
      reply: 'Review the proposed task.',
      proposals: [
        {
          tool: 'create_task',
          parameters: {
            title: 'Must respect resource permissions',
            description: 'This action must not borrow administrator authority.',
            priority: 'normal',
          },
        },
      ],
    };
    f = await messagingFixture(undefined, undefined, { runtime });
    const a = await agent(),
      run = await queue(a.id),
      worker = new ExecutionWorker(f.db, runtime);
    await worker.tick();
    const task = await f.call(f.owner, 'POST', '/v1/tasks', {
      title: 'Capability restricted linked task',
      conversationId: f.ownerBoot.channels[0]!.id,
    });
    expect(task.statusCode, task.body).toBe(201);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/tasks/${task.json().id}/runs`, {
          action: 'link',
          runId: run,
        })
      ).statusCode,
    ).toBe(200);
    const [action] = (await f.call(f.owner, 'GET', '/v1/approvals')).json();
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/approvals/${action.id}/decisions`, {
          decision: 'approved',
          digest: action.action_digest,
        })
      ).statusCode,
    ).toBe(200);
    await f.db.query(
      'UPDATE memberships SET permissions=permissions||\'{"tasks.read":false,"tasks.write":false}\'::jsonb WHERE id=$1',
      [f.ownerBoot.me.id],
    );
    await worker.tick();
    expect(
      (
        await f.db.query('SELECT status,error_code FROM tool_invocations WHERE id=$1', [action.id])
      )[0],
    ).toMatchObject({ status: 'failed', error_code: 'TOOL_PERMISSION_REQUIRED' });
    expect(
      await f.db.query("SELECT id FROM tasks WHERE title='Must respect resource permissions'"),
    ).toHaveLength(0);
    expect((await f.call(f.owner, 'GET', `/v1/runs/${run}/detail`)).json().tasks).toEqual([]);
  });
  it('counts private spending and open runs that the requester cannot discover', async () => {
    const runtime = new Runtime();
    f = await messagingFixture(undefined, undefined, { runtime });
    const first = await agent(),
      second = await agent(),
      privateOne = await f.channel('private'),
      privateTwo = await f.channel('private');
    for (const [agentId, conversation] of [
      [first.id, privateOne],
      [second.id, privateTwo],
    ]) {
      const [member] = await f.db.query('SELECT membership_id FROM agents WHERE id=$1', [agentId]);
      const grant = await f.call(f.owner, 'POST', `/v1/conversations/${conversation}/members`, {
        membershipId: member!.membership_id,
      });
      expect(grant.statusCode, grant.body).toBe(200);
    }
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/conversations/${privateTwo}/members`, {
          membershipId: f.mateBoot.me.id,
        })
      ).statusCode,
    ).toBe(200);
    await f.db.query('UPDATE execution_policies SET budget_micros=500000 WHERE workspace_id=$1', [
      f.ownerBoot.workspace.id,
    ]);
    const firstRun = await f.call(f.owner, 'POST', '/v1/runs', {
      agentId: first.id,
      conversationId: privateOne,
      prompt: 'Private funded request.',
      requestKey: randomUUID(),
    });
    expect(firstRun.statusCode, firstRun.body).toBe(201);
    expect((await f.call(f.mate, 'GET', `/v1/runs/${firstRun.json().id}`)).statusCode).toBe(404);
    const body = {
      agentId: second.id,
      conversationId: privateTwo,
      prompt: 'Another private request.',
      requestKey: randomUUID(),
    };
    const budget = await f.call(f.mate, 'POST', '/v1/runs', body);
    expect(budget.statusCode, budget.body).toBe(429);
    expect(budget.json().error.code).toBe('SPENDING_LIMIT');
    await f.db.query(
      'UPDATE execution_policies SET budget_micros=50000000,max_open_runs=1 WHERE workspace_id=$1',
      [f.ownerBoot.workspace.id],
    );
    const limited = await f.call(f.mate, 'POST', '/v1/runs', body);
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json().error.code).toBe('RUN_LIMIT');
    const foreign = await tenantScope(f.ownerBoot.workspace.id, () =>
      scopedDatabase(f.db).query('SELECT * FROM execution_totals($1)', [f.otherBoot.workspace.id]),
    );
    expect(Number(foreign[0]!.reserved_micros)).toBe(0);
  });
  it('gives another requester a slot while enforcing the first requester’s concurrency cap', async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
        release = resolve;
      }),
      runtime = new Runtime();
    runtime.generate = async () => {
      runtime.calls++;
      await pending;
      return runtime.output;
    };
    f = await messagingFixture(undefined, undefined, { runtime });
    const a = await agent(),
      b = await agent(),
      c = await agent();
    await f.db.query(
      'UPDATE execution_policies SET max_requester_concurrent=1,max_concurrent_runs=2 WHERE workspace_id=$1',
      [f.ownerBoot.workspace.id],
    );
    await queue(a.id);
    await queue(b.id);
    await queue(c.id, randomUUID(), f.mate);
    const workers = [
      new ExecutionWorker(f.db, runtime),
      new ExecutionWorker(f.db, runtime),
      new ExecutionWorker(f.db, runtime),
    ];
    for (const worker of workers) await worker.tick(false);
    const running = await f.db.query("SELECT requester_id FROM agent_runs WHERE status='running'");
    expect(running).toHaveLength(2);
    expect(new Set(running.map((row) => row.requester_id))).toEqual(
      new Set([f.ownerBoot.me.id, f.mateBoot.me.id]),
    );
    release();
    await expect
      .poll(async () =>
        Number(
          (
            await f.db.query("SELECT count(*)::int count FROM agent_runs WHERE status='running'")
          )[0]!.count,
        ),
      )
      .toBe(0);
  });
  it('reserves spending atomically across concurrent admissions, deduplicates keys and releases undispatched cancellation', async () => {
    const runtime = new Runtime();
    f = await messagingFixture(undefined, undefined, { runtime });
    const a = await agent();
    await f.db.query(
      'INSERT INTO execution_policies(workspace_id,budget_micros) VALUES($1,500000) ON CONFLICT(workspace_id) DO UPDATE SET budget_micros=500000',
      [f.ownerBoot.workspace.id],
    );
    const input = {
        agentId: a.id,
        conversationId: f.ownerBoot.channels[0]!.id,
        prompt: 'Budget-bound request.',
        requestKey: randomUUID(),
      },
      other = { ...input, requestKey: randomUUID() };
    const admitted = await Promise.all([
      f.call(f.owner, 'POST', '/v1/runs', input),
      f.call(f.owner, 'POST', '/v1/runs', other),
    ]);
    expect(admitted.map((r) => r.statusCode).sort()).toEqual([201, 429]);
    const accepted = admitted.find((r) => r.statusCode === 201)!;
    const original = admitted[0]!.statusCode === 201 ? input : other;
    expect((await f.call(f.owner, 'POST', '/v1/runs', original)).json().replayed).toBe(true);
    expect(await f.db.query('SELECT run_id FROM execution_reservations')).toHaveLength(1);
    await f.call(f.owner, 'POST', `/v1/runs/${accepted.json().id}/cancel`, {});
    expect((await f.db.query('SELECT state FROM execution_reservations'))[0]!.state).toBe(
      'released',
    );
    expect(
      (await f.call(f.owner, 'POST', '/v1/runs', { ...input, requestKey: randomUUID() }))
        .statusCode,
    ).toBe(201);
  });
  it('recovers qualified checkpoints by observing the same session without redispatch and reconciles actual usage', async () => {
    const runtime = new Runtime();
    runtime.fail = true;
    f = await messagingFixture(undefined, undefined, { runtime });
    const a = await agent(),
      run = await queue(a.id),
      worker = new ExecutionWorker(f.db, runtime);
    await worker.tick();
    expect(runtime.calls).toBe(1);
    expect((await f.db.query('SELECT status FROM agent_runs WHERE id=$1', [run]))[0]!.status).toBe(
      'outcome_unknown',
    );
    expect(
      (await f.db.query('SELECT state FROM execution_reservations WHERE run_id=$1', [run]))[0]!
        .state,
    ).toBe('reserved');
    const resumed = await f.call(f.owner, 'POST', `/v1/runs/${run}/resume`, {});
    expect(resumed.statusCode, resumed.body).toBe(200);
    await worker.tick();
    expect(runtime.calls).toBe(1);
    expect(runtime.observations).toBe(1);
    const result = (await f.call(f.owner, 'GET', `/v1/runs/${run}/detail`)).json();
    expect(result.status).toBe('succeeded');
    expect(result.spending).toMatchObject({ state: 'settled', actual_micros: expect.anything() });
    expect(Number(result.spending.actual_micros)).toBe(10000);
    const exported = await f.call(f.owner, 'GET', `/v1/runs/${run}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).not.toContain('session_id');
    expect(
      exported.json().traces.some((trace: { summary: string }) => trace.summary === 'succeeded'),
    ).toBe(true);
  });
  it('enforces pinned tool grants and model qualification without executing denied proposals', async () => {
    const runtime = new Runtime();
    runtime.output = {
      reply: 'An ungranted task proposal.',
      proposals: [
        {
          tool: 'create_task',
          parameters: { title: 'Must not exist', description: 'Denied tool.', priority: 'normal' },
        },
      ],
    };
    f = await messagingFixture(undefined, undefined, { runtime });
    const a = await agent();
    await revise(a.id, { tools: [], skills: ['verification'] });
    const run = await queue(a.id);
    await new ExecutionWorker(f.db, runtime).tick();
    expect(
      (await f.db.query('SELECT status,error_code FROM agent_runs WHERE id=$1', [run]))[0],
    ).toMatchObject({ status: 'failed', error_code: 'TOOL_GRANT_DENIED' });
    expect(await f.db.query('SELECT id FROM tool_invocations WHERE run_id=$1', [run])).toHaveLength(
      0,
    );
    expect(runtime.requests[0]!.instructions).toContain('Verification procedure v1');
    await revise(a.id, { model: 'unqualified/model' });
    const blocked = await queue(a.id);
    await new ExecutionWorker(f.db, runtime).tick();
    expect(runtime.calls).toBe(1);
    expect(
      (await f.db.query('SELECT error_code FROM agent_runs WHERE id=$1', [blocked]))[0]!.error_code,
    ).toBe('MODEL_NOT_QUALIFIED');
  });
  it('narrows delegated authority, prevents loops and budget expansion, and requires independent evidence', async () => {
    const runtime = new Runtime();
    f = await messagingFixture(undefined, undefined, { runtime });
    const parentAgent = await agent(),
      childAgent = await agent();
    const parent = await queue(parentAgent.id);
    await new ExecutionWorker(f.db, runtime).tick();
    expect((await delegation(parent, parentAgent.id)).json().error.code).toBe('DELEGATION_LOOP');
    expect(
      (await delegation(parent, childAgent.id, { budgetMicros: 1000000 })).json().error.code,
    ).toBe('DELEGATION_BUDGET');
    expect(
      (await delegation(parent, childAgent.id, { verifierId: f.ownerBoot.me.id })).json().error
        .code,
    ).toBe('INDEPENDENT_VERIFIER');
    const key = randomUUID(),
      deadline = new Date(Date.now() + 3600000).toISOString(),
      created = await delegation(parent, childAgent.id, { requestKey: key, deadline });
    expect(created.statusCode, created.body).toBe(200);
    const child = created.json().id;
    const replay = await delegation(parent, childAgent.id, { requestKey: key, deadline });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().replayed, replay.body).toBe(true);
    expect(
      (
        await delegation(parent, childAgent.id, {
          requestKey: key,
          deadline,
          prompt: 'A different request.',
        })
      ).statusCode,
    ).toBe(409);
    await new ExecutionWorker(f.db, runtime).tick();
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/runs/${child}/verification`, {
          decision: 'accepted',
          evidence: 'I reviewed this work myself.',
        })
      ).statusCode,
    ).toBe(403);
    const verified = await f.call(f.mate, 'POST', `/v1/runs/${child}/verification`, {
      decision: 'accepted',
      evidence: 'Independently reproduced the documented release checks.',
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(
      (await f.call(f.owner, 'GET', `/v1/runs/${child}/detail`)).json().verification_status,
    ).toBe('accepted');
  });
  it('escalates expired children, cancels their proposals, and never releases an uncertain dispatched reservation', async () => {
    const runtime = new Runtime();
    f = await messagingFixture(undefined, undefined, { runtime });
    const a = await agent(),
      b = await agent(),
      parent = await queue(a.id);
    await new ExecutionWorker(f.db, runtime).tick();
    const created = await delegation(parent, b.id);
    expect(created.statusCode, created.body).toBe(200);
    const child = created.json().id;
    await f.db.query(
      "UPDATE agent_runs SET delegation_deadline=now()-interval '1 second' WHERE id=$1",
      [child],
    );
    await new ExecutionWorker(f.db, runtime).tick();
    expect(
      (
        await f.db.query('SELECT status,verification_status FROM agent_runs WHERE id=$1', [child])
      )[0],
    ).toMatchObject({ status: 'cancelled', verification_status: 'escalated' });
    expect(runtime.calls).toBe(1);
    runtime.fail = true;
    const uncertain = await queue(b.id);
    await new ExecutionWorker(f.db, runtime).tick();
    await f.call(f.owner, 'POST', `/v1/runs/${uncertain}/cancel`, {});
    expect(
      (
        await f.db.query('SELECT state FROM execution_reservations WHERE run_id=$1', [uncertain])
      )[0]!.state,
    ).toBe('reserved');
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/runs/${uncertain}/restart`, { requestKey: randomUUID() })
      ).json().error.code,
    ).toBe('RECONCILIATION_REQUIRED');
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/runs/${uncertain}/spending`, {
          actualMicros: 15000,
          receipt: 'Provider confirms the cancelled turn cost exactly USD 0.015.',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.owner, 'POST', `/v1/runs/${uncertain}/restart`, { requestKey: randomUUID() }))
        .statusCode,
    ).toBe(200);
  });
  it('serializes replica claims and enforces per-agent and per-requester concurrency', async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new Runtime();
    runtime.generate = async (_session, request) => {
      runtime.calls++;
      runtime.requests.push(request);
      await pending;
      return runtime.output;
    };
    f = await messagingFixture(undefined, undefined, { runtime });
    const a = await agent();
    await queue(a.id);
    await queue(a.id);
    const first = new ExecutionWorker(f.db, runtime),
      second = new ExecutionWorker(f.db, runtime);
    await first.tick(false);
    await second.tick(false);
    expect(await f.db.query("SELECT id FROM agent_runs WHERE status='running'")).toHaveLength(1);
    expect(await f.db.query("SELECT id FROM agent_runs WHERE status='queued'")).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await first.tick();
    await second.tick();
    expect(runtime.calls).toBe(2);
  });
});
