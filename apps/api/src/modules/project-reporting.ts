import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database, Sql } from '@ao/database';
import { z } from 'zod';
import { id } from '@ao/contracts';
import {
  portfolioInput,
  portfolioUpdate,
  workPage,
  businessCalendarInput,
} from '@ao/contracts/workflows';
import { authenticate } from './auth.js';
import { getProject } from '../projects/queries.js';
import { taskActor } from '../tasks/service.js';
import { workVersion } from '../tasks/work.js';
import { workManager } from '../workflows/service.js';
import { requireConversation } from '../lib/policy.js';
import type { Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { digest } from '../lib/security.js';
import { hasPermission } from '../identity/authorization.js';
const windowQuery = z
  .object({
    from: z.iso.date(),
    through: z.iso.date(),
    after: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (v) =>
      v.from >= '0001-01-01' &&
      v.through <= '9999-12-31' &&
      v.from <= v.through &&
      new Date(v.through).getTime() - new Date(v.from).getTime() <= 366 * 86400000,
    'Choose at most 367 calendar dates.',
  );
async function portfolio(tx: Sql, p: Identity, id: string) {
  const [row] = await tx.query('SELECT * FROM portfolios WHERE workspace_id=$1 AND id=$2', [
    p.workspaceId,
    id,
  ]);
  if (!row) throw notFound();
  return row;
}
async function placements(tx: Sql, p: Identity, scope: unknown, projects: string[]) {
  for (const id of [...projects].sort()) {
    const project = await getProject(tx, p, id, true);
    if (project.conversation_id !== scope)
      throw new AppError(
        400,
        'PORTFOLIO_SCOPE_MISMATCH',
        'Every project must share the portfolio’s audience.',
      );
  }
}
export function projectReportingRoutes(app: FastifyInstance, db: Database) {
  const reportingPrincipal = async (req: import('fastify').FastifyRequest) => {
    const p = await authenticate(db, req);
    if (!hasPermission(p, 'tasks.read'))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Task access is required for project reporting.',
      );
    return p;
  };
  app.get('/v1/projects/:id/report', async (req) => {
    const p = await reportingPrincipal(req),
      project = await getProject(db, p, id.parse((req.params as { id: string }).id));
    const [states, assignees, velocity, totals] = await Promise.all([
      db.query(
        'SELECT state,count(*)::int count,coalesce(sum(estimate),0)::float8 estimate FROM tasks WHERE workspace_id=$1 AND project_id=$2 GROUP BY state ORDER BY state',
        [p.workspaceId, project.id],
      ),
      db.query(
        "SELECT coalesce(m.name,'Unassigned') name,count(*)::int count,count(*) FILTER(WHERE t.due_date<(now() AT TIME ZONE 'UTC')::date AND t.state NOT IN ('completed','cancelled'))::int overdue,coalesce(sum(t.estimate),0)::float8 estimate FROM tasks t LEFT JOIN memberships m ON m.workspace_id=t.workspace_id AND m.id=t.assignee_id WHERE t.workspace_id=$1 AND t.project_id=$2 GROUP BY t.assignee_id,m.name ORDER BY count(*) DESC,t.assignee_id LIMIT 100",
        [p.workspaceId, project.id],
      ),
      db.query(
        "SELECT to_char(date_trunc('week',h.created_at AT TIME ZONE 'UTC'),'YYYY-MM-DD') week,count(*)::int completed FROM task_transitions h JOIN tasks t ON t.workspace_id=h.workspace_id AND t.id=h.task_id WHERE t.workspace_id=$1 AND t.project_id=$2 AND h.to_state='completed' AND h.created_at>now()-interval '12 weeks' GROUP BY 1 ORDER BY 1",
        [p.workspaceId, project.id],
      ),
      db.query(
        "SELECT count(*)::int tasks,count(*) FILTER(WHERE state='completed')::int completed,count(*) FILTER(WHERE due_date<(now() AT TIME ZONE 'UTC')::date AND state NOT IN ('completed','cancelled'))::int overdue,count(*) FILTER(WHERE state='blocked')::int blocked,coalesce(sum(estimate),0)::float8 estimated,coalesce(sum(estimate) FILTER(WHERE state='completed'),0)::float8 completed_estimate FROM tasks WHERE workspace_id=$1 AND project_id=$2",
        [p.workspaceId, project.id],
      ),
    ]);
    return {
      project: { id: project.id, name: project.name },
      states,
      assignees,
      velocity,
      totals: totals[0],
    };
  });
  app.get('/v1/projects/:id/timeline', async (req) => {
    const p = await reportingPrincipal(req),
      project = await getProject(db, p, id.parse((req.params as { id: string }).id)),
      q = windowQuery.parse(req.query);
    const rows = await db.query(
        "SELECT t.id,t.title,t.state,to_char(t.start_date,'YYYY-MM-DD') start_date,to_char(t.due_date,'YYYY-MM-DD') due_date,t.estimate::float8 estimate,m.name assignee_name,ARRAY(SELECT d.depends_on_id FROM task_dependencies d WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id) dependency_ids FROM tasks t LEFT JOIN memberships m ON m.workspace_id=t.workspace_id AND m.id=t.assignee_id WHERE t.workspace_id=$1 AND t.project_id=$2 AND (coalesce(t.start_date,t.due_date) IS NULL OR (coalesce(t.start_date,t.due_date)<=$4::date AND coalesce(t.due_date,t.start_date)>=$3::date)) AND ($5::uuid IS NULL OR t.id>$5) ORDER BY t.id LIMIT $6",
        [p.workspaceId, project.id, q.from, q.through, q.after ?? null, q.limit + 1],
      ),
      items = rows.slice(0, q.limit);
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.post('/v1/portfolios', async (req) => {
    let p = await authenticate(db, req);
    const input = portfolioInput.parse(req.body);
    return db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      workManager(p, p.membershipId);
      if (input.conversationId) await requireConversation(tx, p, input.conversationId, true);
      const hash = digest(JSON.stringify(input)),
        [old] = await tx.query(
          'SELECT id,request_hash FROM portfolios WHERE workspace_id=$1 AND created_by=$2 AND client_id=$3',
          [p.workspaceId, p.membershipId, input.clientId],
        );
      if (old) {
        if (old.request_hash !== hash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This portfolio key was already used.');
        return { id: old.id };
      }
      await placements(tx, p, input.conversationId ?? null, input.projectIds);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO portfolios(id,workspace_id,conversation_id,name,created_by,client_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          p.workspaceId,
          input.conversationId ?? null,
          input.name,
          p.membershipId,
          input.clientId,
          hash,
        ],
      );
      for (const project of input.projectIds)
        await tx.query(
          'INSERT INTO portfolio_projects(workspace_id,portfolio_id,project_id) VALUES($1,$2,$3)',
          [p.workspaceId, id, project],
        );
      await recordChange(tx, p, 'portfolio.created', id, input.conversationId ?? null);
      return { id };
    });
  });
  app.put('/v1/portfolios/:id', async (req) => {
    let p = await authenticate(db, req);
    const value = portfolioUpdate.parse(req.body),
      key = id.parse((req.params as { id: string }).id);
    return db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const row = await portfolio(tx, p, key);
      workManager(p, row.created_by);
      workVersion(Number(row.version), value.version);
      await placements(tx, p, row.conversation_id, value.projectIds);
      await tx.query(
        'UPDATE portfolios SET name=$3,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, key, value.name],
      );
      await tx.query('DELETE FROM portfolio_projects WHERE workspace_id=$1 AND portfolio_id=$2', [
        p.workspaceId,
        key,
      ]);
      for (const project of value.projectIds)
        await tx.query(
          'INSERT INTO portfolio_projects(workspace_id,portfolio_id,project_id) VALUES($1,$2,$3)',
          [p.workspaceId, key, project],
        );
      await recordChange(tx, p, 'portfolio.updated', key, row.conversation_id as string | null);
      return { ok: true };
    });
  });
  app.get('/v1/portfolios', async (req) => {
    const p = await authenticate(db, req),
      q = workPage.parse(req.query),
      rows = await db.query(
        'SELECT p.*, (SELECT count(*)::int FROM portfolio_projects link WHERE link.workspace_id=p.workspace_id AND link.portfolio_id=p.id) project_count FROM portfolios p WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
        [p.workspaceId, q.after ?? null, q.limit + 1],
      ),
      items = rows.slice(0, q.limit);
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.get('/v1/portfolios/:id/report', async (req) => {
    const p = await reportingPrincipal(req),
      row = await portfolio(db, p, id.parse((req.params as { id: string }).id)),
      q = workPage.parse(req.query);
    const rows = await db.query(
        "SELECT p.id,p.name,p.status,to_char(p.start_date,'YYYY-MM-DD') start_date,to_char(p.target_date,'YYYY-MM-DD') target_date,count(t.id)::int tasks,count(t.id) FILTER(WHERE t.state='completed')::int completed,count(t.id) FILTER(WHERE t.state='blocked')::int blocked,count(t.id) FILTER(WHERE t.due_date<(now() AT TIME ZONE 'UTC')::date AND t.state NOT IN ('completed','cancelled'))::int overdue,coalesce(sum(t.estimate),0)::float8 estimate FROM portfolio_projects link JOIN projects p ON p.workspace_id=link.workspace_id AND p.id=link.project_id LEFT JOIN tasks t ON t.workspace_id=p.workspace_id AND t.project_id=p.id WHERE link.workspace_id=$1 AND link.portfolio_id=$2 AND ($3::uuid IS NULL OR p.id>$3) GROUP BY p.id ORDER BY p.id LIMIT $4",
        [p.workspaceId, row.id, q.after ?? null, q.limit + 1],
      ),
      items = rows.slice(0, q.limit);
    const [totals] = await db.query(
      "SELECT count(DISTINCT p.id)::int projects,count(t.id)::int tasks,count(t.id) FILTER(WHERE t.state='completed')::int completed,count(t.id) FILTER(WHERE t.state='blocked')::int blocked,count(t.id) FILTER(WHERE t.due_date<(now() AT TIME ZONE 'UTC')::date AND t.state NOT IN ('completed','cancelled'))::int overdue,coalesce(sum(t.estimate),0)::float8 estimate FROM portfolio_projects link JOIN projects p ON p.workspace_id=link.workspace_id AND p.id=link.project_id LEFT JOIN tasks t ON t.workspace_id=p.workspace_id AND t.project_id=p.id WHERE link.workspace_id=$1 AND link.portfolio_id=$2",
      [p.workspaceId, row.id],
    );
    const projectIds = await db.query(
      'SELECT project_id FROM portfolio_projects WHERE workspace_id=$1 AND portfolio_id=$2 ORDER BY project_id',
      [p.workspaceId, row.id],
    );
    return {
      project_ids: projectIds.map((project) => project.project_id),
      portfolio: row,
      totals,
      items,
      next_after: rows.length > q.limit ? items.at(-1)!.id : null,
    };
  });
  app.get('/v1/business-calendars', async (req) => {
    const p = await authenticate(db, req),
      q = workPage.parse(req.query),
      rows = await db.query(
        'SELECT * FROM business_calendars WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
        [p.workspaceId, q.after ?? null, q.limit + 1],
      ),
      items = rows.slice(0, q.limit);
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.put('/v1/business-calendars/:id', async (req) => {
    let p = await authenticate(db, req);
    const value = businessCalendarInput.parse(req.body),
      key = id.parse((req.params as { id: string }).id);
    return db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      if (!['owner', 'admin'].includes(p.role) || p.kind !== 'human')
        throw new AppError(
          403,
          'FORBIDDEN',
          'A human administrator must configure business calendars.',
        );
      const [old] = await tx.query(
        'SELECT version FROM business_calendars WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [p.workspaceId, key],
      );
      workVersion(Number(old?.version ?? 0), value.version);
      await tx.query(
        'INSERT INTO business_calendars(id,workspace_id,name,time_zone,weekdays,holidays,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,time_zone=EXCLUDED.time_zone,weekdays=EXCLUDED.weekdays,holidays=EXCLUDED.holidays,version=business_calendars.version+1',
        [
          key,
          p.workspaceId,
          value.name,
          value.timeZone,
          value.weekdays,
          value.holidays,
          p.membershipId,
        ],
      );
      await recordChange(tx, p, 'business_calendar.updated', key);
      return { id: key };
    });
  });
}
