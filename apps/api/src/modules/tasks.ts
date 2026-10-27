import { TaskBulkService } from '../tasks/bulk.js';
import { taskBulkInput, taskBulkPreview } from '@ao/contracts';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import {
  id,
  taskInput,
  taskUpdate,
  taskTransition,
  taskDependency,
  taskVersion,
  taskListQuery,
  taskRelationQuery,
  taskPageQuery,
  taskCommentInput,
  taskCommentEdit,
} from '@ao/contracts';
import { authenticate } from './auth.js';
import { TaskService } from '../tasks/service.js';
import { TaskCommentService } from '../tasks/comments.js';
import { getTask, taskColumns, taskFrom, taskAccess } from '../tasks/queries.js';
import { PageCursors } from '../lib/page-cursors.js';
const position = z.object({
  id: z.uuid(),
  key: z.number().int().min(0).max(2147483647),
  time: z.iso.datetime(),
});
export function taskRoutes(
  app: FastifyInstance,
  db: Database,
  secret = randomBytes(32).toString('base64'),
) {
  const service = new TaskService(db),
    comments = new TaskCommentService(db),
    cursors = new PageCursors(secret, 'tasks');
  const bulk = new TaskBulkService(db);
  app.post('/v1/tasks/bulk/preview', async (req) =>
    bulk.preview(await authenticate(db, req), taskBulkPreview.parse(req.body).ids),
  );
  app.post('/v1/tasks/bulk', async (req) =>
    bulk.execute(await authenticate(db, req), taskBulkInput.parse(req.body)),
  );
  app.get('/v1/tasks', async (req) => {
    const p = await authenticate(db, req);
    return db.query(
      `SELECT ${taskColumns} ${taskFrom} WHERE ${taskAccess} ORDER BY t.created_at DESC,t.id DESC LIMIT 200`,
      [p.workspaceId, p.membershipId],
    );
  });
  app.get('/v1/tasks/list', async (req) => {
    const p = await authenticate(db, req),
      input = taskListQuery.parse(req.query),
      { cursor, ...filters } = input,
      binding = JSON.stringify(filters);
    const after = cursor ? position.parse(cursors.decode(cursor, p, binding)) : null;
    const key =
      input.sort === 'due'
        ? "COALESCE(t.due_date-date '0001-01-01',2147483647)"
        : input.sort === 'priority'
          ? "CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END"
          : '0';
    const rows = await db.query(
      `WITH filtered AS(SELECT ${taskColumns},${key} sort_key,to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') position_time ${taskFrom} WHERE ${taskAccess}
   AND ($3='' OR strpos(lower(t.title || ' ' || t.description),lower($3))>0)
   AND ($4::text IS NULL OR t.state=$4) AND ($5::uuid IS NULL OR t.assignee_id=$5) AND (NOT $6::boolean OR t.assignee_id IS NULL)
   AND ($7::uuid IS NULL OR t.conversation_id=$7) AND ($8::uuid IS NULL OR t.parent_id=$8)
   AND (NOT $9::boolean OR t.parent_id IS NULL) AND (NOT $10::boolean OR (t.due_date<COALESCE($11::date,(now() AT TIME ZONE 'UTC')::date) AND t.state NOT IN ('completed','cancelled')))
   AND (NOT $12::boolean OR t.conversation_id IS NULL)
   AND ($17::date IS NULL OR t.due_date >= $17) AND ($18::date IS NULL OR t.due_date <= $18)
   AND ($19::uuid IS NULL OR t.project_id=$19) AND ($20::uuid IS NULL OR t.milestone_id=$20)
   AND ($21::uuid IS NULL OR EXISTS(SELECT 1 FROM task_label_links link WHERE link.workspace_id=t.workspace_id AND link.task_id=t.id AND link.label_id=$21))
   AND (NOT $22::boolean OR t.project_id IS NULL))
   SELECT * FROM filtered WHERE $13::uuid IS NULL OR sort_key>$14 OR (sort_key=$14 AND (created_at,id)<($15::timestamptz,$13::uuid)) ORDER BY sort_key ASC,created_at DESC,id DESC LIMIT $16`,
      [
        p.workspaceId,
        p.membershipId,
        input.q,
        input.state ?? null,
        input.assigneeId ?? null,
        input.unassigned === 'true',
        input.conversationId ?? null,
        input.parentId ?? null,
        input.roots === 'true',
        input.overdue === 'true',
        input.asOf ?? null,
        input.workspaceOnly === 'true',
        after?.id ?? null,
        after?.key ?? null,
        after?.time ?? null,
        input.limit + 1,
        input.dueFrom ?? null,
        input.dueThrough ?? null,
        input.projectId ?? null,
        input.milestoneId ?? null,
        input.labelId ?? null,
        input.noProject === 'true',
      ],
    );
    const items = rows.slice(0, input.limit),
      last = items.at(-1);
    return {
      items: items.map(({ sort_key: _key, position_time: _time, ...task }) => task),
      next_cursor:
        rows.length > input.limit && last
          ? cursors.encode(
              { id: last.id, key: last.sort_key, time: last.position_time },
              p,
              binding,
            )
          : null,
    };
  });
  app.post('/v1/tasks', async (req, reply) => {
    const result = await service.create(await authenticate(db, req), taskInput.parse(req.body));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.get('/v1/tasks/:id', async (req) =>
    service.details(await authenticate(db, req), id.parse((req.params as { id: string }).id)),
  );
  app.patch('/v1/tasks/:id', async (req) =>
    service.update(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      taskUpdate.parse(req.body),
    ),
  );
  app.post('/v1/tasks/:id/transitions', async (req) =>
    service.transition(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      taskTransition.parse(req.body),
    ),
  );
  app.get('/v1/tasks/:id/relations', async (req) => {
    const p = await authenticate(db, req),
      taskId = id.parse((req.params as { id: string }).id),
      q = taskRelationQuery.parse(req.query);
    await getTask(db, p, taskId);
    const relation =
      q.kind === 'subtasks'
        ? 't.parent_id=$3'
        : q.kind === 'dependencies'
          ? 'EXISTS(SELECT 1 FROM task_dependencies d WHERE d.workspace_id=t.workspace_id AND d.task_id=$3 AND d.depends_on_id=t.id)'
          : 'EXISTS(SELECT 1 FROM task_dependencies d WHERE d.workspace_id=t.workspace_id AND d.depends_on_id=$3 AND d.task_id=t.id)';
    const rows = await db.query(
      `SELECT ${taskColumns} ${taskFrom} WHERE ${taskAccess} AND ${relation} AND ($4::uuid IS NULL OR t.id>$4) ORDER BY t.id LIMIT $5`,
      [p.workspaceId, p.membershipId, taskId, q.after ?? null, q.limit + 1],
    );
    const items = rows.slice(0, q.limit);
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.put('/v1/tasks/:id/dependencies', async (req) => {
    const p = await authenticate(db, req),
      input = taskDependency.parse(req.body);
    return service.dependency(
      p,
      id.parse((req.params as { id: string }).id),
      input.dependsOnId,
      input.version,
    );
  });
  app.delete('/v1/tasks/:id/dependencies/:target', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id, target: id }).parse(req.params);
    return service.dependency(
      p,
      params.id,
      params.target,
      taskVersion.parse(req.body).version,
      true,
    );
  });
  app.get('/v1/tasks/:id/comments', async (req) => {
    const p = await authenticate(db, req),
      taskId = id.parse((req.params as { id: string }).id),
      q = taskPageQuery.parse(req.query);
    await getTask(db, p, taskId);
    const rows = await db.query(
      `SELECT comment.id,comment.task_id,comment.author_id,author.name author_name,author.kind author_kind,comment.body,comment.sequence,comment.version,comment.created_at,comment.edited_at,comment.deleted_at FROM task_comments comment JOIN tasks t ON t.workspace_id=comment.workspace_id AND t.id=comment.task_id JOIN memberships author ON author.workspace_id=comment.workspace_id AND author.id=comment.author_id WHERE ${taskAccess} AND comment.task_id=$3 AND ($4::integer IS NULL OR comment.sequence<$4) ORDER BY comment.sequence DESC LIMIT $5`,
      [p.workspaceId, p.membershipId, taskId, q.before ?? null, q.limit + 1],
    );
    const items = rows.slice(0, q.limit);
    return { items, next_before: rows.length > q.limit ? items.at(-1)!.sequence : null };
  });
  app.post('/v1/tasks/:id/comments', async (req, reply) => {
    const result = await comments.create(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      taskCommentInput.parse(req.body),
    );
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.patch('/v1/tasks/:id/comments/:comment', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id, comment: id }).parse(req.params),
      input = taskCommentEdit.parse(req.body);
    return comments.change(p, params.id, params.comment, input.version, input.body);
  });
  app.delete('/v1/tasks/:id/comments/:comment', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id, comment: id }).parse(req.params);
    return comments.change(p, params.id, params.comment, taskVersion.parse(req.body).version, null);
  });
  app.get('/v1/tasks/:id/history', async (req) => {
    const p = await authenticate(db, req),
      taskId = id.parse((req.params as { id: string }).id),
      q = taskPageQuery.parse(req.query);
    await getTask(db, p, taskId);
    const rows = await db.query(
      `SELECT h.id,actor.name actor_name,h.from_state,h.to_state,h.evidence,h.created_at,h.task_version sequence FROM task_transitions h JOIN tasks t ON t.workspace_id=h.workspace_id AND t.id=h.task_id JOIN memberships actor ON actor.workspace_id=h.workspace_id AND actor.id=h.actor_id WHERE ${taskAccess} AND h.task_id=$3 AND ($4::integer IS NULL OR h.task_version<$4) ORDER BY h.task_version DESC LIMIT $5`,
      [p.workspaceId, p.membershipId, taskId, q.before ?? null, q.limit + 1],
    );
    const items = rows.slice(0, q.limit);
    return { items, next_before: rows.length > q.limit ? items.at(-1)!.sequence : null };
  });
}
