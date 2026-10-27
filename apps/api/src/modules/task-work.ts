import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { id } from '@ao/contracts';
import {
  artifactInput,
  criterionInput,
  criterionReview,
  sourceInput,
  taskParticipantInput,
  taskRunInput,
  taskPlanInput,
  workPage,
} from '@ao/contracts/workflows';
import { authenticate } from './auth.js';
import { getTask } from '../tasks/queries.js';
import { TaskWorkService } from '../tasks/work.js';
import { hasPermission } from '../identity/authorization.js';
import { AppError } from '../lib/errors.js';
export function taskWorkRoutes(app: FastifyInstance, db: Database, runtimeConfigured = false) {
  const service = new TaskWorkService(db, runtimeConfigured);
  const taskId = (params: unknown) => id.parse((params as { id: string }).id);
  app.get('/v1/tasks/:id/work', async (req) =>
    service.details(await authenticate(db, req), taskId(req.params)),
  );
  app.put('/v1/tasks/:id/participants', async (req) =>
    service.participant(
      await authenticate(db, req),
      taskId(req.params),
      taskParticipantInput.parse(req.body),
    ),
  );
  app.post('/v1/tasks/:id/criteria', async (req) =>
    service.criterion(
      await authenticate(db, req),
      taskId(req.params),
      criterionInput.parse(req.body),
    ),
  );
  app.put('/v1/tasks/:id/criteria/:criterion', async (req) =>
    service.review(
      await authenticate(db, req),
      taskId(req.params),
      id.parse((req.params as { criterion: string }).criterion),
      criterionReview.parse(req.body),
    ),
  );
  app.post('/v1/tasks/:id/artifacts', async (req) =>
    service.artifact(
      await authenticate(db, req),
      taskId(req.params),
      artifactInput.parse(req.body),
    ),
  );
  app.post('/v1/tasks/:id/sources', async (req) =>
    service.source(await authenticate(db, req), taskId(req.params), sourceInput.parse(req.body)),
  );
  app.post('/v1/tasks/:id/runs', async (req) =>
    service.run(await authenticate(db, req), taskId(req.params), taskRunInput.parse(req.body)),
  );
  app.put('/v1/tasks/:id/plan', async (req) =>
    service.plan(await authenticate(db, req), taskId(req.params), taskPlanInput.parse(req.body)),
  );
  for (const kind of ['artifacts', 'sources', 'runs', 'verification-history'] as const)
    app.get(`/v1/tasks/:id/${kind}`, async (req) => {
      const p = await authenticate(db, req),
        task = taskId(req.params),
        q = workPage.parse(req.query);
      await getTask(db, p, task);
      if (
        (kind === 'runs' && !hasPermission(p, 'execution.read')) ||
        (kind === 'sources' && !hasPermission(p, 'messages.read'))
      )
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'Reading this task context requires its source capability.',
        );
      const select =
        kind === 'artifacts'
          ? [
              'a.id,a.kind,a.title,a.url,a.file_id,a.details,a.outcome,a.created_at,m.name creator_name',
              'task_artifacts a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.created_by',
              'a.id',
            ]
          : kind === 'sources'
            ? [
                'a.id,a.message_id,a.kind,msg.body,msg.conversation_id,a.workspace_id',
                'task_sources a JOIN messages msg ON msg.workspace_id=a.workspace_id AND msg.id=a.message_id AND msg.deleted_at IS NULL',
                'a.id',
              ]
            : kind === 'runs'
              ? [
                  'a.run_id id,r.status,r.prompt,r.created_at,r.updated_at,r.error_code,r.verification_status,(SELECT summary FROM run_traces tr WHERE tr.workspace_id=r.workspace_id AND tr.run_id=r.id ORDER BY tr.id DESC LIMIT 1) progress_summary,m.name agent_name',
                  'task_runs a JOIN agent_runs r ON r.workspace_id=a.workspace_id AND r.id=a.run_id JOIN agents ag ON ag.workspace_id=r.workspace_id AND ag.id=r.agent_id JOIN memberships m ON m.workspace_id=ag.workspace_id AND m.id=ag.membership_id',
                  'a.run_id',
                ]
              : [
                  'a.id,a.criterion_id,a.accepted,a.evidence,a.artifact_id,a.task_version,a.created_at,m.name reviewer_name',
                  'task_criterion_reviews a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.reviewed_by',
                  'a.id',
                ];
      const rows = await db.query(
        `SELECT ${select[0]} FROM ${select[1]} WHERE a.workspace_id=$1 AND a.task_id=$2 AND ($3::uuid IS NULL OR ${select[2]}>$3) ORDER BY ${select[2]} LIMIT $4`,
        [p.workspaceId, task, q.after ?? null, q.limit + 1],
      );
      const items = rows.slice(0, q.limit);
      return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
    });
}
