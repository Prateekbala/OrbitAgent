import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scopedDatabase, tenantScope } from '@ao/database';
import type {
  TaskDetails,
  TaskPage,
  TaskComments,
  TaskRelations,
  TaskHistory,
  NotificationPage,
} from '@ao/contracts';
import { messagingFixture } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
});
afterAll(async () => {
  await f?.close();
});
async function create(extra: Record<string, unknown> = {}, session = f.owner) {
  const response = await f.call(session, 'POST', '/v1/tasks', {
    title: 'Task ' + randomUUID().slice(0, 8),
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}
async function details(id: string, session = f.owner) {
  const response = await f.call(session, 'GET', `/v1/tasks/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TaskDetails>();
}
async function move(id: string, state: string, session = f.owner, evidence = '') {
  const task = (await details(id, session)).task;
  return f.call(session, 'POST', `/v1/tasks/${id}/transitions`, {
    version: task.version,
    state,
    evidence,
  });
}
async function finish(id: string) {
  for (const state of ['queued', 'active', 'awaiting_review', 'completed']) {
    const response = await move(
      id,
      state,
      f.owner,
      state === 'completed' ? 'Verified by integration checks' : '',
    );
    expect(response.statusCode, response.body).toBe(200);
  }
}
async function link(id: string, target: string, version?: number) {
  return f.call(f.owner, 'PUT', `/v1/tasks/${id}/dependencies`, {
    version: version ?? (await details(id)).task.version,
    dependsOnId: target,
  });
}
async function comment(id: string, body: string, session = f.mate, clientId = randomUUID()) {
  return f.call(session, 'POST', `/v1/tasks/${id}/comments`, { body, clientId });
}
describe('task metadata and ownership', () => {
  it('sets creator, preserves retry identity and versions edits, due dates and assignment', async () => {
    const input = {
      title: 'Retryable task',
      description: 'Original brief',
      dueDate: '2026-11-14',
      assigneeId: f.mateBoot.me.id,
      clientId: randomUUID(),
    };
    const response = await f.call(f.owner, 'POST', '/v1/tasks', input);
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json<{ id: string }>().id;
    expect((await details(id)).task).toMatchObject({
      due_date: '2026-11-14',
      created_by: f.ownerBoot.me.id,
      creator_name: 'Owner',
      version: 1,
      assignee_id: f.mateBoot.me.id,
    });
    const edited = await f.call(f.mate, 'PATCH', `/v1/tasks/${id}`, {
      version: 1,
      title: 'Changed task',
      dueDate: null,
      priority: 'high',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().task).toMatchObject({ title: 'Changed task', version: 2, due_date: null });
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, { version: 1, title: 'Stale edit' }))
        .statusCode,
    ).toBe(409);
    expect((await f.call(f.owner, 'POST', '/v1/tasks', input)).json()).toMatchObject({
      id,
      replayed: true,
    });
    expect(
      (await f.call(f.owner, 'POST', '/v1/tasks', { ...input, title: 'Different retry' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, { version: 2, assigneeId: null }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(f.mate, 'PATCH', `/v1/tasks/${id}`, {
          version: 3,
          description: 'No longer assigned',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, { version: 3, dueDate: '2026-02-30' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, { version: 3, dueDate: '0000-01-01' }))
        .statusCode,
    ).toBe(400);
  });
  it('allows reader comments without permitting edits or attaching subtasks to another person’s work', async () => {
    const id = await create({ assigneeId: f.ownerBoot.me.id });
    expect((await details(id, f.mate)).can_manage).toBe(false);
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/tasks/${id}`, { version: 1, title: 'Unauthorized' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.call(f.mate, 'POST', '/v1/tasks', { title: 'Unapproved child', parentId: id }))
        .statusCode,
    ).toBe(403);
    expect((await comment(id, 'Reader has useful context')).statusCode).toBe(201);
  });
  it('filters overdue and assigned work and paginates deterministic due/priority/newest lists', async () => {
    const prefix = 'Filter ' + randomUUID();
    const old = await create({
      title: prefix + ' old',
      dueDate: '2026-11-14',
      priority: 'high',
      assigneeId: f.mateBoot.me.id,
    });
    await create({ title: prefix + ' today', dueDate: '2026-11-15', priority: 'normal' });
    await create({ title: prefix + ' future', dueDate: '2026-11-16', priority: 'low' });
    await create({ title: prefix + ' no date' });
    const completed = await create({ title: prefix + ' done', dueDate: '2026-11-01' });
    await finish(completed);
    const query = (extra: Record<string, string>) =>
      f.call(f.owner, 'GET', '/v1/tasks/list?' + new URLSearchParams({ q: prefix, ...extra }));
    const overdue = (await query({ overdue: 'true', asOf: '2026-11-15' })).json<TaskPage>();
    expect(overdue.items.map((t) => t.id)).toEqual([old]);
    expect(
      (await query({ assigneeId: f.mateBoot.me.id })).json<TaskPage>().items.map((t) => t.id),
    ).toEqual([old]);
    for (const sort of ['newest', 'due', 'priority']) {
      const ids = new Set<string>();
      let cursor: string | null = null;
      for (let n = 0; n < 3; n++) {
        const response = await query({ sort, limit: '2', ...(cursor ? { cursor } : {}) });
        expect(response.statusCode, response.body).toBe(200);
        const page = response.json<TaskPage>();
        for (const task of page.items) {
          expect(ids.has(task.id)).toBe(false);
          ids.add(task.id);
        }
        cursor = page.next_cursor;
      }
      expect(ids.size).toBe(5);
      expect(cursor).toBeNull();
    }
    const page = (await query({ sort: 'due', limit: '1' })).json<TaskPage>();
    expect(
      (await query({ sort: 'priority', limit: '1', cursor: page.next_cursor! })).statusCode,
    ).toBe(400);
    expect((await query({ roots: 'true', parentId: old })).statusCode).toBe(400);
  });
});
describe('subtask and dependency graph', () => {
  it('supports nested subtasks and prevents hierarchy, dependency and mixed cycles', async () => {
    const parent = await create(),
      child = await create({ parentId: parent }),
      grandchild = await create({ parentId: child });
    expect((await details(child)).parent?.id).toBe(parent);
    expect((await details(parent)).task.subtask_count).toBe(1);
    const badParent = await f.call(f.owner, 'PATCH', `/v1/tasks/${parent}`, {
      version: 1,
      parentId: grandchild,
    });
    expect(badParent.statusCode, badParent.body).toBe(409);
    expect(badParent.json().error.code).toBe('TASK_CYCLE');
    const a = await create(),
      b = await create();
    expect((await link(a, b)).statusCode).toBe(200);
    expect((await link(b, a)).json().error.code).toBe('TASK_CYCLE');
    const external = await create();
    expect((await link(external, parent)).statusCode).toBe(200);
    expect((await link(grandchild, external)).json().error.code).toBe('TASK_CYCLE');
    expect((await link(parent, parent)).json().error.code).toBe('TASK_CYCLE');
    const related = (
      await f.call(f.owner, 'GET', `/v1/tasks/${parent}/relations?kind=subtasks`)
    ).json<TaskRelations>();
    expect(related.items.map((t) => t.id)).toEqual([child]);
    const reparent = await f.call(f.owner, 'PATCH', `/v1/tasks/${child}`, {
      version: 1,
      parentId: null,
    });
    expect(reparent.statusCode, reparent.body).toBe(200);
    expect((await details(child)).parent).toBeNull();
  });
  it('gates dependent execution and parent completion/cancellation without auto-completing children', async () => {
    const parent = await create(),
      child = await create({ parentId: parent }),
      prerequisite = await create();
    expect((await link(child, prerequisite)).statusCode).toBe(200);
    expect((await move(child, 'queued')).statusCode).toBe(200);
    expect((await move(child, 'active')).json().error.code).toBe('DEPENDENCIES_UNRESOLVED');
    await finish(prerequisite);
    expect((await move(child, 'active')).statusCode).toBe(200);
    for (const state of ['queued', 'active', 'awaiting_review'])
      expect((await move(parent, state)).statusCode).toBe(200);
    expect((await move(parent, 'completed', f.owner, 'Parent review')).json().error.code).toBe(
      'SUBTASKS_OPEN',
    );
    expect((await move(parent, 'cancelled')).json().error.code).toBe('SUBTASKS_OPEN');
    expect((await move(child, 'awaiting_review')).statusCode).toBe(200);
    expect((await move(child, 'completed', f.owner, 'Child verified')).statusCode).toBe(200);
    expect((await move(parent, 'completed', f.owner, 'All subtasks verified')).statusCode).toBe(
      200,
    );
    const illegal = await f.call(f.owner, 'POST', '/v1/tasks', {
      title: 'Late unfinished child',
      parentId: parent,
    });
    expect(illegal.statusCode, illegal.body).toBe(409);
    const history = (
      await f.call(f.owner, 'GET', `/v1/tasks/${parent}/history?limit=2`)
    ).json<TaskHistory>();
    expect(history.items[0]).toMatchObject({
      to_state: 'completed',
      evidence: 'All subtasks verified',
      actor_name: 'Owner',
    });
    expect(history.next_before).toBeTruthy();
    expect(
      (
        await f.call(f.owner, 'GET', `/v1/tasks/${parent}/history?before=${history.next_before}`)
      ).json<TaskHistory>().items,
    ).toHaveLength(2);
  });
  it('does not treat cancelled prerequisites as successful and versions dependency changes', async () => {
    const a = await create(),
      b = await create();
    expect((await move(b, 'cancelled')).statusCode).toBe(200);
    expect((await link(a, b, 1)).statusCode).toBe(200);
    expect((await link(a, b, 1)).json().replayed).toBe(true);
    expect((await move(a, 'queued')).statusCode).toBe(200);
    expect((await move(a, 'active')).json().error.code).toBe('DEPENDENCIES_UNRESOLVED');
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/tasks/${a}/dependencies/${b}`, { version: 1 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/tasks/${a}/dependencies/${b}`, { version: 3 }))
        .statusCode,
    ).toBe(200);
    expect((await move(a, 'active')).statusCode).toBe(200);
    const c = await create();
    expect((await link(a, c)).json().error.code).toBe('DEPENDENCIES_UNRESOLVED');
  });
  it('serializes concurrent reverse edges so exactly one can commit', async () => {
    const a = await create(),
      b = await create();
    const responses = await Promise.all([link(a, b, 1), link(b, a, 1)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((r) => r.statusCode === 409)!.json().error.code).toBe('TASK_CYCLE');
  });
  it('serializes parent completion against concurrent child creation', async () => {
    const parent = await create();
    for (const state of ['queued', 'active', 'awaiting_review']) await move(parent, state);
    const responses = await Promise.all([
      f.call(f.owner, 'POST', `/v1/tasks/${parent}/transitions`, {
        version: 4,
        state: 'completed',
        evidence: 'All known work verified',
      }),
      f.call(f.owner, 'POST', '/v1/tasks', { title: 'Racing child', parentId: parent }),
    ]);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(1);
    expect(responses.filter((r) => [200, 201].includes(r.statusCode))).toHaveLength(1);
  });
});
describe('comments and notifications', () => {
  it('retains comment retry identity across edits/deletion, enforces versions and authors, and pages tombstones', async () => {
    const task = await create(),
      clientId = randomUUID();
    const first = await comment(task, 'Original task discussion', f.mate, clientId);
    expect(first.statusCode, first.body).toBe(201);
    const id = first.json<{ id: string }>().id;
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/tasks/${task}/comments/${id}`, {
          version: 1,
          body: 'Admin cannot impersonate author',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.call(f.mate, 'PATCH', `/v1/tasks/${task}/comments/${id}`, {
          version: 1,
          body: 'Revised discussion',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await comment(task, 'Original task discussion', f.mate, clientId)).json(),
    ).toMatchObject({ id, replayed: true });
    expect((await comment(task, 'Different replay', f.mate, clientId)).statusCode).toBe(409);
    expect(
      (
        await f.call(f.mate, 'PATCH', `/v1/tasks/${task}/comments/${id}`, {
          version: 1,
          body: 'Stale',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await f.call(f.owner, 'DELETE', `/v1/tasks/${task}/comments/${id}`, { version: 2 }))
        .statusCode,
    ).toBe(200);
    expect(
      (await comment(task, 'Original task discussion', f.mate, clientId)).json().replayed,
    ).toBe(true);
    for (let n = 0; n < 34; n++)
      expect((await comment(task, 'Context ' + n, f.owner)).statusCode).toBe(201);
    const latest = (
      await f.call(f.owner, 'GET', `/v1/tasks/${task}/comments?limit=30`)
    ).json<TaskComments>();
    expect(latest.items).toHaveLength(30);
    const older = (
      await f.call(f.owner, 'GET', `/v1/tasks/${task}/comments?before=${latest.next_before}`)
    ).json<TaskComments>();
    expect(older.items).toHaveLength(5);
    expect(older.items.at(-1)).toMatchObject({ id, body: '', version: 3 });
    expect(older.items.at(-1)!.deleted_at).toBeTruthy();
    expect(older.next_before).toBeNull();
    expect((await details(task)).task.comment_count).toBe(35);
  });
  it('notifies task participants and current assignees, hides deleted comments and stale assignments', async () => {
    const task = await create({ assigneeId: f.mateBoot.me.id });
    const inbox = async (session: string) =>
      (await f.call(session, 'GET', '/v1/notifications')).json<NotificationPage>();
    expect(
      (await inbox(f.mate)).items.find((n) => n.kind === 'task_assigned' && n.resource_id === task),
    ).toBeTruthy();
    const added = await comment(task, 'Please review this update', f.owner);
    expect(added.statusCode, added.body).toBe(201);
    const commentId = added.json<{ id: string }>().id;
    expect((await inbox(f.mate)).items.find((n) => n.resource_id === commentId)).toMatchObject({
      kind: 'task_comment',
      task_id: task,
      excerpt: 'Please review this update',
    });
    await f.call(f.owner, 'DELETE', `/v1/tasks/${task}/comments/${commentId}`, { version: 1 });
    expect((await inbox(f.mate)).items.find((n) => n.resource_id === commentId)).toBeUndefined();
    await f.call(f.owner, 'PATCH', `/v1/tasks/${task}`, {
      version: 1,
      title: 'Assignment should survive title edits',
    });
    expect(
      (await inbox(f.mate)).items.find((n) => n.kind === 'task_assigned' && n.resource_id === task),
    ).toBeTruthy();
    await f.call(f.owner, 'PATCH', `/v1/tasks/${task}`, {
      version: 2,
      assigneeId: f.ownerBoot.me.id,
    });
    expect(
      (await inbox(f.mate)).items.find((n) => n.kind === 'task_assigned' && n.resource_id === task),
    ).toBeUndefined();
    await f.call(f.owner, 'PATCH', `/v1/tasks/${task}`, {
      version: 3,
      assigneeId: f.mateBoot.me.id,
    });
    expect(
      (await inbox(f.mate)).items.filter(
        (n) => n.kind === 'task_assigned' && n.resource_id === task,
      ),
    ).toHaveLength(1);
  });
});
describe('task audience and tenant boundaries', () => {
  it('inherits private audiences, rejects cross-audience links and inaccessible assignees', async () => {
    const conversation = await f.channel('private'),
      parent = await create({ conversationId: conversation }),
      child = await create({ parentId: parent }),
      publicTask = await create();
    expect((await details(child)).task.conversation_id).toBe(conversation);
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/tasks', {
          title: 'Private invalid assignee',
          conversationId: conversation,
          assigneeId: f.mateBoot.me.id,
        })
      ).statusCode,
    ).toBe(400);
    expect((await link(publicTask, parent)).json().error.code).toBe('TASK_SCOPE_MISMATCH');
    for (const session of [f.mate, f.other])
      for (const suffix of ['', '/comments', '/relations?kind=subtasks', '/history'])
        expect((await f.call(session, 'GET', `/v1/tasks/${parent}${suffix}`)).statusCode).toBe(404);
    expect((await comment(parent, 'Not visible', f.mate)).statusCode).toBe(404);
    expect(
      (
        await f.call(
          f.mate,
          'GET',
          '/v1/tasks/list?' + new URLSearchParams({ conversationId: conversation }),
        )
      ).json<TaskPage>().items,
    ).toEqual([]);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/tasks/${child}`, { version: 1, parentId: publicTask })
      ).json().error.code,
    ).toBe('TASK_SCOPE_MISMATCH');
  });
  it('hides task history, comments and notifications immediately after private group removal', async () => {
    const group = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Task privacy',
      membershipIds: [f.mateBoot.me.id],
    });
    const conversation = group.json<{ id: string }>().id;
    const task = await create({ conversationId: conversation, assigneeId: f.mateBoot.me.id });
    await comment(task, 'Private comment', f.owner);
    expect((await details(task, f.mate)).can_manage).toBe(true);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/conversations/${conversation}`, {
          version: 1,
          member: { membershipId: f.mateBoot.me.id, action: 'remove' },
        })
      ).statusCode,
    ).toBe(200);
    for (const suffix of ['', '/comments', '/relations?kind=dependencies', '/history'])
      expect((await f.call(f.mate, 'GET', `/v1/tasks/${task}${suffix}`)).statusCode).toBe(404);
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/tasks/${task}`, { version: 1, title: 'Revoked edit' }))
        .statusCode,
    ).toBe(404);
    const inbox = (await f.call(f.mate, 'GET', '/v1/notifications')).json<NotificationPage>();
    expect(inbox.items.filter((n) => n.task_id === task)).toEqual([]);
  });
  it('enforces forced RLS, composite references and graph consistency below the API', async () => {
    const parent = await create(),
      child = await create({ parentId: parent });
    await comment(parent, 'Tenant protected');
    expect((await link(child, await create())).statusCode).toBe(200);
    const scoped = scopedDatabase(f.db);
    for (const table of ['task_comments', 'task_dependencies']) {
      expect(
        await tenantScope(f.otherBoot.workspace.id, () =>
          scoped.query(`SELECT * FROM ${table} WHERE workspace_id=$1`, [f.ownerBoot.workspace.id]),
        ),
      ).toEqual([]);
    }
    await expect(
      tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query(
          'INSERT INTO task_dependencies(workspace_id,task_id,depends_on_id,created_by) VALUES($1,$2,$3,$4)',
          [f.otherBoot.workspace.id, parent, child, f.otherBoot.me.id],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      f.db.query('UPDATE tasks SET parent_id=$2,version=version+1 WHERE id=$1', [parent, child]),
    ).rejects.toThrow();
    await expect(
      f.db.query('UPDATE tasks SET conversation_id=$2,version=version+1 WHERE id=$1', [
        parent,
        f.ownerBoot.channels[0]!.id,
      ]),
    ).rejects.toThrow();
    await expect(
      f.db.query('UPDATE task_comments SET author_id=$2,version=version+1 WHERE task_id=$1', [
        parent,
        f.ownerBoot.me.id,
      ]),
    ).rejects.toThrow();
  });
});

describe('task write recovery and audit integrity', () => {
  it('deduplicates concurrent creation and comment delivery without advancing counters twice', async () => {
    const input = { title: 'Concurrent create request', clientId: randomUUID() };
    const results = await Promise.all([
      f.call(f.owner, 'POST', '/v1/tasks', input),
      f.call(f.owner, 'POST', '/v1/tasks', input),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    const id = results[0]!.json<{ id: string }>().id;
    expect(results[1]!.json().id).toBe(id);
    const clientId = randomUUID();
    const comments = await Promise.all([
      comment(id, 'Concurrent delivery', f.mate, clientId),
      comment(id, 'Concurrent delivery', f.mate, clientId),
    ]);
    expect(comments.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(comments[0]!.json().id).toBe(comments[1]!.json().id);
    const rows = (await f.call(f.owner, 'GET', `/v1/tasks/${id}/comments`)).json<TaskComments>();
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]!.sequence).toBe(1);
    expect((await details(id)).task.version).toBe(1);
  });
  it('allows an owner to maintain tasks with a departed assignee and protects transition/comment retention in SQL', async () => {
    const group = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Departed assignee',
      membershipIds: [f.mateBoot.me.id],
    });
    const conversation = group.json<{ id: string }>().id;
    const id = await create({ conversationId: conversation, assigneeId: f.mateBoot.me.id });
    await comment(id, 'Retained source comment', f.owner);
    await f.call(f.owner, 'PATCH', `/v1/conversations/${conversation}`, {
      version: 1,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    const changed = await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, {
      version: 1,
      dueDate: '2027-01-01',
      assigneeId: f.mateBoot.me.id,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await move(id, 'queued')).statusCode).toBe(200);
    const scoped = scopedDatabase(f.db);
    await expect(
      tenantScope(f.ownerBoot.workspace.id, () =>
        scoped.query('DELETE FROM task_comments WHERE workspace_id=$1 AND task_id=$2', [
          f.ownerBoot.workspace.id,
          id,
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      tenantScope(f.ownerBoot.workspace.id, () =>
        scoped.query(
          'UPDATE task_transitions SET evidence=$3 WHERE workspace_id=$1 AND task_id=$2',
          [f.ownerBoot.workspace.id, id, 'Tampered evidence'],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      f.db.query('UPDATE task_transitions SET evidence=$2 WHERE task_id=$1', [
        id,
        'Owner SQL tampering',
      ]),
    ).rejects.toThrow();
    expect(
      (await f.call(f.owner, 'GET', `/v1/tasks/${id}/comments`)).json<TaskComments>().items[0]!
        .body,
    ).toBe('Retained source comment');
  });
});
