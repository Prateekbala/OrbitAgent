import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { identifyPrincipal, scopedDatabase, tenantScope } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { WorkflowWorker } from '../src/workflows/worker.js';
import { TaskSchedulingWorker } from '../src/scheduling/worker.js';
import { businessOffset, businessCount } from '../src/scheduling/business.js';
import { CalendarSyncWorker, calendarContext } from '../src/calendar/worker.js';
import { IdentitySecrets } from '../src/identity/secrets.js';
import type { CalendarProvider, CalendarEvent } from '../src/calendar/google.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
async function task(title = 'Extended task', extra: Record<string, unknown> = {}) {
  const r = await f.call(f.owner, 'POST', '/v1/tasks', { title, clientId: randomUUID(), ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function version(id: string) {
  return (await f.call(f.owner, 'GET', '/v1/tasks/' + id)).json().task.version as number;
}
async function template(steps: unknown[], extra: Record<string, unknown> = {}) {
  const r = await f.call(f.owner, 'POST', '/v1/work-templates', {
    clientId: randomUUID(),
    name: 'Release workflow',
    kind: 'workflow',
    definition: { steps },
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(200);
  const id = r.json().id as string;
  const published = await f.call(f.owner, 'PUT', `/v1/work-templates/${id}/publication`, {
    version: 1,
    revision: 1,
  });
  expect(published.statusCode, published.body).toBe(200);
  return id;
}
describe('extended task work', () => {
  it('requires consent for retained private task history even when a group has no messages', async () => {
    f = await messagingFixture();
    const group = (
      await f.call(f.owner, 'POST', '/v1/conversations/groups', {
        title: 'Task-only private context',
        membershipIds: [f.mateBoot.me.id],
        historyPolicy: 'retained',
      })
    ).json().id;
    await task('Earlier confidential work', { conversationId: group });
    const email = (await f.call(f.other, 'GET', '/v1/account')).json().email,
      invite = await f.call(f.owner, 'POST', '/v1/invitations', { email }),
      accepted = await f.call(f.other, 'POST', '/v1/invitations/accept', {
        token: invite.json().token,
      }),
      member = (await f.boot(accepted.cookies[0]!.value)).me.id;
    const expanded = await f.call(f.owner, 'PATCH', '/v1/conversations/' + group, {
      version: 1,
      member: { membershipId: member, action: 'add' },
    });
    expect(expanded.statusCode, expanded.body).toBe(409);
    expect(expanded.json().error.code).toBe('HISTORY_CONSENT_REQUIRED');
    expect((await f.call(accepted.cookies[0]!.value, 'GET', '/v1/tasks')).json()).toHaveLength(0);
  });
  it('stops queued workflows after credential changes and rejects duplicate step identities', async () => {
    f = await messagingFixture();
    const invalid = await f.call(f.owner, 'POST', '/v1/work-templates', {
      clientId: randomUUID(),
      name: 'Invalid duplicate steps',
      kind: 'workflow',
      definition: {
        steps: [
          { key: 'same', type: 'approval', instructions: 'First review' },
          { key: 'same', type: 'approval', instructions: 'Second review' },
        ],
      },
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    const id = await template([
        { key: 'create', type: 'create_task', title: 'Do not run under revoked credentials' },
      ]),
      start = await f.call(f.owner, 'POST', `/v1/work-templates/${id}/start`, {
        clientId: randomUUID(),
        revision: 1,
      });
    await f.db.query(
      'UPDATE accounts SET auth_version=auth_version+1 WHERE id=(SELECT account_id FROM memberships WHERE id=$1)',
      [f.ownerBoot.me.id],
    );
    const errors: unknown[] = [];
    await new WorkflowWorker(f.db, (e) => errors.push(e)).tick();
    expect(errors).toEqual([]);
    expect(
      (
        await f.db.query('SELECT status,error_code FROM workflow_runs WHERE id=$1', [
          start.json().id,
        ])
      )[0],
    ).toMatchObject({ status: 'failed', error_code: 'AUTHORITY_REVOKED' });
    expect(
      await f.db.query(
        "SELECT id FROM tasks WHERE workspace_id=$1 AND title='Do not run under revoked credentials'",
        [f.ownerBoot.workspace.id],
      ),
    ).toHaveLength(0);
  });
  it('requires source read capabilities for task links and task access for project reports', async () => {
    f = await messagingFixture();
    const project = (
        await f.call(f.owner, 'POST', '/v1/projects', {
          clientId: randomUUID(),
          name: 'Capability report',
        })
      ).json().id,
      id = await task('Capability task', { projectId: project });
    await f.db.query('UPDATE memberships SET permissions=$2::jsonb,version=version+1 WHERE id=$1', [
      f.mateBoot.me.id,
      JSON.stringify({ 'messages.read': false, 'execution.read': false }),
    ]);
    expect((await f.call(f.mate, 'GET', `/v1/tasks/${id}/sources`)).statusCode).toBe(403);
    expect((await f.call(f.mate, 'GET', `/v1/tasks/${id}/runs`)).statusCode).toBe(403);
    await f.db.query('UPDATE memberships SET permissions=$2::jsonb,version=version+1 WHERE id=$1', [
      f.mateBoot.me.id,
      JSON.stringify({ 'tasks.read': false, 'projects.read': true }),
    ]);
    expect((await f.call(f.mate, 'GET', `/v1/projects/${project}/report`)).statusCode).toBe(403);
    expect(
      (
        await f.call(
          f.mate,
          'GET',
          `/v1/projects/${project}/timeline?from=2030-01-01&through=2030-02-01`,
        )
      ).statusCode,
    ).toBe(403);
  });
  it('binds calendar OAuth to its browser session, consumes state once, and encrypts provider credentials', async () => {
    const provider: CalendarProvider = {
      authorization: (state, challenge) =>
        `https://calendar.fixture/authorize?state=${state}&code_challenge=${challenge}`,
      exchange: async () => ({
        refresh_token: 'fixture-refresh-secret',
        access_token: 'fixture-access-secret',
      }),
      changes: async (credentials) => ({ credentials, data: {} }),
      write: async (credentials, event) => ({ credentials, data: event }),
    };
    f = await messagingFixture(undefined, undefined, { calendar: provider });
    const start = await f.call(f.owner, 'POST', '/v1/calendar/google/connect');
    expect(start.statusCode, start.body).toBe(200);
    const authorization = new URL(start.json().url);
    expect(authorization.searchParams.get('code_challenge')).toHaveLength(43);
    const callback = `/v1/calendar/google/callback?state=${authorization.searchParams.get('state')}&code=fixture-code`;
    expect((await f.call(f.mate, 'GET', callback)).statusCode).toBe(400);
    expect((await f.call(f.owner, 'GET', callback)).statusCode).toBe(302);
    expect((await f.call(f.owner, 'GET', callback)).statusCode).toBe(400);
    const [connection] = await f.db.query(
      'SELECT credentials FROM calendar_connections WHERE workspace_id=$1',
      [f.ownerBoot.workspace.id],
    );
    expect(connection!.credentials).not.toContain('fixture-refresh-secret');
    expect((await f.call(f.owner, 'GET', '/v1/calendar/connections')).body).not.toContain(
      'fixture-access-secret',
    );
  });
  it('serializes duplicate admission and two worker replicas without creating duplicate triggered work', async () => {
    f = await messagingFixture();
    const id = await template([
      { key: 'generated', type: 'create_task', title: 'Replica-safe generated task' },
    ]);
    const clientId = randomUUID();
    const admitted = await Promise.all(
      [1, 2, 3].map(() =>
        f.call(f.owner, 'POST', `/v1/work-templates/${id}/start`, { clientId, revision: 1 }),
      ),
    );
    expect(admitted.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(admitted.map((r) => r.json().id)).size).toBe(1);
    const errors: unknown[] = [],
      a = new WorkflowWorker(f.db, (error) => errors.push(error)),
      b = new WorkflowWorker(f.db, (error) => errors.push(error));
    await Promise.all([a.tick(), b.tick()]);
    expect(errors).toEqual([]);
    expect(
      await f.db.query(
        "SELECT id FROM tasks WHERE workspace_id=$1 AND title='Replica-safe generated task'",
        [f.ownerBoot.workspace.id],
      ),
    ).toHaveLength(1);
  });
  it('retains task ownership across agent attempts and fences child execution when its workflow is cancelled', async () => {
    f = await messagingFixture();
    const created = await f.call(f.owner, 'POST', '/v1/agents', {
      name: 'Task verifier',
      role: 'Verify delivery evidence.',
      runtime: 'managed',
    });
    expect(created.statusCode, created.body).toBe(201);
    const channel = f.ownerBoot.channels[0]!.id,
      source = await task('Agent-linked delivery', {
        conversationId: channel,
        assigneeId: f.mateBoot.me.id,
      });
    const id = await template(
      [
        {
          key: 'verify',
          type: 'run_agent',
          target: 'source',
          agentId: created.json().id,
          prompt: 'Review the available release evidence.',
        },
      ],
      { conversationId: channel },
    );
    const started = await f.call(f.owner, 'POST', `/v1/work-templates/${id}/start`, {
      clientId: randomUUID(),
      revision: 1,
      sourceTaskId: source,
    });
    expect(started.statusCode, started.body).toBe(200);
    const errors: unknown[] = [],
      worker = new WorkflowWorker(f.db, (error) => errors.push(error));
    await worker.tick();
    let run = (await f.call(f.owner, 'GET', '/v1/workflow-runs/' + started.json().id)).json();
    expect(run.status, JSON.stringify(errors)).toBe('waiting');
    let history = (await f.call(f.owner, 'GET', `/v1/tasks/${source}/runs`)).json();
    expect(history.items).toHaveLength(1);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/workflow-runs/${run.id}/cancel`, {
          version: run.version,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.db.query('SELECT status FROM agent_runs WHERE id=$1', [history.items[0].id]))[0]!
        .status,
    ).toBe('cancelled');
    run = (await f.call(f.owner, 'GET', '/v1/workflow-runs/' + run.id)).json();
    const replay = await f.call(f.owner, 'POST', `/v1/workflow-runs/${run.id}/replay`, {
      version: run.version,
      clientId: randomUUID(),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    await worker.tick(new Date(Date.now() + 10000));
    history = (await f.call(f.owner, 'GET', `/v1/tasks/${source}/runs`)).json();
    expect(history.items).toHaveLength(2);
    expect((await f.call(f.owner, 'GET', '/v1/tasks/' + source)).json().task.assignee_id).toBe(
      f.mateBoot.me.id,
    );
    expect(errors).toEqual([]);
  });
  it('grants collaboration without widening audiences, notifies watchers, and verifies required criteria before all completion paths', async () => {
    f = await messagingFixture();
    const id = await task();
    expect(
      (await f.call(f.mate, 'PATCH', '/v1/tasks/' + id, { version: 1, title: 'Unauthorized edit' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await f.call(f.owner, 'PUT', `/v1/tasks/${id}/participants`, {
          version: 1,
          membershipId: f.mateBoot.me.id,
          role: 'collaborator',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.mate, 'PATCH', '/v1/tasks/' + id, {
          version: 2,
          title: 'Collaborative task',
        })
      ).statusCode,
    ).toBe(200);
    const criterion = await f.call(f.owner, 'POST', `/v1/tasks/${id}/criteria`, {
      version: 3,
      text: 'All validation passes',
    });
    expect(criterion.statusCode, criterion.body).toBe(200);
    for (const state of ['queued', 'active', 'awaiting_review'])
      expect(
        (
          await f.call(f.owner, 'POST', `/v1/tasks/${id}/transitions`, {
            version: await version(id),
            state,
          })
        ).statusCode,
      ).toBe(200);
    const blocked = await f.call(f.owner, 'POST', `/v1/tasks/${id}/transitions`, {
      version: await version(id),
      state: 'completed',
      evidence: 'Checked',
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    const review = await f.call(f.owner, 'PUT', `/v1/tasks/${id}/criteria/${criterion.json().id}`, {
      version: await version(id),
      accepted: true,
      evidence: 'Test suite passed',
    });
    expect(review.statusCode, review.body).toBe(200);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/tasks/${id}/transitions`, {
          version: await version(id),
          state: 'completed',
          evidence: 'All criteria verified',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.mate, 'GET', '/v1/notifications'))
        .json()
        .items.some((n: { kind: string }) => n.kind === 'task_activity'),
    ).toBe(true);
    expect(
      (await f.call(f.owner, 'GET', `/v1/tasks/${id}/verification-history`)).json().items,
    ).toHaveLength(1);
    const privateGroup = (
      await f.call(f.owner, 'POST', '/v1/conversations/groups', {
        title: 'Private work',
        membershipIds: [f.mateBoot.me.id],
      })
    ).json().id;
    const privateTask = await task('Private acceptance', { conversationId: privateGroup });
    expect(
      (
        await f.call(f.owner, 'PUT', `/v1/tasks/${privateTask}/participants`, {
          version: 1,
          membershipId: f.otherBoot.me.id,
          role: 'collaborator',
        })
      ).statusCode,
    ).toBe(400);
  });
  it('deduplicates immutable artifacts and limits source discussion links to visible matching audiences', async () => {
    f = await messagingFixture();
    const channel = f.ownerBoot.channels[0]!.id,
      id = await task('Source task', { conversationId: channel }),
      message = (await f.send(f.owner, channel, 'Release decision')).json().id;
    const artifact = {
      clientId: randomUUID(),
      kind: 'test_result',
      title: 'Validation report',
      outcome: 'passed',
      details: '235 tests passed',
    };
    const first = await f.call(f.owner, 'POST', `/v1/tasks/${id}/artifacts`, artifact);
    expect(first.statusCode, first.body).toBe(200);
    expect((await f.call(f.owner, 'POST', `/v1/tasks/${id}/artifacts`, artifact)).json().id).toBe(
      first.json().id,
    );
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/tasks/${id}/artifacts`, {
          ...artifact,
          details: 'Different',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/tasks/${id}/sources`, {
          messageId: message,
          kind: 'decision',
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.call(f.owner, 'GET', `/v1/tasks/${id}/sources`)).json().items[0].body).toBe(
      'Release decision',
    );
    const unrelated = await task('Workspace task');
    expect(
      (await f.call(f.owner, 'POST', `/v1/tasks/${unrelated}/sources`, { messageId: message }))
        .statusCode,
    ).toBe(400);
    const scoped = scopedDatabase(f.db);
    await expect(
      tenantScope(f.ownerBoot.workspace.id, async () => {
        identifyPrincipal(f.ownerBoot.me.id, 'member');
        await scoped.query('UPDATE task_artifacts SET title=$2 WHERE id=$1', [
          first.json().id,
          'Tampered',
        ]);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('keeps immutable template revisions, applies each step once, waits for approval, and preserves ownership', async () => {
    f = await messagingFixture();
    const id = await template([
      { key: 'prepare', type: 'create_task', title: 'Prepare release', criteria: ['Build passes'] },
      { key: 'review', type: 'approval', instructions: 'Approve release preparation' },
      { key: 'finish', type: 'create_task', title: 'Publish release' },
    ]);
    const key = randomUUID(),
      start = await f.call(f.owner, 'POST', `/v1/work-templates/${id}/start`, {
        clientId: key,
        revision: 1,
      });
    expect(start.statusCode, start.body).toBe(200);
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/work-templates/${id}/start`, {
          clientId: key,
          revision: 1,
        })
      ).json().id,
    ).toBe(start.json().id);
    const errors: unknown[] = [],
      worker = new WorkflowWorker(f.db, (e) => errors.push(e)),
      now = new Date();
    await worker.tick(now);
    await worker.tick(new Date(now.getTime() + 6000));
    let run = (await f.call(f.owner, 'GET', '/v1/workflow-runs/' + start.json().id)).json();
    expect(run.status).toBe('waiting');
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/workflow-runs/${run.id}/decision`, {
          version: run.version,
          approve: true,
          evidence: 'Preparation reviewed',
        })
      ).statusCode,
    ).toBe(200);
    await worker.tick(new Date(now.getTime() + 12000));
    await worker.tick(new Date(now.getTime() + 18000));
    run = (await f.call(f.owner, 'GET', '/v1/workflow-runs/' + run.id)).json();
    expect(run.status).toBe('succeeded');
    expect(errors).toEqual([]);
    expect(
      await f.db.query("SELECT id FROM tasks WHERE workspace_id=$1 AND title='Prepare release'", [
        f.ownerBoot.workspace.id,
      ]),
    ).toHaveLength(1);
    const revised = await f.call(f.owner, 'POST', `/v1/work-templates/${id}/revisions`, {
      version: 2,
      name: 'Release revision',
      definition: { steps: [{ key: 'newtask', type: 'create_task', title: 'New revision task' }] },
    });
    expect(revised.statusCode, revised.body).toBe(200);
    expect(
      (await f.call(f.owner, 'GET', `/v1/work-templates/${id}?revision=1`)).json().definition.steps,
    ).toHaveLength(3);
    expect(run.template_revision).toBe(1);
  });
  it('dispatches event-driven work once and suppresses self-generated workflow loops', async () => {
    f = await messagingFixture();
    const id = await template([
      { key: 'followup', type: 'create_task', title: 'Generated follow-up' },
    ]);
    const trigger = await f.call(f.owner, 'POST', '/v1/workflow-triggers', {
      clientId: randomUUID(),
      templateId: id,
      revision: 1,
      event: 'task.created',
    });
    expect(trigger.statusCode, trigger.body).toBe(200);
    await task('Trigger source');
    const errors: unknown[] = [],
      worker = new WorkflowWorker(f.db, (e) => errors.push(e));
    await worker.tick();
    await worker.tick();
    await worker.tick();
    expect(errors).toEqual([]);
    expect(
      await f.db.query('SELECT id FROM workflow_runs WHERE workspace_id=$1', [
        f.ownerBoot.workspace.id,
      ]),
    ).toHaveLength(1);
    expect(
      await f.db.query(
        "SELECT id FROM tasks WHERE workspace_id=$1 AND title='Generated follow-up'",
        [f.ownerBoot.workspace.id],
      ),
    ).toHaveLength(1);
  });
  it('escalates timed-out work once and safely replays completed steps without duplicate task creation', async () => {
    f = await messagingFixture();
    const id = await template([
      { key: 'prepare', type: 'create_task', title: 'Do not duplicate this' },
      { key: 'review', type: 'approval', instructions: 'Review' },
    ]);
    const start = await f.call(f.owner, 'POST', `/v1/work-templates/${id}/start`, {
        clientId: randomUUID(),
        revision: 1,
      }),
      worker = new WorkflowWorker(f.db),
      now = new Date();
    await worker.tick(now);
    await worker.tick(new Date(now.getTime() + 6000));
    await f.db.query("UPDATE workflow_runs SET deadline_at=now()-interval '1 second' WHERE id=$1", [
      start.json().id,
    ]);
    await worker.tick(new Date(now.getTime() + 12000));
    let run = (await f.call(f.owner, 'GET', '/v1/workflow-runs/' + start.json().id)).json();
    expect(run.status).toBe('failed');
    expect(run.error_code).toBe('WORKFLOW_DEADLINE');
    expect(
      await f.db.query("SELECT id FROM workflow_notices WHERE run_id=$1 AND kind='escalation'", [
        run.id,
      ]),
    ).toHaveLength(1);
    const replay = await f.call(f.owner, 'POST', `/v1/workflow-runs/${run.id}/replay`, {
      version: run.version,
      clientId: randomUUID(),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    await worker.tick(new Date(now.getTime() + 18000));
    await worker.tick(new Date(now.getTime() + 24000));
    run = (await f.call(f.owner, 'GET', '/v1/workflow-runs/' + replay.json().id)).json();
    expect(run.status).toBe('waiting');
    expect(
      await f.db.query(
        "SELECT id FROM tasks WHERE workspace_id=$1 AND title='Do not duplicate this'",
        [f.ownerBoot.workspace.id],
      ),
    ).toHaveLength(1);
  });
  it('reports current project and portfolio work through tenant-scoped, bounded timelines', async () => {
    f = await messagingFixture();
    const project = (
        await f.call(f.owner, 'POST', '/v1/projects', {
          clientId: randomUUID(),
          name: 'Delivery project',
        })
      ).json().id,
      id = await task('Report item', { projectId: project, dueDate: '2030-06-14' });
    const plan = await f.call(f.owner, 'PUT', `/v1/tasks/${id}/plan`, {
      version: 1,
      startDate: '2030-06-01',
      estimate: 8,
    });
    expect(plan.statusCode, plan.body).toBe(200);
    const report = await f.call(f.owner, 'GET', `/v1/projects/${project}/report`);
    expect(report.statusCode, report.body).toBe(200);
    expect(report.json().totals.estimated).toBe(8);
    expect(
      (
        await f.call(
          f.owner,
          'GET',
          `/v1/projects/${project}/timeline?from=2030-06-01&through=2030-06-30`,
        )
      ).json().items[0].id,
    ).toBe(id);
    const portfolio = await f.call(f.owner, 'POST', '/v1/portfolios', {
      clientId: randomUUID(),
      name: 'Delivery portfolio',
      projectIds: [project],
    });
    expect(portfolio.statusCode, portfolio.body).toBe(200);
    expect(
      (await f.call(f.owner, 'GET', `/v1/portfolios/${portfolio.json().id}/report`)).json().totals
        .tasks,
    ).toBe(1);
    expect(
      (await f.call(f.other, 'GET', `/v1/portfolios/${portfolio.json().id}/report`)).statusCode,
    ).toBe(404);
  });
  it('schedules business days across weekends and holidays and snapshots calendar revisions', async () => {
    const calendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2030-06-17'] };
    expect(businessOffset('2030-06-14', 1, calendar)).toBe('2030-06-18');
    expect(businessCount('2030-06-14', '2030-06-18', calendar)).toBe(2);
    f = await messagingFixture();
    const key = randomUUID(),
      saved = await f.call(f.owner, 'PUT', '/v1/business-calendars/' + key, {
        version: 0,
        name: 'Company days',
        timeZone: 'UTC',
        ...calendar,
      });
    expect(saved.statusCode, saved.body).toBe(200);
    const id = await task();
    const rule = await f.call(f.owner, 'PUT', `/v1/tasks/${id}/recurrence`, {
      version: 0,
      frequency: 'business_daily',
      businessCalendarId: key,
      interval: 1,
      startDate: '2030-06-14',
      endDate: '2030-06-18',
      timeZone: 'UTC',
      localTime: '09:00',
      paused: false,
    });
    expect(rule.statusCode, rule.body).toBe(200);
    await new TaskSchedulingWorker(f.db).tick(new Date('2030-06-18T10:00:00Z'));
    const rows = await f.db.query(
      "SELECT to_char(due_date,'YYYY-MM-DD') date FROM tasks WHERE workspace_id=$1 AND id<>$2 ORDER BY due_date",
      [f.ownerBoot.workspace.id, id],
    );
    expect(rows.map((r) => r.date)).toEqual(['2030-06-14', '2030-06-18']);
  });
  it('issues revocable private calendar feeds, excludes conversation tasks, and fences changed credentials', async () => {
    f = await messagingFixture();
    const date = new Date().toISOString().slice(0, 10);
    await task('Feed visible', { assigneeId: f.ownerBoot.me.id, dueDate: date });
    await task('Feed private', {
      assigneeId: f.ownerBoot.me.id,
      dueDate: date,
      conversationId: f.ownerBoot.channels[0]!.id,
    });
    const feed = await f.call(f.owner, 'POST', '/v1/calendar/feeds');
    expect(feed.statusCode, feed.body).toBe(200);
    const path = new URL(feed.json().url);
    const response = await f.app.inject({ method: 'GET', url: '/v1/calendar/feed' + path.search });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('Feed visible');
    expect(response.body).not.toContain('Feed private');
    await f.call(f.owner, 'DELETE', '/v1/calendar/feeds/' + feed.json().id);
    expect(
      (await f.app.inject({ method: 'GET', url: '/v1/calendar/feed' + path.search })).statusCode,
    ).toBe(404);
  });
  it('synchronizes through an external adapter without duplicating a committed event after response loss', async () => {
    f = await messagingFixture();
    const secrets = new IdentitySecrets(randomBytes(32).toString('base64')),
      id = randomUUID(),
      date = new Date().toISOString().slice(0, 10),
      taskId = await task('Export once', { assigneeId: f.ownerBoot.me.id, dueDate: date });
    const [authority] = await f.db.query(
      'SELECT a.auth_version,o.version policy FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN workspaces w ON w.id=m.workspace_id JOIN organizations o ON o.id=w.organization_id WHERE m.id=$1',
      [f.ownerBoot.me.id],
    );
    await f.db.query(
      'INSERT INTO calendar_connections(id,workspace_id,membership_id,credentials,auth_version,policy_version) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        f.ownerBoot.workspace.id,
        f.ownerBoot.me.id,
        secrets.seal(
          calendarContext(f.ownerBoot.workspace.id, id),
          JSON.stringify({ refresh_token: 'fixture-only' }),
        ),
        authority!.auth_version,
        authority!.policy,
      ],
    );
    const events = new Map<string, CalendarEvent>();
    let lose = true,
      writes = 0;
    const provider: CalendarProvider = {
      authorization: () => '',
      exchange: async () => ({}),
      changes: async (credentials) => ({
        credentials,
        data: { items: [...events.values()], nextSyncToken: 'next' },
      }),
      write: async (credentials, event) => {
        writes++;
        const saved = { ...event, etag: '"v1"' };
        events.set(event.id, saved);
        if (lose) {
          lose = false;
          throw new Error('Response lost after provider commit');
        }
        return { credentials, data: saved };
      },
    };
    const worker = new CalendarSyncWorker(f.db, provider, secrets);
    await worker.tick();
    expect(events.size).toBe(1);
    await f.db.query('UPDATE calendar_connections SET next_sync_at=now() WHERE id=$1', [id]);
    await worker.tick();
    expect(events.size).toBe(1);
    expect(writes).toBe(1);
    expect(
      (
        await f.db.query('SELECT status,task_version FROM calendar_exports WHERE task_id=$1', [
          taskId,
        ])
      )[0],
    ).toMatchObject({ status: 'synced', task_version: 1 });
    await f.db.query(
      'UPDATE accounts SET auth_version=auth_version+1 WHERE id=(SELECT account_id FROM memberships WHERE id=$1)',
      [f.ownerBoot.me.id],
    );
    await f.db.query('UPDATE calendar_connections SET next_sync_at=now() WHERE id=$1', [id]);
    await worker.tick();
    expect(
      (
        await f.db.query('SELECT status,credentials FROM calendar_connections WHERE id=$1', [id])
      )[0],
    ).toMatchObject({ status: 'needs_auth', credentials: '' });
  });
});
