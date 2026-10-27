import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import {
  id,
  projectInput,
  projectUpdate,
  projectQuery,
  milestoneInput,
  milestoneUpdate,
  labelInput,
  labelUpdate,
  labelQuery,
  organizationPageQuery,
} from '@ao/contracts';
import { authenticate } from './auth.js';
import { ProjectService, LabelService } from '../projects/service.js';
import {
  getProject,
  projectAccess,
  projectColumns,
  projectFrom,
  milestoneColumns,
} from '../projects/queries.js';
export function projectRoutes(app: FastifyInstance, db: Database) {
  const projects = new ProjectService(db),
    labels = new LabelService(db),
    param = (value: unknown) => id.parse((value as { id: string }).id);
  app.get('/v1/projects', async (req) => {
    const p = await authenticate(db, req),
      q = projectQuery.parse(req.query);
    const rows = await db.query(
      `SELECT ${projectColumns} ${projectFrom} WHERE ${projectAccess} AND ($3='' OR strpos(lower(p.name || ' ' || p.description),lower($3))>0) AND ($4::text IS NULL OR p.status=$4) AND ($5::uuid IS NULL OR p.conversation_id=$5) AND (NOT $6::boolean OR p.conversation_id IS NULL) AND ($7::uuid IS NULL OR p.id>$7) ORDER BY p.id LIMIT $8`,
      [
        p.workspaceId,
        p.membershipId,
        q.q,
        q.status ?? null,
        q.conversationId ?? null,
        q.workspaceOnly === 'true',
        q.after ?? null,
        q.limit + 1,
      ],
    );
    const items = rows.slice(0, q.limit);
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.post('/v1/projects', async (req, reply) => {
    const result = await projects.create(await authenticate(db, req), projectInput.parse(req.body));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.get('/v1/projects/:id', async (req) =>
    projects.details(await authenticate(db, req), param(req.params)),
  );
  app.patch('/v1/projects/:id', async (req) =>
    projects.update(await authenticate(db, req), param(req.params), projectUpdate.parse(req.body)),
  );
  app.get('/v1/projects/:id/milestones', async (req) => {
    const p = await authenticate(db, req),
      project = param(req.params),
      q = organizationPageQuery.parse(req.query);
    await getProject(db, p, project);
    const rows = await db.query(
      `SELECT ${milestoneColumns} FROM project_milestones m JOIN projects p ON p.workspace_id=m.workspace_id AND p.id=m.project_id WHERE ${projectAccess} AND m.project_id=$3 AND ($4::uuid IS NULL OR m.id>$4) ORDER BY m.id LIMIT $5`,
      [p.workspaceId, p.membershipId, project, q.after ?? null, q.limit + 1],
    );
    const items = rows.slice(0, q.limit);
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.post('/v1/projects/:id/milestones', async (req, reply) => {
    const result = await projects.createMilestone(
      await authenticate(db, req),
      param(req.params),
      milestoneInput.parse(req.body),
    );
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.patch('/v1/projects/:id/milestones/:milestone', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ id, milestone: id }).parse(req.params);
    return projects.updateMilestone(
      p,
      params.id,
      params.milestone,
      milestoneUpdate.parse(req.body),
    );
  });
  app.get('/v1/labels', async (req) => {
    const p = await authenticate(db, req),
      q = labelQuery.parse(req.query);
    const rows = await db.query(
      `SELECT id,name,color,archived,created_by,version FROM work_labels WHERE workspace_id=$1 AND ($2='' OR strpos(lower(name),lower($2))>0) AND ($3='all' OR archived=($3='true')) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`,
      [p.workspaceId, q.q, q.archived, q.after ?? null, q.limit + 1],
    );
    const items = rows.slice(0, q.limit);
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.post('/v1/labels', async (req, reply) => {
    const result = await labels.create(await authenticate(db, req), labelInput.parse(req.body));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.patch('/v1/labels/:id', async (req) =>
    labels.update(await authenticate(db, req), param(req.params), labelUpdate.parse(req.body)),
  );
}
