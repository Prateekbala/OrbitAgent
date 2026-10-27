import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopedDatabase, tenantScope } from '@ao/database';
import type {
  ProjectDetails,
  TaskDetails,
  TaskPage,
  ProjectPage,
  MilestonePage,
  LabelPage,
  TaskScheduling,
  RecurringTaskPage,
} from '@ao/contracts';
import { messagingFixture } from './messaging-fixture.js';
import { TaskSchedulingWorker } from '../src/scheduling/worker.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
});
afterAll(async () => {
  await f?.close();
});
async function project(input: Record<string, unknown> = {}, session = f.owner) {
  const r = await f.call(session, 'POST', '/v1/projects', {
    clientId: randomUUID(),
    name: 'Project ' + randomUUID(),
    ...input,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
}
async function milestone(projectId: string, input: Record<string, unknown> = {}) {
  const r = await f.call(f.owner, 'POST', `/v1/projects/${projectId}/milestones`, {
    clientId: randomUUID(),
    title: 'Milestone ' + randomUUID(),
    ...input,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
}
async function label(input: Record<string, unknown> = {}, session = f.owner) {
  const r = await f.call(session, 'POST', '/v1/labels', {
    clientId: randomUUID(),
    name: 'Label ' + randomUUID(),
    ...input,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
}
async function task(input: Record<string, unknown> = {}, session = f.owner) {
  const r = await f.call(session, 'POST', '/v1/tasks', { title: 'Organized task', ...input });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
}
async function details(id: string) {
  const r = await f.call(f.owner, 'GET', `/v1/tasks/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<TaskDetails>().task;
}
async function closeTask(id: string) {
  const t = await details(id);
  const r = await f.call(f.owner, 'POST', `/v1/tasks/${id}/transitions`, {
    version: t.version,
    state: 'cancelled',
  });
  expect(r.statusCode, r.body).toBe(200);
}
async function projectDetails(id: string, session = f.owner) {
  const r = await f.call(session, 'GET', `/v1/projects/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<ProjectDetails>();
}
describe('projects and milestones', () => {
  it('deduplicates creation, captures versions, validates dates and enforces project managers', async () => {
    const input = {
      clientId: randomUUID(),
      name: 'Release program',
      startDate: '2030-01-01',
      targetDate: '2030-02-01',
    };
    const responses = await Promise.all([
      f.call(f.owner, 'POST', '/v1/projects', input),
      f.call(f.owner, 'POST', '/v1/projects', input),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    const id = responses[0]!.json<{ id: string }>().id;
    expect(responses[1]!.json().id).toBe(id);
    expect(
      (await f.call(f.owner, 'POST', '/v1/projects', { ...input, name: 'Different retry' }))
        .statusCode,
    ).toBe(409);
    expect((await projectDetails(id, f.mate)).can_manage).toBe(false);
    expect(
      (
        await f.call(f.mate, 'PATCH', `/v1/projects/${id}`, {
          version: 1,
          name: 'Unauthorized rename',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/projects/${id}`, {
          version: 1,
          startDate: '2031-01-01',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/projects/${id}`, {
          version: 1,
          ownerId: f.mateBoot.me.id,
          status: 'active',
        })
      ).statusCode,
    ).toBe(200);
    expect((await projectDetails(id, f.mate)).can_manage).toBe(true);
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/projects/${id}`, { version: 1, description: 'Stale' }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await f.call(f.mate, 'PATCH', `/v1/projects/${id}`, {
          version: 2,
          description: 'Owned by teammate',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/projects/${id}`, {
          version: 3,
          conversationId: f.ownerBoot.channels[0]!.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/projects', {
          ...input,
          clientId: randomUUID(),
          ownerId: f.otherBoot.me.id,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('keeps private audiences exact and revokes project, milestone, task and retry access after removal', async () => {
    const response = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Private project team',
      membershipIds: [f.mateBoot.me.id],
    });
    const conversationId = response.json<{ id: string }>().id;
    const input = {
      name: 'Private deliverable',
      conversationId,
      clientId: randomUUID(),
      ownerId: f.mateBoot.me.id,
    };
    const added = await f.call(f.mate, 'POST', '/v1/projects', input);
    expect(added.statusCode, added.body).toBe(201);
    const id = added.json<{ id: string }>().id;
    const m = await milestone(id);
    const t = await task({ projectId: id, milestoneId: m });
    expect((await details(t)).conversation_id).toBe(conversationId);
    const publicTask = await task();
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/tasks/${publicTask}`, { version: 1, projectId: id })
      ).json().error.code,
    ).toBe('PROJECT_SCOPE_MISMATCH');
    expect((await f.call(f.other, 'GET', `/v1/projects/${id}`)).statusCode).toBe(404);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/conversations/${conversationId}`, {
          version: 1,
          member: { membershipId: f.mateBoot.me.id, action: 'remove' },
        })
      ).statusCode,
    ).toBe(200);
    for (const suffix of ['', '/milestones'])
      expect((await f.call(f.mate, 'GET', `/v1/projects/${id}${suffix}`)).statusCode).toBe(404);
    expect((await f.call(f.mate, 'POST', '/v1/projects', input)).statusCode).toBe(404);
    expect((await f.call(f.mate, 'GET', `/v1/tasks/${t}`)).statusCode).toBe(404);
    expect(
      (await f.call(f.mate, 'GET', '/v1/projects?q=Private%20deliverable')).json<ProjectPage>()
        .items,
    ).toEqual([]);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/projects/${id}`, {
          version: 1,
          description: 'Keep managing departed owner',
        })
      ).statusCode,
    ).toBe(200);
  });
  it('tracks milestones and task counts, gates completion and serializes concurrent placement', async () => {
    const id = await project(),
      m = await milestone(id),
      t = await task({ projectId: id, milestoneId: m, dueDate: '2000-01-01' });
    expect((await projectDetails(id)).project).toMatchObject({
      task_count: 1,
      completed_count: 0,
      cancelled_count: 0,
      overdue_count: 1,
    });
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/projects/${id}/milestones/${m}`, {
          version: 1,
          status: 'completed',
        })
      ).json().error.code,
    ).toBe('MILESTONE_HAS_OPEN_TASKS');
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/projects/${id}`, { version: 1, status: 'completed' }))
        .statusCode,
    ).toBe(409);
    await closeTask(t);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/projects/${id}/milestones/${m}`, {
          version: 1,
          status: 'completed',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/tasks', {
          title: 'Late milestone task',
          projectId: id,
          milestoneId: m,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/projects/${id}/milestones/${m}`, {
          version: 1,
          title: 'Stale milestone',
        })
      ).statusCode,
    ).toBe(409);
    const ms = (await f.call(f.owner, 'GET', `/v1/projects/${id}/milestones`)).json<MilestonePage>()
      .items[0]!;
    expect(ms).toMatchObject({
      task_count: 1,
      cancelled_count: 1,
      status: 'completed',
      version: 2,
    });
    const results = await Promise.all([
      f.call(f.owner, 'PATCH', `/v1/projects/${id}`, { version: 1, status: 'completed' }),
      f.call(f.owner, 'POST', '/v1/tasks', { title: 'Racing project task', projectId: id }),
    ]);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(1);
    expect(results.filter((r) => [200, 201].includes(r.statusCode))).toHaveLength(1);
  });
  it('inherits subtask organization and clears a milestone when moving projects', async () => {
    const a = await project(),
      b = await project(),
      m = await milestone(a),
      parent = await task({ projectId: a, milestoneId: m }),
      child = await task({ parentId: parent });
    expect(await details(child)).toMatchObject({ project_id: a, milestone_id: m });
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/tasks/${child}`, {
          version: 1,
          projectId: b,
          milestoneId: m,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/tasks/${child}`, { version: 1, projectId: b }))
        .statusCode,
    ).toBe(200);
    expect(await details(child)).toMatchObject({ project_id: b, milestone_id: null });
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/projects/${b}`, { version: 1, status: 'archived' }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/tasks/${child}`, {
          version: 2,
          title: 'Maintain archived work',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.owner, 'POST', '/v1/tasks', { title: 'Blocked archived work', projectId: b }))
        .statusCode,
    ).toBe(409);
  });
  it('pages project and milestone catalogs without duplicates and filters audience/status', async () => {
    const prefix = 'Catalog ' + randomUUID();
    const a = await project({ name: prefix + ' Alpha', status: 'active' }),
      b = await project({ name: prefix + ' Beta', status: 'active' });
    await project({ name: prefix + ' Closed', status: 'archived' });
    const page = (
      await f.call(
        f.owner,
        'GET',
        `/v1/projects?q=${encodeURIComponent(prefix)}&status=active&workspaceOnly=true&limit=1`,
      )
    ).json<ProjectPage>();
    expect(page.items).toHaveLength(1);
    expect(page.next_after).toBeTruthy();
    const next = (
      await f.call(
        f.owner,
        'GET',
        `/v1/projects?q=${encodeURIComponent(prefix)}&status=active&workspaceOnly=true&limit=1&after=${page.next_after}`,
      )
    ).json<ProjectPage>();
    expect(new Set([...page.items, ...next.items].map((p) => p.id))).toEqual(new Set([a, b]));
    expect(next.next_after).toBeNull();
    await milestone(a);
    await milestone(a);
    const ms = (
      await f.call(f.owner, 'GET', `/v1/projects/${a}/milestones?limit=1`)
    ).json<MilestonePage>();
    const rest = (
      await f.call(f.owner, 'GET', `/v1/projects/${a}/milestones?limit=1&after=${ms.next_after}`)
    ).json<MilestonePage>();
    expect(rest.items[0]!.id).not.toBe(ms.items[0]!.id);
    expect(rest.next_after).toBeNull();
  });
});
describe('task labels and organization filters', () => {
  it('normalizes unique names, deduplicates retries, versions changes and limits label management', async () => {
    const name = 'Bug ' + randomUUID(),
      input = { name: ' ' + name + ' ', clientId: randomUUID(), color: 'rose' };
    const responses = await Promise.all([
      f.call(f.mate, 'POST', '/v1/labels', input),
      f.call(f.mate, 'POST', '/v1/labels', input),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    const id = responses[0]!.json<{ id: string }>().id;
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/labels', {
          clientId: randomUUID(),
          name: name.toUpperCase(),
        })
      ).statusCode,
    ).toBe(409);
    const foreign = await label();
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/labels/${foreign}`, { version: 1, name: 'Not mine' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/labels/${id}`, { version: 1, color: 'blue' })).statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/labels/${id}`, { version: 1, color: 'sage' })).statusCode,
    ).toBe(409);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/labels/${id}`, { version: 2, archived: true }))
        .statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.owner, 'POST', '/v1/labels', { clientId: randomUUID(), name })).statusCode,
    ).toBe(409);
    expect(
      (await f.call(f.other, 'PATCH', `/v1/labels/${id}`, { version: 3, color: 'sage' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await f.call(f.owner, 'GET', `/v1/labels?archived=true&q=${encodeURIComponent(name)}`)
      ).json<LabelPage>().items,
    ).toMatchObject([{ id, name, color: 'blue', archived: true, version: 3 }]);
  });
  it('preserves archived associations, forbids new archived labels and enforces tenant/size boundaries', async () => {
    const id = await label(),
      t = await task({ labelIds: [id] });
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/labels/${id}`, { version: 1, archived: true }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/tasks/${t}`, {
          version: 1,
          labelIds: [id],
          title: 'Keep historic label',
        })
      ).statusCode,
    ).toBe(200);
    expect((await details(t)).labels[0]).toMatchObject({ id, archived: true });
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/tasks', {
          title: 'New archived association',
          labelIds: [id],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/tasks/${t}`, { version: 2, labelIds: [] })).statusCode,
    ).toBe(200);
    expect((await details(t)).labels).toEqual([]);
    const foreign = await label({}, f.other);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/tasks/${t}`, { version: 3, labelIds: [foreign] }))
        .statusCode,
    ).toBe(400);
    const ids = [];
    for (let i = 0; i < 21; i++) ids.push(await label());
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/tasks/${t}`, { version: 3, labelIds: ids.slice(0, 20) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/tasks/${t}`, { version: 4, labelIds: ids })).statusCode,
    ).toBe(400);
    expect((await details(t)).labels).toHaveLength(20);
  });
  it('filters paged task lists and schedule previews by project, milestone and label', async () => {
    const p = await project(),
      m = await milestone(p),
      l = await label();
    const a = await task({ projectId: p, milestoneId: m, labelIds: [l], dueDate: '2030-01-01' }),
      b = await task({ projectId: p, milestoneId: m, labelIds: [l] }),
      other = await task({ projectId: p });
    const query = `projectId=${p}&milestoneId=${m}&labelId=${l}&limit=1`;
    const first = (await f.call(f.owner, 'GET', `/v1/tasks/list?${query}`)).json<TaskPage>();
    expect(first.items).toHaveLength(1);
    const next = (
      await f.call(f.owner, 'GET', `/v1/tasks/list?${query}&cursor=${first.next_cursor}`)
    ).json<TaskPage>();
    expect(new Set([...first.items, ...next.items].map((t) => t.id))).toEqual(new Set([a, b]));
    expect(next.next_cursor).toBeNull();
    expect(
      (await f.call(f.owner, 'GET', `/v1/tasks/list?projectId=${p}&cursor=${first.next_cursor}`))
        .statusCode,
    ).toBe(400);
    expect(
      (await f.call(f.owner, 'GET', `/v1/tasks/list?noProject=true&projectId=${p}`)).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call(f.owner, 'PUT', `/v1/tasks/${a}/recurrence`, {
          version: 0,
          frequency: 'daily',
          interval: 1,
          startDate: '2030-01-01',
          endDate: '2030-01-02',
          timeZone: 'UTC',
          localTime: '09:00',
          paused: false,
        })
      ).statusCode,
    ).toBe(200);
    const rules = (
      await f.call(
        f.owner,
        'GET',
        `/v1/task-schedules?from=2030-01-01&through=2030-01-31&projectId=${p}&milestoneId=${m}&labelId=${l}`,
      )
    ).json<RecurringTaskPage>();
    expect(rules.items.map((r) => r.task_id)).toEqual([a]);
    expect((await details(other)).labels).toEqual([]);
    await f.call(f.owner, 'PUT', `/v1/tasks/${a}/recurrence`, {
      version: 1,
      frequency: 'daily',
      interval: 1,
      startDate: '2030-01-01',
      endDate: '2030-01-02',
      timeZone: 'UTC',
      localTime: '09:00',
      paused: true,
    });
  });
  it('applies bulk organization atomically and never grants task management through project ownership', async () => {
    const p = await project({ ownerId: f.mateBoot.me.id }),
      m = await milestone(p),
      l = await label(),
      a = await task(),
      b = await task();
    const input = {
      clientId: randomUUID(),
      action: 'update',
      targets: [
        { id: a, version: 1 },
        { id: b, version: 1 },
      ],
      patch: { projectId: p, milestoneId: m, labelIds: [l] },
    };
    expect((await f.call(f.owner, 'POST', '/v1/tasks/bulk', input)).statusCode).toBe(200);
    expect((await f.call(f.owner, 'POST', '/v1/tasks/bulk', input)).json().replayed).toBe(true);
    expect(await details(a)).toMatchObject({
      project_id: p,
      milestone_id: m,
      version: 2,
      labels: [{ id: l }],
    });
    expect(
      (
        await f.call(f.mate, 'PATCH', `/v1/tasks/${a}`, {
          version: 2,
          title: 'Project ownership is not task access',
        })
      ).statusCode,
    ).toBe(403);
    const priv = await task({ conversationId: await f.channel('private') });
    const rejected = await f.call(f.owner, 'POST', '/v1/tasks/bulk', {
      ...input,
      clientId: randomUUID(),
      targets: [
        { id: b, version: 2 },
        { id: priv, version: 1 },
      ],
      patch: { projectId: p, labelIds: [] },
    });
    expect(rejected.statusCode).toBe(409);
    expect(await details(b)).toMatchObject({ version: 2, milestone_id: m, labels: [{ id: l }] });
  });
});
describe('organization database and scheduler invariants', () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'keeps comment allocation independent of a concurrent project graph lock',
    async () => {
      const id = await task({ projectId: await project() });
      let release!: () => void, acquired!: () => void;
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = f.db.transaction(async (tx) => {
        await tx.query('SELECT lock_task_graph($1)', [f.ownerBoot.workspace.id]);
        acquired();
        await barrier;
      });
      await ready;
      const comment = f.call(f.mate, 'POST', `/v1/tasks/${id}/comments`, {
        body: 'Progress while a project changes',
        clientId: randomUUID(),
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          comment,
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), 2000);
          }),
        ]);
        expect(
          result?.statusCode,
          result?.body ?? 'Comment allocation waited for the graph lock',
        ).toBe(201);
      } finally {
        clearTimeout(timeout);
        release();
        await held;
        await comment;
      }
      expect((await details(id)).version).toBe(1);
    },
  );

  it('enforces forced RLS, audience and composite references below the API', async () => {
    const p = await project(),
      m = await milestone(p),
      l = await label(),
      t = await task({ projectId: p, milestoneId: m, labelIds: [l] });
    const scoped = scopedDatabase(f.db);
    for (const table of ['projects', 'project_milestones', 'work_labels', 'task_label_links'])
      expect(
        await tenantScope(f.otherBoot.workspace.id, () =>
          scoped.query(`SELECT * FROM ${table} WHERE workspace_id=$1`, [f.ownerBoot.workspace.id]),
        ),
      ).toEqual([]);
    await expect(
      tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query(
          'INSERT INTO task_label_links(workspace_id,task_id,label_id,assigned_by) VALUES($1,$2,$3,$4)',
          [f.otherBoot.workspace.id, t, l, f.otherBoot.me.id],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      f.db.query('UPDATE projects SET conversation_id=$2,version=version+1 WHERE id=$1', [
        p,
        f.ownerBoot.channels[0]!.id,
      ]),
    ).rejects.toThrow();
    await expect(
      f.db.query("UPDATE projects SET status='completed',version=version+1 WHERE id=$1", [p]),
    ).rejects.toThrow();
    await expect(
      f.db.query("UPDATE project_milestones SET status='completed',version=version+1 WHERE id=$1", [
        m,
      ]),
    ).rejects.toThrow();
    const privateP = await project({ conversationId: await f.channel('private') });
    await expect(
      f.db.query('UPDATE tasks SET project_id=$2,milestone_id=NULL,version=version+1 WHERE id=$1', [
        t,
        privateP,
      ]),
    ).rejects.toThrow();
    await expect(
      f.db.query("UPDATE work_labels SET name='No revision' WHERE id=$1", [l]),
    ).rejects.toThrow();
    await expect(
      tenantScope(f.ownerBoot.workspace.id, () =>
        scoped.query('DELETE FROM projects WHERE workspace_id=$1 AND id=$2', [
          f.ownerBoot.workspace.id,
          p,
        ]),
      ),
    ).rejects.toThrow();
  });
  it('copies current organization and active labels to occurrences and pauses closed project schedules', async () => {
    const p = await project(),
      m = await milestone(p),
      active = await label(),
      archived = await label();
    const source = await task({ projectId: p, milestoneId: m, labelIds: [active, archived] });
    await f.call(f.owner, 'PATCH', `/v1/labels/${archived}`, { version: 1, archived: true });
    expect(
      (
        await f.call(f.owner, 'PUT', `/v1/tasks/${source}/recurrence`, {
          version: 0,
          frequency: 'daily',
          interval: 1,
          startDate: '2031-01-01',
          endDate: '2031-01-03',
          timeZone: 'UTC',
          localTime: '09:00',
          paused: false,
        })
      ).statusCode,
    ).toBe(200);
    const errors: unknown[] = [];
    const worker = new TaskSchedulingWorker(f.db, (e) => errors.push(e));
    await worker.tick(new Date('2031-01-01T10:00:00Z'));
    expect(errors).toEqual([]);
    const rows = await f.db.query(
      'SELECT t.id FROM tasks t JOIN task_occurrences o ON o.task_id=t.id JOIN task_recurrences r ON r.id=o.recurrence_id WHERE r.task_id=$1',
      [source],
    );
    expect(rows).toHaveLength(1);
    expect(await details(String(rows[0]!.id))).toMatchObject({
      project_id: p,
      milestone_id: m,
      labels: [{ id: active }],
    });
    await f.call(f.owner, 'PATCH', `/v1/projects/${p}`, { version: 1, status: 'archived' });
    expect(
      (
        await f.call(
          f.owner,
          'GET',
          `/v1/task-schedules?from=2031-01-01&through=2031-01-31&projectId=${p}`,
        )
      ).json<RecurringTaskPage>().items,
    ).toEqual([]);
    await worker.tick(new Date('2031-01-02T10:00:00Z'));
    expect(errors).toEqual([]);
    const schedule = (
      await f.call(f.owner, 'GET', `/v1/tasks/${source}/scheduling`)
    ).json<TaskScheduling>();
    expect(schedule.recurrence).toMatchObject({ paused: true, occurrence_count: 1 });
    expect(schedule.recurrence?.paused_reason).toContain('project');
  });
});
