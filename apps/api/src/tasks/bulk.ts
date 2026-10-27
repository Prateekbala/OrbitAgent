import type { z } from 'zod';
import type { Database } from '@ao/database';
import type { taskBulkInput } from '@ao/contracts';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { taskActor, manageTask, updateTask, transitionTask } from './service.js';
import { getTask } from './queries.js';
export class TaskBulkService {
  constructor(private readonly db: Database) {}
  async preview(p: Identity, ids: string[]) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const items = [];
      for (const id of [...ids].sort()) {
        const task = await getTask(tx, p, id, true);
        manageTask(p, task);
        items.push(task);
      }
      return { items };
    });
  }
  async execute(p: Identity, input: z.infer<typeof taskBulkInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const targets = [...input.targets].sort((a, b) => a.id.localeCompare(b.id));
      const byId = new Map(targets.map((target) => [target.id, target]));
      const tasks = [];
      for (const target of targets) {
        const task = await getTask(tx, p, target.id, true);
        manageTask(p, task);
        tasks.push(task);
      }
      const hash = digest(JSON.stringify({ ...input, targets }));
      const [previous] = await tx.query(
        'SELECT request_hash,result FROM task_bulk_requests WHERE workspace_id=$1 AND actor_id=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (previous) {
        if (previous.request_hash !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This bulk request ID was used for different changes.',
          );
        return {
          ...(previous.result as { items: { id: string; version: number }[] }),
          replayed: true,
        };
      }
      for (const task of tasks) {
        const target = byId.get(task.id)!;
        if (task.version !== target.version)
          throw new AppError(
            409,
            'VERSION_CONFLICT',
            `“${task.title}” changed. Review the selected tasks before retrying.`,
          );
      }
      for (const task of tasks) {
        const target = byId.get(task.id)!;
        if (input.action === 'update')
          await updateTask(tx, p, task, { version: target.version, ...input.patch }, false);
        else if (task.state !== input.state)
          await transitionTask(
            tx,
            p,
            task,
            { version: target.version, state: input.state, evidence: target.evidence ?? '' },
            false,
          );
      }
      for (const task of tasks)
        await tx.query('SELECT assert_task_graph($1,$2)', [p.workspaceId, task.id]);
      const items = [];
      for (const task of tasks) {
        const current = await getTask(tx, p, task.id);
        items.push({ id: current.id, version: current.version });
      }
      await tx.query(
        'INSERT INTO task_bulk_requests(workspace_id,actor_id,client_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)',
        [p.workspaceId, p.membershipId, input.clientId, hash, JSON.stringify({ items })],
      );
      return { items, replayed: false };
    });
  }
}
