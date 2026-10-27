import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import { recurrenceInput, reminderInput, id, type TaskRecurrence } from '@ao/contracts';
import { previewDates } from '../scheduling/dates.js';
import { authenticate } from './auth.js';
import { SchedulingService, recurrenceColumns } from '../scheduling/service.js';
import { taskAccess } from '../tasks/queries.js';
export function schedulingRoutes(app: FastifyInstance, db: Database) {
  const service = new SchedulingService(db);
  app.get('/v1/task-schedules', async (req) => {
    const p = await authenticate(db, req),
      q = z
        .object({
          after: id.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          from: z.iso.date().optional(),
          through: z.iso.date().optional(),
          assigneeId: id.optional(),
          conversationId: id.optional(),
          workspaceOnly: z.enum(['true']).optional(),
          projectId: id.optional(),
          milestoneId: id.optional(),
          labelId: id.optional(),
        })
        .strict()
        .refine((v) => Boolean(v.from) === Boolean(v.through), 'Choose both date boundaries.')
        .refine(
          (v) =>
            !v.from ||
            !v.through ||
            (v.from >= '0001-01-01' &&
              v.through <= '9999-12-31' &&
              v.through >= v.from &&
              (new Date(v.through).getTime() - new Date(v.from).getTime()) / 86400000 <= 62),
          'Choose a window of at most 63 dates.',
        )
        .refine((v) => !v.conversationId || !v.workspaceOnly, 'Choose one audience.')
        .parse(req.query);
    const rows = await db.query<
      TaskRecurrence & {
        title: string;
        occurrence_index: number;
        generated_dates: string[];
      } & Record<string, unknown>
    >(
      `SELECT ${recurrenceColumns},r.occurrence_index,t.title,ARRAY(SELECT to_char(o.occurrence_date,'YYYY-MM-DD') FROM task_occurrences o WHERE o.workspace_id=r.workspace_id AND o.recurrence_id=r.id AND o.occurrence_date BETWEEN $8::date AND $9::date) generated_dates FROM task_recurrences r JOIN tasks t ON t.workspace_id=r.workspace_id AND t.id=r.task_id WHERE ${taskAccess} AND ($3::uuid IS NULL OR r.id>$3)
      AND ($5::uuid IS NULL OR t.assignee_id=$5) AND ($6::uuid IS NULL OR t.conversation_id=$6) AND (NOT $7::boolean OR t.conversation_id IS NULL)
      AND ($8::date IS NULL OR (NOT r.paused AND r.next_date IS NOT NULL AND r.next_date<=$9::date AND (r.end_date IS NULL OR r.end_date>=$8::date)))
      AND ($10::uuid IS NULL OR t.project_id=$10) AND ($11::uuid IS NULL OR t.milestone_id=$11)
      AND ($12::uuid IS NULL OR EXISTS(SELECT 1 FROM task_label_links link WHERE link.workspace_id=t.workspace_id AND link.task_id=t.id AND link.label_id=$12))
      AND ($8::date IS NULL OR (t.project_id IS NULL OR EXISTS(SELECT 1 FROM projects project WHERE project.workspace_id=t.workspace_id AND project.id=t.project_id AND project.status NOT IN ('completed','archived'))))
      AND ($8::date IS NULL OR (t.milestone_id IS NULL OR EXISTS(SELECT 1 FROM project_milestones milestone WHERE milestone.workspace_id=t.workspace_id AND milestone.id=t.milestone_id AND milestone.status NOT IN ('completed','cancelled'))))
      ORDER BY r.id LIMIT $4`,
      [
        p.workspaceId,
        p.membershipId,
        q.after ?? null,
        q.limit + 1,
        q.assigneeId ?? null,
        q.conversationId ?? null,
        q.workspaceOnly === 'true',
        q.from ?? null,
        q.through ?? null,
        q.projectId ?? null,
        q.milestoneId ?? null,
        q.labelId ?? null,
      ],
    );
    const items = rows.slice(0, q.limit).map(({ occurrence_index, generated_dates, ...r }) => ({
      ...r,
      preview_dates:
        q.from && q.through
          ? previewDates(
              {
                start: String(r.start_date),
                frequency: r.frequency as 'daily' | 'weekly' | 'monthly' | 'business_daily',
                interval: Number(r.interval),
                index: Number(occurrence_index),
                end: r.end_date as string | null,
                paused: Boolean(r.paused),
                calendar: r.business_calendar ?? null,
              },
              q.from,
              q.through,
            ).filter((date) => !generated_dates.includes(date))
          : [],
    }));
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.get('/v1/tasks/:id/scheduling', async (req) =>
    service.details(await authenticate(db, req), id.parse((req.params as { id: string }).id)),
  );
  app.put('/v1/tasks/:id/recurrence', async (req) =>
    service.recurrence(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      recurrenceInput.parse(req.body),
    ),
  );
  app.put('/v1/tasks/:id/reminder', async (req) =>
    service.reminder(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      reminderInput.parse(req.body),
    ),
  );
}
