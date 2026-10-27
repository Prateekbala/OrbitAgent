import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scopedDatabase, tenantScope } from '@ao/database';
import type {
  NotificationPage,
  TaskDetails,
  TaskPage,
  TaskScheduling,
  RecurringTaskPage,
} from '@ao/contracts';
import { messagingFixture } from './messaging-fixture.js';
import { TaskSchedulingWorker } from '../src/scheduling/worker.js';
import { occurrenceDate, previewDates } from '../src/scheduling/dates.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
const errors: unknown[] = [];
beforeAll(async () => {
  f = await messagingFixture();
});
afterAll(async () => {
  await f?.close();
});
beforeEach(async () => {
  errors.length = 0;
  await f.db.query('UPDATE task_recurrences SET paused=true,version=version+1');
  await f.db.query('UPDATE task_reminders SET enabled=false,version=version+1');
});
async function create(input: Record<string, unknown> = {}) {
  const r = await f.call(f.owner, 'POST', '/v1/tasks', { title: 'Scheduled work', ...input });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
}
async function settings(id: string) {
  const r = await f.call(f.owner, 'GET', `/v1/tasks/${id}/scheduling`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<TaskScheduling>();
}
async function repeat(id: string, input: Record<string, unknown> = {}) {
  return f.call(f.owner, 'PUT', `/v1/tasks/${id}/recurrence`, {
    version: 0,
    frequency: 'daily',
    interval: 1,
    startDate: '2030-01-01',
    endDate: null,
    timeZone: 'UTC',
    localTime: '09:00',
    paused: false,
    ...input,
  });
}
async function remind(id: string, input: Record<string, unknown> = {}) {
  return f.call(f.owner, 'PUT', `/v1/tasks/${id}/reminder`, {
    version: 0,
    enabled: true,
    daysBefore: 0,
    localTime: '09:00',
    timeZone: 'UTC',
    ...input,
  });
}
async function tick(now: string) {
  await new TaskSchedulingWorker(f.db, (e) => errors.push(e)).tick(new Date(now));
  expect(errors).toEqual([]);
}
async function occurrences(id: string) {
  return f.db.query(
    `SELECT t.*,to_char(o.occurrence_date,'YYYY-MM-DD') date FROM task_occurrences o JOIN task_recurrences r ON r.workspace_id=o.workspace_id AND r.id=o.recurrence_id JOIN tasks t ON t.workspace_id=o.workspace_id AND t.id=o.task_id WHERE r.task_id=$1 ORDER BY o.occurrence_date`,
    [id],
  );
}
async function inbox(session = f.owner) {
  return (await f.call(session, 'GET', '/v1/notifications?limit=50')).json<NotificationPage>();
}
describe('calendar arithmetic', () => {
  it('anchors monthly dates, leap days, weekly intervals and supported year boundaries', () => {
    expect([0, 1, 2, 3].map((i) => occurrenceDate('2030-01-31', 'monthly', 1, i))).toEqual([
      '2030-01-31',
      '2030-02-28',
      '2030-03-31',
      '2030-04-30',
    ]);
    expect(occurrenceDate('2032-02-29', 'monthly', 12, 1)).toBe('2033-02-28');
    expect(occurrenceDate('2030-01-01', 'weekly', 2, 1)).toBe('2030-01-15');
    expect(occurrenceDate('0099-12-31', 'daily', 1, 1)).toBe('0100-01-01');
    expect(occurrenceDate('9999-12-31', 'monthly', 1, 1)).toBeNull();
    expect(
      previewDates(
        {
          start: '2020-01-31',
          frequency: 'monthly',
          interval: 1,
          index: 0,
          end: null,
          paused: false,
        },
        '2030-02-01',
        '2030-03-31',
      ),
    ).toEqual(['2030-02-28', '2030-03-31']);
  });
});
describe('durable recurring tasks', () => {
  it('catches up independent occurrences atomically and deduplicates concurrent workers', async () => {
    const id = await create({
      description: 'Current source snapshot',
      assigneeId: f.mateBoot.me.id,
      priority: 'high',
      dueDate: '2030-01-01',
    });
    expect((await remind(id)).statusCode).toBe(200);
    expect((await repeat(id, { endDate: '2030-01-03' })).statusCode).toBe(200);
    const worker = new TaskSchedulingWorker(f.db, (e) => errors.push(e));
    await Promise.all([
      worker.tick(new Date('2030-01-03T10:00:00Z')),
      worker.tick(new Date('2030-01-03T10:00:00Z')),
    ]);
    expect(errors).toEqual([]);
    const rows = await occurrences(id);
    expect(rows.map((r) => r.date)).toEqual(['2030-01-01', '2030-01-02', '2030-01-03']);
    expect(rows[0]).toMatchObject({
      state: 'proposed',
      description: 'Current source snapshot',
      priority: 'high',
      assignee_id: f.mateBoot.me.id,
      parent_id: null,
    });
    expect((await settings(String(rows[0]!.id))).origin).toMatchObject({
      source_task_id: id,
      occurrence_date: '2030-01-01',
    });
    expect((await settings(String(rows[0]!.id))).reminder?.enabled).toBe(true);
    expect((await settings(id)).recurrence).toMatchObject({ next_date: null, occurrence_count: 3 });
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM audit_events WHERE resource_id=$1 AND action='task.created'",
          [rows[0]!.id],
        )
      )[0]?.n,
    ).toBe(1);
  });
  it('uses local wall time over DST gaps and overlaps with exactly one task per local date', async () => {
    const gap = await create();
    expect(
      (
        await repeat(gap, {
          startDate: '2030-03-10',
          endDate: '2030-03-10',
          localTime: '02:30',
          timeZone: 'America/New_York',
        })
      ).statusCode,
    ).toBe(200);
    expect((await settings(gap)).recurrence?.next_run_at).toBe('2030-03-10T07:30:00.000Z');
    await tick('2030-03-10T07:29:59Z');
    expect(await occurrences(gap)).toHaveLength(0);
    await tick('2030-03-10T07:30:00Z');
    expect(await occurrences(gap)).toHaveLength(1);
    const overlap = await create();
    await repeat(overlap, {
      startDate: '2030-11-03',
      endDate: '2030-11-03',
      localTime: '01:30',
      timeZone: 'America/New_York',
    });
    expect((await settings(overlap)).recurrence?.next_run_at).toBe('2030-11-03T06:30:00.000Z');
    await tick('2030-11-03T05:30:00Z');
    expect(await occurrences(overlap)).toHaveLength(0);
    await tick('2030-11-03T06:30:00Z');
    await tick('2030-11-03T07:30:00Z');
    expect(await occurrences(overlap)).toHaveLength(1);
  });
  it('preserves pause/resume cursors, extends ended schedules, and rechecks versions', async () => {
    const id = await create();
    await repeat(id, { endDate: '2030-01-01' });
    await tick('2030-01-01T10:00:00Z');
    let rule = (await settings(id)).recurrence!;
    expect((await repeat(id, { version: 1, paused: true })).statusCode).toBe(409);
    expect(
      (await repeat(id, { version: rule.version, paused: true, endDate: '2030-01-03' })).statusCode,
    ).toBe(200);
    await tick('2030-01-03T10:00:00Z');
    expect(await occurrences(id)).toHaveLength(1);
    rule = (await settings(id)).recurrence!;
    expect(rule.next_date).toBe('2030-01-02');
    await repeat(id, { version: rule.version, paused: false, endDate: '2030-01-03' });
    await tick('2030-01-03T10:00:00Z');
    expect(await occurrences(id)).toHaveLength(3);
    rule = (await settings(id)).recurrence!;
    await repeat(id, { version: rule.version, startDate: '2030-01-02', endDate: '2030-01-04' });
    await tick('2030-01-04T10:00:00Z');
    expect((await occurrences(id)).map((r) => r.date)).toEqual([
      '2030-01-01',
      '2030-01-02',
      '2030-01-03',
      '2030-01-04',
    ]);
  });
  it('bounds catch-up and suspends schedules after private assignee access is revoked', async () => {
    const id = await create();
    await repeat(id, { startDate: '2029-01-01' });
    await tick('2030-01-01T10:00:00Z');
    expect(await occurrences(id)).toHaveLength(50);
    const r = (await settings(id)).recurrence!;
    await repeat(id, { version: r.version, startDate: '2029-01-01', paused: true });
    const group = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Recurring private work',
      membershipIds: [f.mateBoot.me.id],
    });
    const source = group.json<{ id: string }>().id,
      privateTask = await create({ conversationId: source, assigneeId: f.mateBoot.me.id });
    await repeat(privateTask);
    await f.call(f.owner, 'PATCH', `/v1/conversations/${source}`, {
      version: 1,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    await tick('2030-01-01T10:00:00Z');
    expect(await occurrences(privateTask)).toHaveLength(0);
    expect((await settings(privateTask)).recurrence).toMatchObject({ paused: true });
  });
  it('rolls back occurrence creation and cursor advancement if its outbox write fails', async () => {
    const id = await create();
    await repeat(id, { endDate: '2030-01-01' });
    await f.db.query(
      `CREATE FUNCTION fail_schedule_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='task.schedule_advanced' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`,
    );
    await f.db.query(
      'CREATE TRIGGER fail_schedule_event BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_schedule_event()',
    );
    try {
      await new TaskSchedulingWorker(f.db, (e) => errors.push(e)).tick(
        new Date('2030-01-01T10:00:00Z'),
      );
      expect(errors).toHaveLength(1);
      expect(await occurrences(id)).toHaveLength(0);
      expect((await settings(id)).recurrence?.next_date).toBe('2030-01-01');
    } finally {
      await f.db.query('DROP TRIGGER fail_schedule_event ON outbox_events');
      await f.db.query('DROP FUNCTION fail_schedule_event()');
    }
    errors.length = 0;
    await tick('2030-01-01T10:00:00Z');
    expect(await occurrences(id)).toHaveLength(1);
  });
});
describe('due-date reminders', () => {
  it('delivers once, honors time-zone offsets, and invalidates moved due dates and changed assignees', async () => {
    const id = await create({ dueDate: '2030-01-02', assigneeId: f.mateBoot.me.id });
    expect((await remind(id, { daysBefore: 1, timeZone: 'Asia/Kolkata' })).statusCode).toBe(200);
    await tick('2030-01-01T03:29:59Z');
    expect(
      (await inbox(f.mate)).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(0);
    await Promise.all([tick('2030-01-01T03:30:00Z'), tick('2030-01-01T03:30:00Z')]);
    expect(
      (await inbox(f.mate)).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(1);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, {
          version: 1,
          title: 'Updated reminder title',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await inbox(f.mate)).items.find((n) => n.kind === 'task_reminder' && n.task_id === id)
        ?.excerpt,
    ).toBe('Updated reminder title');
    await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, { version: 2, dueDate: '2030-01-03' });
    expect(
      (await inbox(f.mate)).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(0);
    await tick('2030-01-02T03:30:00Z');
    expect(
      (await inbox(f.mate)).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(1);
    await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, {
      version: 3,
      assigneeId: f.ownerBoot.me.id,
    });
    expect(
      (await inbox(f.mate)).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(0);
    await tick('2030-01-02T04:30:00Z');
    expect(
      (await inbox()).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(1);
  });
  it('honors preferences and mutes, suppresses terminal tasks, and supports unassigned creator reminders', async () => {
    const id = await create({ dueDate: '2030-01-01' });
    await remind(id);
    await f.call(f.owner, 'PATCH', '/v1/notifications/preferences', { tasks: false });
    await tick('2030-01-01T10:00:00Z');
    expect(
      (await inbox()).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(0);
    await f.call(f.owner, 'PATCH', '/v1/notifications/preferences', { tasks: true });
    await tick('2030-01-01T10:00:00Z');
    expect(
      (await inbox()).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(0);
    const rule = (await settings(id)).reminder!;
    await remind(id, { version: rule.version });
    await tick('2030-01-01T10:00:00Z');
    expect(
      (await inbox()).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(1);
    await f.call(f.owner, 'POST', `/v1/tasks/${id}/transitions`, {
      version: 1,
      state: 'cancelled',
    });
    expect(
      (await inbox()).items.filter((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toHaveLength(0);
    const conversation = await f.channel(),
      muted = await create({ conversationId: conversation, dueDate: '2030-01-01' });
    await remind(muted);
    await f.call(f.owner, 'PUT', `/v1/conversations/${conversation}/notification-preferences`, {
      mode: 'muted',
    });
    await tick('2030-01-01T10:00:00Z');
    expect(
      (await inbox()).items.filter((n) => n.kind === 'task_reminder' && n.task_id === muted),
    ).toHaveLength(0);
  });
  it('rejects invalid dates, zones, missing due dates, and stale reminder writes', async () => {
    const id = await create();
    expect((await remind(id)).statusCode).toBe(400);
    expect((await repeat(id, { timeZone: 'Imaginary/Zone' })).statusCode).toBe(400);
    expect((await repeat(id, { endDate: '2029-12-31' })).statusCode).toBe(400);
    expect((await repeat(id, { localTime: '25:00' })).statusCode).toBe(400);
    expect((await repeat(id, { startDate: '0000-01-01' })).statusCode).toBe(400);
    expect((await remind(id, { enabled: false })).statusCode).toBe(200);
    expect((await remind(id, { enabled: false })).statusCode).toBe(409);
  });
});
describe('calendar and tenant boundaries', () => {
  it('pages calendar date windows and previews without materializing tasks', async () => {
    const id = await create({ dueDate: '2030-01-01' });
    await repeat(id, { frequency: 'monthly', startDate: '2030-01-31' });
    const later = await create({ dueDate: '2030-02-01' });
    await create({ dueDate: '2030-02-28' });
    await create();
    const response = await f.call(
      f.owner,
      'GET',
      '/v1/tasks/list?dueFrom=2030-02-01&dueThrough=2030-02-28&sort=due&limit=1',
    );
    const page = response.json<TaskPage>();
    expect(page.items[0]?.id).toBe(later);
    expect(page.next_cursor).toBeTruthy();
    const next = await f.call(
      f.owner,
      'GET',
      `/v1/tasks/list?dueFrom=2030-02-01&dueThrough=2030-02-28&sort=due&limit=1&cursor=${page.next_cursor}`,
    );
    expect(next.json<TaskPage>().items[0]?.due_date).toBe('2030-02-28');
    const list = await f.call(
      f.owner,
      'GET',
      '/v1/task-schedules?from=2030-02-01&through=2030-03-31&limit=100',
    );
    expect(
      list.json<RecurringTaskPage>().items.find((r) => r.task_id === id)?.preview_dates,
    ).toEqual(['2030-02-28', '2030-03-31']);
    expect(await occurrences(id)).toHaveLength(0);
    expect(
      (await f.call(f.owner, 'GET', '/v1/task-schedules?from=2030-01-01&through=2031-01-01'))
        .statusCode,
    ).toBe(400);
    expect(
      (await f.call(f.owner, 'GET', '/v1/tasks/list?dueFrom=2030-02-01&dueThrough=2030-01-01'))
        .statusCode,
    ).toBe(400);
  });
  it('enforces manager permissions, private audiences, forced RLS and composite references', async () => {
    const conv = await f.channel('private'),
      id = await create({ conversationId: conv, dueDate: '2030-01-01' });
    await repeat(id);
    await remind(id);
    for (const session of [f.mate, f.other])
      expect((await f.call(session, 'GET', `/v1/tasks/${id}/scheduling`)).statusCode).toBe(404);
    const publicTask = await create({ dueDate: '2030-01-01' });
    expect(
      (
        await f.call(f.mate, 'PUT', `/v1/tasks/${publicTask}/reminder`, {
          version: 0,
          enabled: true,
          daysBefore: 0,
          localTime: '09:00',
          timeZone: 'UTC',
        })
      ).statusCode,
    ).toBe(403);
    const list = (
      await f.call(f.mate, 'GET', '/v1/task-schedules?limit=100')
    ).json<RecurringTaskPage>();
    expect(list.items.some((r) => r.task_id === id)).toBe(false);
    await tick('2030-01-01T10:00:00Z');
    const db = scopedDatabase(f.db);
    for (const table of [
      'task_recurrences',
      'task_reminders',
      'task_occurrences',
      'task_reminder_deliveries',
    ])
      expect(
        await tenantScope(f.otherBoot.workspace.id, () =>
          db.query(`SELECT * FROM ${table} WHERE workspace_id=$1`, [f.ownerBoot.workspace.id]),
        ),
      ).toEqual([]);
    await expect(
      tenantScope(f.otherBoot.workspace.id, () =>
        db.query('INSERT INTO task_reminders(workspace_id,task_id) VALUES($1,$2)', [
          f.otherBoot.workspace.id,
          id,
        ]),
      ),
    ).rejects.toThrow();
    const detail = (await f.call(f.owner, 'GET', `/v1/tasks/${id}`)).json<TaskDetails>();
    expect(detail.can_manage).toBe(true);
    await expect(
      tenantScope(f.ownerBoot.workspace.id, () =>
        db.query('DELETE FROM task_occurrences WHERE workspace_id=$1', [f.ownerBoot.workspace.id]),
      ),
    ).rejects.toThrow();
  });
});

describe('schedule authorization and recovery', () => {
  it('creates occurrences in advance so their reminder can arrive before the due date', async () => {
    const id = await create({ dueDate: '2040-04-03' });
    await remind(id, { daysBefore: 1 });
    expect(
      (
        await repeat(id, {
          startDate: '2040-04-03',
          endDate: '2040-04-03',
          leadDays: 2,
          localTime: '08:00',
        })
      ).statusCode,
    ).toBe(200);
    await tick('2040-04-01T07:59:59Z');
    expect(await occurrences(id)).toHaveLength(0);
    await tick('2040-04-01T08:00:00Z');
    const rows = await occurrences(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe('2040-04-03');
    expect(
      (await inbox()).items.find((n) => n.kind === 'task_reminder' && n.task_id === rows[0]!.id),
    ).toBeUndefined();
    await tick('2040-04-02T09:00:00Z');
    expect(
      (await inbox()).items.find((n) => n.kind === 'task_reminder' && n.task_id === rows[0]!.id),
    ).toBeTruthy();
    const rule = (await settings(id)).recurrence!;
    await repeat(id, {
      version: rule.version,
      startDate: '2040-04-03',
      endDate: '2040-04-03',
      frequency: 'weekly',
      leadDays: 2,
    });
    const preview = (
      await f.call(
        f.owner,
        'GET',
        '/v1/task-schedules?from=2040-04-01&through=2040-04-30&limit=100',
      )
    ).json<RecurringTaskPage>();
    expect(preview.items.find((r) => r.task_id === id)?.preview_dates).toEqual([]);
  });
  it('rechecks the authorizing human’s management rights and permits an administrator to take over', async () => {
    const id = await create({ assigneeId: f.mateBoot.me.id });
    const body = {
      version: 0,
      frequency: 'daily',
      interval: 1,
      startDate: '2041-01-01',
      endDate: '2041-01-01',
      timeZone: 'UTC',
      localTime: '09:00',
      paused: false,
    };
    expect((await f.call(f.mate, 'PUT', `/v1/tasks/${id}/recurrence`, body)).statusCode).toBe(200);
    await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, {
      version: 1,
      assigneeId: f.ownerBoot.me.id,
    });
    await tick('2041-01-01T10:00:00Z');
    expect(await occurrences(id)).toHaveLength(0);
    const rule = (await settings(id)).recurrence!;
    expect(rule.paused).toBe(true);
    expect(rule.paused_reason).toBeTruthy();
    expect((await repeat(id, { ...body, version: rule.version })).statusCode).toBe(200);
    await tick('2041-01-01T10:00:00Z');
    expect(await occurrences(id)).toHaveLength(1);
  });
  it('rolls back reminder delivery with its outbox notification and hides reminders after private removal', async () => {
    const group = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Private reminders',
      membershipIds: [f.mateBoot.me.id],
    });
    const conversation = group.json<{ id: string }>().id,
      id = await create({
        conversationId: conversation,
        assigneeId: f.mateBoot.me.id,
        dueDate: '2042-01-01',
      });
    await remind(id);
    await f.db.query(
      `CREATE FUNCTION fail_reminder_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='notification.created' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`,
    );
    await f.db.query(
      'CREATE TRIGGER fail_reminder_event BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_reminder_event()',
    );
    try {
      await new TaskSchedulingWorker(f.db, (e) => errors.push(e)).tick(
        new Date('2042-01-01T10:00:00Z'),
      );
      expect(errors).toHaveLength(1);
      expect(
        await f.db.query('SELECT id FROM task_reminder_deliveries WHERE task_id=$1', [id]),
      ).toHaveLength(0);
    } finally {
      await f.db.query('DROP TRIGGER fail_reminder_event ON outbox_events');
      await f.db.query('DROP FUNCTION fail_reminder_event()');
    }
    errors.length = 0;
    await tick('2042-01-01T10:00:00Z');
    expect(
      (await inbox(f.mate)).items.find((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toBeTruthy();
    await f.call(f.owner, 'PATCH', `/v1/conversations/${conversation}`, {
      version: 1,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    expect(
      (await inbox(f.mate)).items.find((n) => n.kind === 'task_reminder' && n.task_id === id),
    ).toBeUndefined();
  });
});
