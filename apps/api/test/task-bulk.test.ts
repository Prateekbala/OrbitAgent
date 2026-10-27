import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scopedDatabase, tenantScope } from '@ao/database';
import type { TaskDetails, TaskBulkResult, TaskBulkPreviewResult } from '@ao/contracts';
import { messagingFixture } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
});
afterAll(async () => {
  await f?.close();
});
async function create(input: Record<string, unknown> = {}) {
  const r = await f.call(f.owner, 'POST', '/v1/tasks', { title: 'Bulk work', ...input });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string }>().id;
}
async function task(id: string) {
  return (await f.call(f.owner, 'GET', `/v1/tasks/${id}`)).json<TaskDetails>().task;
}
async function targets(ids: string[]) {
  return Promise.all(ids.map(async (id) => ({ id, version: (await task(id)).version })));
}
async function move(id: string, state: string) {
  const r = await f.call(f.owner, 'POST', `/v1/tasks/${id}/transitions`, {
    state,
    version: (await task(id)).version,
  });
  expect(r.statusCode, r.body).toBe(200);
}
const bulk = (body: unknown, session = f.owner) => f.call(session, 'POST', '/v1/tasks/bulk', body);
describe('atomic task actions', () => {
  it('updates assignment, priority and due dates, and skips unchanged metadata', async () => {
    const a = await create(),
      b = await create();
    const input = {
      action: 'update',
      clientId: randomUUID(),
      targets: await targets([a, b]),
      patch: { assigneeId: f.mateBoot.me.id, priority: 'high', dueDate: '2035-11-20' },
    };
    const r = await bulk(input);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<TaskBulkResult>().items).toHaveLength(2);
    for (const id of [a, b])
      expect(await task(id)).toMatchObject({
        assignee_id: f.mateBoot.me.id,
        priority: 'high',
        due_date: '2035-11-20',
        version: 2,
      });
    const unchanged = await bulk({
      ...input,
      clientId: randomUUID(),
      targets: await targets([a, b]),
    });
    expect(unchanged.statusCode).toBe(200);
    expect((await task(a)).version).toBe(2);
    expect(
      (
        await bulk({
          action: 'update',
          clientId: randomUUID(),
          targets: await targets([a, b]),
          patch: { assigneeId: null, dueDate: null },
        })
      ).statusCode,
    ).toBe(200);
    expect(await task(b)).toMatchObject({ assignee_id: null, due_date: null, version: 3 });
  });
  it('deduplicates concurrent retries and retains delivery identity after later task edits', async () => {
    const id = await create(),
      input = {
        action: 'update',
        clientId: randomUUID(),
        targets: await targets([id]),
        patch: { priority: 'high' },
      };
    const responses = await Promise.all([bulk(input), bulk(input)]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(responses.map((r) => r.json<TaskBulkResult>().replayed).sort()).toEqual([false, true]);
    expect((await task(id)).version).toBe(2);
    await f.call(f.owner, 'PATCH', `/v1/tasks/${id}`, { version: 2, title: 'A later edit' });
    expect((await bulk(input)).json<TaskBulkResult>()).toMatchObject({
      replayed: true,
      items: [{ id, version: 2 }],
    });
    expect((await task(id)).title).toBe('A later edit');
    expect((await bulk({ ...input, patch: { priority: 'low' } })).statusCode).toBe(409);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM audit_events WHERE resource_id=$1 AND action='task.updated'",
          [id],
        )
      )[0]?.n,
    ).toBe(2);
  });
  it('rejects stale versions, invalid transitions and forbidden assignments without partial writes', async () => {
    const a = await create(),
      b = await create(),
      original = await targets([a, b]);
    await f.call(f.owner, 'PATCH', `/v1/tasks/${b}`, { version: 1, title: 'Concurrent edit' });
    const input = {
      action: 'update',
      clientId: randomUUID(),
      targets: original,
      patch: { priority: 'high' },
    };
    expect((await bulk(input)).json().error.code).toBe('VERSION_CONFLICT');
    expect((await task(a)).version).toBe(1);
    expect((await task(a)).priority).toBe('normal');
    const invalid = await bulk({
      action: 'transition',
      clientId: randomUUID(),
      targets: await targets([a, b]),
      state: 'completed',
    });
    expect(invalid.statusCode).toBe(409);
    expect((await task(a)).state).toBe('proposed');
    expect(
      (
        await bulk({
          ...input,
          clientId: randomUUID(),
          targets: await targets([a, b]),
          patch: { assigneeId: f.otherBoot.me.id },
        })
      ).statusCode,
    ).toBe(400);
    expect((await task(a)).assignee_id).toBeNull();
    expect(
      await f.db.query('SELECT * FROM task_bulk_requests WHERE client_id=$1', [input.clientId]),
    ).toEqual([]);
  });
  it('checks dependency gates against the final batch and preserves per-task human evidence', async () => {
    const parent = await create(),
      child = await create({ parentId: parent }),
      dependent = await create();
    await f.call(f.owner, 'PUT', `/v1/tasks/${dependent}/dependencies`, {
      version: 1,
      dependsOnId: parent,
    });
    for (const id of [child, parent])
      for (const state of ['queued', 'active', 'awaiting_review']) await move(id, state);
    const selected = await targets([parent, child]);
    const missing = await bulk({
      action: 'transition',
      clientId: randomUUID(),
      targets: selected.map((t) => ({
        ...t,
        ...(t.id === parent ? { evidence: 'Parent only' } : {}),
      })),
      state: 'completed',
    });
    expect(missing.json().error.code).toBe('EVIDENCE_REQUIRED');
    expect((await task(parent)).state).toBe('awaiting_review');
    const complete = await bulk({
      action: 'transition',
      clientId: randomUUID(),
      targets: selected.map((t) => ({
        ...t,
        evidence: t.id === parent ? 'Parent review' : 'Child tests passed',
      })),
      state: 'completed',
    });
    expect(complete.statusCode, complete.body).toBe(200);
    expect((await task(parent)).state).toBe('completed');
    expect((await task(child)).state).toBe('completed');
    expect(
      (await f.call(f.owner, 'GET', `/v1/tasks/${child}/history`)).json().items[0].evidence,
    ).toBe('Child tests passed');
    expect(
      (
        await bulk({
          action: 'transition',
          clientId: randomUUID(),
          targets: await targets([dependent]),
          state: 'queued',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await bulk({
          action: 'transition',
          clientId: randomUUID(),
          targets: await targets([dependent]),
          state: 'active',
        })
      ).statusCode,
    ).toBe(200);
  });
  it('treats already-target states as no-ops and serializes overlapping batches', async () => {
    const a = await create(),
      b = await create();
    await move(a, 'queued');
    expect(
      (
        await bulk({
          action: 'transition',
          clientId: randomUUID(),
          targets: await targets([a, b]),
          state: 'queued',
        })
      ).statusCode,
    ).toBe(200);
    expect((await task(a)).version).toBe(2);
    expect((await task(b)).version).toBe(2);
    const target = await targets([a, b]);
    const responses = await Promise.all([
      bulk({
        action: 'update',
        clientId: randomUUID(),
        targets: target,
        patch: { priority: 'high' },
      }),
      bulk({
        action: 'update',
        clientId: randomUUID(),
        targets: target.reverse(),
        patch: { priority: 'low' },
      }),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await task(a)).priority).toBe((await task(b)).priority);
  });
  it('enforces access and management on previews, writes and retries, including private audiences', async () => {
    const conversation = await f.channel('private'),
      privateId = await create({ conversationId: conversation }),
      publicId = await create();
    for (const session of [f.mate, f.other]) {
      expect(
        (await f.call(session, 'POST', '/v1/tasks/bulk/preview', { ids: [publicId, privateId] }))
          .statusCode,
      ).toBeGreaterThanOrEqual(403);
      expect(
        (
          await bulk(
            {
              action: 'update',
              clientId: randomUUID(),
              targets: await targets([privateId, publicId]),
              patch: { priority: 'high' },
            },
            session,
          )
        ).statusCode,
      ).toBeGreaterThanOrEqual(403);
    }
    expect((await task(publicId)).priority).toBe('normal');
    const group = (
      await f.call(f.owner, 'POST', '/v1/conversations/groups', {
        title: 'Bulk private group',
        membershipIds: [f.mateBoot.me.id],
      })
    ).json<{ id: string }>().id;
    const id = await create({ conversationId: group, assigneeId: f.mateBoot.me.id });
    const input = {
      action: 'update',
      clientId: randomUUID(),
      targets: await targets([id]),
      patch: { priority: 'high' },
    };
    expect((await bulk(input, f.mate)).statusCode).toBe(200);
    await f.call(f.owner, 'PATCH', `/v1/conversations/${group}`, {
      version: 1,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    expect((await bulk(input, f.mate)).statusCode).toBe(404);
    const preview = (
      await f.call(f.owner, 'POST', '/v1/tasks/bulk/preview', { ids: [publicId, privateId] })
    ).json<TaskBulkPreviewResult>();
    expect(preview.items).toHaveLength(2);
  });
  it('bounds batch requests and isolates immutable retry ledgers at the database layer', async () => {
    const id = await create(),
      input = {
        action: 'update',
        clientId: randomUUID(),
        targets: await targets([id]),
        patch: { priority: 'high' },
      };
    await bulk(input);
    expect(
      (await bulk({ ...input, targets: [...input.targets, ...input.targets] })).statusCode,
    ).toBe(400);
    expect(
      (
        await bulk({
          ...input,
          targets: Array.from({ length: 51 }, () => ({ id: randomUUID(), version: 1 })),
        })
      ).statusCode,
    ).toBe(400);
    expect((await bulk({ ...input, patch: {} })).statusCode).toBe(400);
    const scoped = scopedDatabase(f.db);
    expect(
      await tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query('SELECT * FROM task_bulk_requests'),
      ),
    ).toEqual([]);
    for (const command of [
      'DELETE FROM task_bulk_requests WHERE workspace_id=$1',
      "UPDATE task_bulk_requests SET result='{}' WHERE workspace_id=$1",
    ])
      await expect(
        tenantScope(f.ownerBoot.workspace.id, () =>
          scoped.query(command, [f.ownerBoot.workspace.id]),
        ),
      ).rejects.toThrow();
  });
});
