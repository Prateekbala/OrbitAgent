import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { messagingFixture } from './messaging-fixture.js';
import { AutomationWorker } from '../src/automations/worker.js';
import { WorkflowWorker } from '../src/workflows/worker.js';
import { nextOccurrence, upcoming } from '../src/automations/schedule.js';
import { automationDefinition } from '@ao/contracts/automations';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
async function setup(
  trigger: Record<string, unknown> = { kind: 'schedule', cron: '* * * * *', timezone: 'UTC' },
  extra: Record<string, unknown> = {},
) {
  f = await messagingFixture();
  const channel = await f.channel();
  const t = await f.call(f.owner, 'POST', '/v1/work-templates', {
    clientId: randomUUID(),
    name: 'Scheduled work',
    kind: 'workflow',
    conversationId: channel,
    definition: { steps: [{ key: 'create', type: 'create_task', title: 'Automation task' }] },
  });
  expect(t.statusCode, t.body).toBe(200);
  const template = t.json().id;
  expect(
    (
      await f.call(f.owner, 'PUT', `/v1/work-templates/${template}/publication`, {
        version: 1,
        revision: 1,
      })
    ).statusCode,
  ).toBe(200);
  const definition = {
    conversationId: channel,
    trigger,
    action: { kind: 'workflow', templateId: template, revision: 1 },
    ...extra,
  };
  const created = await f.call(f.owner, 'POST', '/v1/automations', {
    clientId: randomUUID(),
    name: 'Release check',
    definition,
  });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().id as string;
  const activate = await f.call(f.owner, 'POST', `/v1/automations/${id}/control`, {
    version: 1,
    action: 'resume',
  });
  expect(activate.statusCode, activate.body).toBe(200);
  return { id, channel, definition };
}
describe('automation platform', () => {
  it('makes DST gap and repeated-hour behavior explicit and keeps calendar cadence', () => {
    const base = automationDefinition.shape.trigger.options[0].parse({
      kind: 'schedule',
      cron: '30 2 * * *',
      timezone: 'America/New_York',
    });
    expect(nextOccurrence(base, new Date('2026-03-08T05:00:00Z')).toISOString()).toBe(
      '2026-03-09T06:30:00.000Z',
    );
    expect(
      nextOccurrence({ ...base, dst: 'shift_gap' }, new Date('2026-03-08T05:00:00Z')).toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
    const dates = upcoming({ ...base, cron: '30 1 * * *' }, new Date('2026-11-01T04:00:00Z'), 2);
    expect(dates).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  });
  it('dispatches a durable occurrence once across concurrent workers and stops paused workflows', async () => {
    const { id } = await setup();
    const now = new Date(),
      due = new Date(now.getTime() - 1000);
    await f.db.query('UPDATE automations SET next_at=$2 WHERE id=$1', [id, due]);
    const errors: string[] = [],
      workers = [
        new AutomationWorker(f.db, (e) => errors.push(e)),
        new AutomationWorker(f.db, (e) => errors.push(e)),
      ];
    await Promise.all(workers.map((w) => w.tick(now)));
    expect(errors).toEqual([]);
    const occurrences = await f.db.query(
      'SELECT * FROM automation_occurrences WHERE automation_id=$1',
      [id],
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.status).toBe('running');
    expect((await f.call(f.other, 'GET', '/v1/automations/' + id)).statusCode).toBe(404);
    expect((await f.call(f.mate, 'GET', '/v1/automations/' + id)).statusCode).toBe(404);
    const pause = await f.call(f.owner, 'POST', `/v1/automations/${id}/control`, {
      version: 2,
      action: 'pause',
    });
    expect(pause.statusCode, pause.body).toBe(200);
    await new WorkflowWorker(f.db).tick();
    expect(
      await f.db.query('SELECT id FROM tasks WHERE title=$1', ['Automation task']),
    ).toHaveLength(0);
    expect(
      (
        await f.db.query('SELECT status FROM automation_occurrences WHERE automation_id=$1', [id])
      )[0]!.status,
    ).toBe('cancelled');
  });
  it('bounds catch-up, queues overlaps, preserves revisions and requires recipient acceptance for transfer', async () => {
    const { id, definition } = await setup(
      { kind: 'schedule', cron: '* * * * *', timezone: 'UTC', missed: 'catch_up', catchUpLimit: 3 },
      { overlap: 'queue' },
    );
    const now = new Date();
    await f.db.query('UPDATE automations SET next_at=$2 WHERE id=$1', [
      id,
      new Date(now.getTime() - 3600000),
    ]);
    const errors: string[] = [],
      w = new AutomationWorker(f.db, (e) => errors.push(e));
    await w.tick(now);
    await w.tick(now);
    expect(errors).toEqual([]);
    expect(
      (await f.db.query('SELECT status FROM automation_occurrences WHERE automation_id=$1', [id]))
        .map((r) => r.status)
        .sort(),
    ).toEqual(['queued', 'queued', 'running']);
    const revise = await f.call(f.owner, 'POST', `/v1/automations/${id}/revisions`, {
      version: 2,
      name: 'Revised check',
      definition,
    });
    expect(revise.statusCode, revise.body).toBe(200);
    expect(
      (await f.call(f.owner, 'GET', `/v1/automations/${id}/revisions`)).json().items,
    ).toHaveLength(2);
    const transfer = await f.call(f.owner, 'POST', `/v1/automations/${id}/transfer`, {
      version: 3,
      membershipId: f.mateBoot.me.id,
    });
    expect(transfer.statusCode, transfer.body).toBe(200);
    expect(
      (await f.call(f.mate, 'POST', `/v1/automations/${id}/transfer/accept`, { version: 4 }))
        .statusCode,
    ).toBe(200);
    expect((await f.call(f.mate, 'GET', `/v1/automations/${id}`)).json().owner_id).toBe(
      f.mateBoot.me.id,
    );
    expect((await f.call(f.mate, 'GET', `/v1/automations/${id}`)).json().status).toBe('paused');
  });
  it('filters event audiences, prevents automation feedback, and pauses after authority revocation', async () => {
    const { id, channel } = await setup({ kind: 'event', events: ['message.created'] });
    const other = await f.channel();
    await f.send(f.owner, other, 'Wrong destination');
    await f.db.query(
      "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id,audience_membership_id,actor_id) VALUES($1,'message.created',$2,$3,$4,$4)",
      [f.ownerBoot.workspace.id, randomUUID(), channel, f.mateBoot.me.id],
    );
    await f.send(f.mate, channel, 'Start work');
    const errors: string[] = [],
      w = new AutomationWorker(f.db, (e) => errors.push(e));
    await w.tick();
    await w.tick();
    expect(errors).toEqual([]);
    expect(
      await f.db.query('SELECT id FROM automation_occurrences WHERE automation_id=$1', [id]),
    ).toHaveLength(1);
    await f.db.query(
      'UPDATE accounts SET auth_version=auth_version+1 WHERE id=(SELECT account_id FROM memberships WHERE id=$1)',
      [f.ownerBoot.me.id],
    );
    await w.tick();
    expect(errors).toEqual([]);
    expect((await f.db.query('SELECT status FROM automations WHERE id=$1', [id]))[0]!.status).toBe(
      'paused',
    );
    expect(
      (
        await f.db.query('SELECT status FROM automation_occurrences WHERE automation_id=$1', [id])
      )[0]!.status,
    ).toBe('cancelled');
  });
  it('skips deleted comment sources and keeps internal event positions out of the definition DTO', async () => {
    const { id, channel } = await setup({ kind: 'event', events: ['task.comment_created'] });
    const task = await f.call(f.owner, 'POST', '/v1/tasks', {
      title: 'Comment source task',
      clientId: randomUUID(),
      conversationId: channel,
    });
    expect(task.statusCode, task.body).toBe(201);
    const comment = await f.call(f.owner, 'POST', `/v1/tasks/${task.json().id}/comments`, {
      clientId: randomUUID(),
      body: 'Start a follow-up',
    });
    expect(comment.statusCode, comment.body).toBe(201);
    const deleted = await f.call(
      f.owner,
      'DELETE',
      `/v1/tasks/${task.json().id}/comments/${comment.json().id}`,
      { version: 1 },
    );
    expect(deleted.statusCode, deleted.body).toBe(200);
    const errors: string[] = [];
    await new AutomationWorker(f.db, (e) => errors.push(e)).tick();
    expect(errors).toEqual([]);
    expect(
      (await f.call(f.owner, 'GET', `/v1/automations/${id}/history`)).json().items[0].reason,
    ).toBe('SOURCE_UNAVAILABLE');
    expect((await f.call(f.owner, 'GET', `/v1/automations/${id}`)).json()).not.toHaveProperty(
      'event_cursor',
    );
  });
});
