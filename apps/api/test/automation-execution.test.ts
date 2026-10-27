import { scopedDatabase, workerScope } from '@ao/database';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentOutput } from '@ao/contracts';
import type { HostedRuntime } from '../src/execution/types.js';
import { messagingFixture } from './messaging-fixture.js';
import { AutomationWorker } from '../src/automations/worker.js';
import { ExecutionWorker } from '../src/execution/worker.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
class Runtime implements HostedRuntime {
  configured = true;
  calls = 0;
  output: AgentOutput = { reply: 'No deployment changes detected.', proposals: [] };
  async createSession() {
    return randomUUID();
  }
  async generate() {
    this.calls++;
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
async function setup(options: { concurrency?: number } = {}) {
  const runtime = new Runtime();
  f = await messagingFixture(undefined, undefined, { runtime });
  const c = f.ownerBoot.channels[0]!.id;
  const agent = (
    await f.call(f.owner, 'POST', '/v1/agents', {
      name: 'Scheduled reviewer',
      role: 'Check for material changes and propose reviewed work',
      runtime: 'managed',
    })
  ).json().id;
  const definition = {
    conversationId: c,
    trigger: { kind: 'schedule', cron: '* * * * *', timezone: 'UTC' },
    action: {
      kind: 'agent',
      agentId: agent,
      agentRevision: 1,
      prompt: 'Check for material deployment changes',
    },
    concurrency: options.concurrency ?? 2,
    overlap: 'queue',
    maxDailySpendMicros: 1000000,
    escalationMemberId: f.mateBoot.me.id,
    participation: {
      cooldownMinutes: 0,
      onlyMeaningfulChanges: true,
      maxPublicationsPerDay: 10,
      enabled: true,
    },
  };
  const created = await f.call(f.owner, 'POST', '/v1/automations', {
    clientId: randomUUID(),
    name: 'Scheduled release review',
    definition,
  });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().id;
  expect(
    (
      await f.call(f.owner, 'POST', `/v1/automations/${id}/control`, {
        version: 1,
        action: 'resume',
      })
    ).statusCode,
  ).toBe(200);
  const errors: string[] = [],
    scheduler = new AutomationWorker(f.db, (e) => errors.push(e)),
    execution = new ExecutionWorker(
      f.db,
      runtime,
      () => {},
      new IdentitySecrets(Buffer.alloc(32, 5).toString('base64')),
    );
  let sequence = 0;
  const due = async () => {
    await f.db.query('UPDATE automations SET next_at=$2 WHERE id=$1', [
      id,
      new Date(Math.floor(Date.now() / 60000) * 60000 - ++sequence * 60000),
    ]);
    await scheduler.tick();
    expect(errors).toEqual([]);
  };
  return { id, agent, c, runtime, scheduler, execution, due };
}
describe('scheduled hosted execution governance', () => {
  it('suppresses unchanged replies, retains proposed approvals, and atomically limits daily spending with a persistent escalation', async () => {
    const p = await setup();
    await p.due();
    await p.execution.tick();
    await p.scheduler.tick();
    expect(p.runtime.calls).toBe(1);
    p.runtime.output = {
      ...p.runtime.output,
      meaningfulChange: false,
      proposals: [
        {
          tool: 'create_task',
          parameters: {
            title: 'Review the pending release',
            description: 'A person must review this task proposal.',
            priority: 'normal',
          },
        },
      ],
    };
    await p.due();
    await p.execution.tick();
    expect(
      p.runtime.calls,
      JSON.stringify(
        await f.db.query(
          'SELECT status,reason,agent_run_id FROM automation_occurrences WHERE automation_id=$1',
          [p.id],
        ),
      ) +
        ' ' +
        JSON.stringify(await f.db.query('SELECT status,error_code FROM agent_runs')),
    ).toBe(2);
    const runs = await f.db.query(
      'SELECT status,result FROM agent_runs WHERE automation_occurrence_id IS NOT NULL ORDER BY created_at,id',
    );
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'awaiting_approval']);
    expect((runs[1]!.result as { suppressionReason: string }).suppressionReason).toBe(
      'unchanged_result',
    );
    expect(
      await f.db.query(
        'SELECT id FROM messages WHERE author_id=(SELECT membership_id FROM agents WHERE id=$1)',
        [p.agent],
      ),
    ).toHaveLength(1);
    expect(await f.db.query("SELECT id FROM tool_invocations WHERE status='pending'")).toHaveLength(
      1,
    );
    await p.due();
    expect(p.runtime.calls).toBe(2);
    const failures = await f.db.query(
      "SELECT reason FROM automation_occurrences WHERE automation_id=$1 AND status='failed'",
      [p.id],
    );
    expect(failures).toEqual([{ reason: 'AUTOMATION_SPENDING_LIMIT' }]);
    const notifications = await f.call(f.mate, 'GET', '/v1/notifications');
    expect(notifications.statusCode, notifications.body).toBe(200);
    expect(
      notifications.json().items.some((n: { kind: string }) => n.kind === 'automation_attention'),
    ).toBe(true);
    const history = await f.call(f.mate, 'GET', `/v1/automations/${p.id}/history`);
    expect(history.statusCode, history.body).toBe(200);
    await f.db.query(
      'UPDATE memberships SET permissions=permissions||\'{"execution.read":false}\'::jsonb WHERE id=$1',
      [f.mateBoot.me.id],
    );
    expect(
      (await f.call(f.mate, 'GET', '/v1/notifications'))
        .json()
        .items.some((n: { kind: string }) => n.kind === 'automation_attention'),
    ).toBe(false);
    await f.db.query(
      'UPDATE memberships SET permissions=permissions||\'{"execution.read":true}\'::jsonb WHERE id=$1',
      [f.mateBoot.me.id],
    );

    const [pending] = await f.db.query(
      "SELECT i.id,r.automation_occurrence_id FROM tool_invocations i JOIN agent_runs r ON r.workspace_id=i.workspace_id AND r.id=i.run_id WHERE i.status='pending'",
    );
    await f.db.query(
      "INSERT INTO tool_actions(workspace_id,invocation_id,state,capability_hash,capability_expires_at) VALUES($1,$2,'outcome_unknown','fixture-uncertain',now()+interval '1 hour')",
      [f.ownerBoot.workspace.id, pending!.id],
    );
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/automations/${p.id}/control`, {
          version: 2,
          action: 'pause',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/automations/${p.id}/control`, {
          version: 3,
          action: 'resume',
        })
      ).statusCode,
    ).toBe(200);
    const replay = await f.call(
      f.owner,
      'POST',
      `/v1/automation-occurrences/${pending!.automation_occurrence_id}/replay`,
      { clientId: randomUUID(), reason: 'Review the previous external outcome first' },
    );
    expect(replay.statusCode, replay.body).toBe(409);
    expect(replay.json().error.code).toBe('OUTCOME_UNRESOLVED');
    await expect(
      f.db.query('UPDATE automation_versions SET definition=definition WHERE automation_id=$1', [
        p.id,
      ]),
    ).rejects.toThrow('immutable');
  });
  it('fences a queued check when the pinned agent revision changes', async () => {
    const p = await setup();
    await p.due();
    const current = (await f.call(f.owner, 'GET', '/v1/agents/' + p.agent)).json();
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/agents/${p.agent}/revisions`, {
          version: current.version,
          configuration: {
            ...current.configuration,
            instructions: 'A new reviewed instruction revision',
          },
        })
      ).statusCode,
    ).toBe(200);
    await p.execution.tick();
    expect(p.runtime.calls).toBe(0);
    await p.scheduler.tick();
    expect(
      (await f.db.query('SELECT status FROM automations WHERE id=$1', [p.id]))[0]!.status,
    ).toBe('paused');
  });
  it('permits read-only hosted checks without task mutation rights and pauses when execution rights are removed', async () => {
    const p = await setup();
    await f.db.query(
      'UPDATE memberships SET permissions=permissions||\'{"tasks.write":false}\'::jsonb WHERE id=$1',
      [f.ownerBoot.me.id],
    );
    await p.due();
    await p.execution.tick();
    expect(p.runtime.calls).toBe(1);
    await f.db.query(
      'UPDATE memberships SET permissions=permissions||\'{"execution.manage":false}\'::jsonb WHERE id=$1',
      [f.ownerBoot.me.id],
    );
    await p.scheduler.tick();
    expect(
      (await f.db.query('SELECT status FROM automations WHERE id=$1', [p.id]))[0]!.status,
    ).toBe('paused');
  });
  it('retains an occurrence until delegated output is independently verified', async () => {
    const p = await setup();
    await p.due();
    await p.execution.tick();
    const [root] = await f.db.query(
      'SELECT * FROM agent_runs WHERE automation_occurrence_id IS NOT NULL',
    );
    const child = randomUUID();
    await f.db.query(
      "INSERT INTO agent_runs(id,workspace_id,agent_id,requester_id,conversation_id,request_key,request_hash,prompt,instructions,requester_auth_version,status,parent_run_id,root_run_id,automation_occurrence_id,verification_status) SELECT $1,workspace_id,agent_id,requester_id,conversation_id,$2,'fixture-child',prompt,instructions,requester_auth_version,'succeeded',id,id,automation_occurrence_id,'pending' FROM agent_runs WHERE id=$3",
      [child, randomUUID(), root!.id],
    );
    await p.scheduler.tick();
    expect(
      (
        await f.db.query('SELECT status FROM automation_occurrences WHERE id=$1', [
          root!.automation_occurrence_id,
        ])
      )[0]!.status,
    ).toBe('running');
    await f.db.query("UPDATE agent_runs SET verification_status='accepted' WHERE id=$1", [child]);
    await p.scheduler.tick();
    expect(
      (
        await f.db.query('SELECT status FROM automation_occurrences WHERE id=$1', [
          root!.automation_occurrence_id,
        ])
      )[0]!.status,
    ).toBe('succeeded');
  });

  it('keeps uncertain occurrences in the overlap limit while permitting qualified current-authority recovery', async () => {
    const p = await setup({ concurrency: 1 });
    await p.due();
    const [run] = await f.db.query(
      'SELECT * FROM agent_runs WHERE automation_occurrence_id IS NOT NULL',
    );
    await f.db.query("UPDATE agent_runs SET status='outcome_unknown' WHERE id=$1", [run!.id]);
    await p.scheduler.tick();
    const [allowed] = await workerScope(f.ownerBoot.workspace.id, () =>
      scopedDatabase(f.db).query('SELECT automation_occurrence_allowed($1,$2) allowed', [
        f.ownerBoot.workspace.id,
        run!.automation_occurrence_id,
      ]),
    );
    expect(allowed!.allowed).toBe(true);
    await p.due();
    expect(
      (
        await f.db.query(
          'SELECT status FROM automation_occurrences WHERE automation_id=$1 ORDER BY created_at,id',
          [p.id],
        )
      ).map((r) => r.status),
    ).toEqual(['outcome_unknown', 'queued']);
    await f.db.query("UPDATE agent_runs SET status='succeeded' WHERE id=$1", [run!.id]);
    await p.scheduler.tick();
    expect(
      (
        await f.db.query(
          'SELECT status FROM automation_occurrences WHERE automation_id=$1 ORDER BY created_at,id',
          [p.id],
        )
      ).map((r) => r.status),
    ).toEqual(['succeeded', 'running']);
  });
});
