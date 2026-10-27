import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Database, Sql } from '@ao/database';
import type {
  projectInput,
  projectUpdate,
  milestoneInput,
  milestoneUpdate,
  labelInput,
  labelUpdate,
  Project,
} from '@ao/contracts';
import { taskActor } from '../tasks/service.js';
import { AppError, notFound } from '../lib/errors.js';
import { requireConversation, type Identity } from '../lib/policy.js';
import { recordChange } from '../lib/events.js';
import { digest } from '../lib/security.js';
import { getProject, getMilestone, managesProject } from './queries.js';
function human(p: Identity) {
  if (p.kind !== 'human')
    throw new AppError(
      403,
      'HUMAN_REQUIRED',
      'A human workspace member must manage organization settings.',
    );
}
function revision(current: number, expected: number) {
  if (current !== expected)
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'This item changed. Review its latest version before saving again.',
    );
}
function manager(p: Identity, project: Project) {
  if (!managesProject(p, project))
    throw new AppError(
      403,
      'FORBIDDEN',
      'Only the project creator, owner or a human administrator can manage this project.',
    );
}
async function owner(tx: Sql, p: Identity, id: string, conversation: string | null) {
  const [person] = await tx.query(
    "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND kind='human' FOR SHARE",
    [p.workspaceId, id],
  );
  if (!person) throw new AppError(400, 'INVALID_OWNER', 'Choose an active human owner.');
  if (conversation) await requireConversation(tx, { ...p, membershipId: id }, conversation, true);
}
export class ProjectService {
  constructor(private readonly db: Database) {}
  async details(p: Identity, id: string) {
    const project = await getProject(this.db, p, id);
    return { project, can_manage: managesProject(p, project) };
  }
  async create(p: Identity, input: z.infer<typeof projectInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      human(p);
      const hash = digest(JSON.stringify(input));
      const [previous] = await tx.query(
        'SELECT id,request_hash FROM projects WHERE workspace_id=$1 AND created_by=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (previous) {
        await getProject(tx, p, String(previous.id));
        if (previous.request_hash !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This project request ID was used for different details.',
          );
        return { id: previous.id, replayed: true };
      }
      const conversation = input.conversationId ?? null;
      if (conversation) await requireConversation(tx, p, conversation, true);
      await owner(tx, p, input.ownerId ?? p.membershipId, conversation);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO projects(id,workspace_id,conversation_id,name,description,status,owner_id,created_by,start_date,target_date,client_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          id,
          p.workspaceId,
          conversation,
          input.name,
          input.description,
          input.status,
          input.ownerId ?? p.membershipId,
          p.membershipId,
          input.startDate,
          input.targetDate,
          input.clientId,
          hash,
        ],
      );
      await recordChange(tx, p, 'project.created', id, conversation);
      return { id, replayed: false };
    });
  }
  async update(p: Identity, id: string, input: z.infer<typeof projectUpdate>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      human(p);
      const project = await getProject(tx, p, id, true);
      manager(p, project);
      revision(project.version, input.version);
      const fields = {
        name: input.name ?? project.name,
        description: input.description ?? project.description,
        status: input.status ?? project.status,
        owner_id: input.ownerId ?? project.owner_id,
        start_date: input.startDate === undefined ? project.start_date : input.startDate,
        target_date: input.targetDate === undefined ? project.target_date : input.targetDate,
      };
      if (fields.start_date && fields.target_date && fields.start_date > fields.target_date)
        throw new AppError(400, 'INVALID_DATES', 'Target date must follow the start date.');
      if (fields.owner_id !== project.owner_id)
        await owner(tx, p, fields.owner_id, project.conversation_id);
      if (Object.entries(fields).every(([key, v]) => project[key as keyof Project] === v))
        return { ok: true, replayed: true };
      await tx.query(
        'UPDATE projects SET name=$3,description=$4,status=$5,owner_id=$6,start_date=$7,target_date=$8,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [
          p.workspaceId,
          id,
          fields.name,
          fields.description,
          fields.status,
          fields.owner_id,
          fields.start_date,
          fields.target_date,
        ],
      );
      await tx.query('SELECT assert_project_completion($1,$2)', [p.workspaceId, id]);
      await recordChange(tx, p, 'project.updated', id, project.conversation_id);
      return { ok: true, replayed: false };
    });
  }
  async createMilestone(p: Identity, projectId: string, input: z.infer<typeof milestoneInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      human(p);
      const project = await getProject(tx, p, projectId, true);
      manager(p, project);
      const hash = digest(JSON.stringify({ projectId, ...input }));
      const [previous] = await tx.query(
        'SELECT id,request_hash FROM project_milestones WHERE workspace_id=$1 AND created_by=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (previous) {
        if (previous.request_hash !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This milestone request ID was used for different details.',
          );
        return { id: previous.id, replayed: true };
      }
      if (['completed', 'archived'].includes(project.status))
        throw new AppError(409, 'PROJECT_CLOSED', 'Reopen the project before adding a milestone.');
      const id = randomUUID();
      await tx.query(
        'INSERT INTO project_milestones(id,workspace_id,project_id,title,description,status,due_date,created_by,client_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          p.workspaceId,
          projectId,
          input.title,
          input.description,
          input.status,
          input.dueDate,
          p.membershipId,
          input.clientId,
          hash,
        ],
      );
      await recordChange(tx, p, 'project.milestone_created', projectId, project.conversation_id);
      return { id, replayed: false };
    });
  }
  async updateMilestone(
    p: Identity,
    projectId: string,
    id: string,
    input: z.infer<typeof milestoneUpdate>,
  ) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      human(p);
      const project = await getProject(tx, p, projectId, true);
      manager(p, project);
      const milestone = await getMilestone(tx, p.workspaceId, projectId, id, true);
      revision(milestone.version, input.version);
      const fields = {
        title: input.title ?? milestone.title,
        description: input.description ?? milestone.description,
        status: input.status ?? milestone.status,
        due_date: input.dueDate === undefined ? milestone.due_date : input.dueDate,
      };
      if (
        Object.entries(fields).every(([key, v]) => milestone[key as keyof typeof milestone] === v)
      )
        return { ok: true, replayed: true };
      await tx.query(
        'UPDATE project_milestones SET title=$4,description=$5,status=$6,due_date=$7,version=version+1 WHERE workspace_id=$1 AND project_id=$2 AND id=$3',
        [
          p.workspaceId,
          projectId,
          id,
          fields.title,
          fields.description,
          fields.status,
          fields.due_date,
        ],
      );
      await tx.query('SELECT assert_project_completion($1,$2)', [p.workspaceId, projectId]);
      await recordChange(tx, p, 'project.milestone_updated', projectId, project.conversation_id);
      return { ok: true, replayed: false };
    });
  }
}
export class LabelService {
  constructor(private readonly db: Database) {}
  async create(p: Identity, input: z.infer<typeof labelInput>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      human(p);
      const hash = digest(JSON.stringify(input));
      const [previous] = await tx.query(
        'SELECT id,request_hash FROM work_labels WHERE workspace_id=$1 AND created_by=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (previous) {
        if (previous.request_hash !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This label request ID was used for different details.',
          );
        return { id: previous.id, replayed: true };
      }
      await this.unique(tx, p, input.name);
      const [count] = await tx.query(
        'SELECT count(*)::int total FROM work_labels WHERE workspace_id=$1',
        [p.workspaceId],
      );
      if (Number(count!.total) >= 1000)
        throw new AppError(
          409,
          'LABEL_CATALOG_LIMIT',
          'This workspace supports up to 1,000 labels, including archived labels.',
        );
      const id = randomUUID();
      await tx.query(
        'INSERT INTO work_labels(id,workspace_id,name,color,created_by,client_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, p.workspaceId, input.name, input.color, p.membershipId, input.clientId, hash],
      );
      await recordChange(tx, p, 'label.created', id);
      return { id, replayed: false };
    });
  }
  async update(p: Identity, id: string, input: z.infer<typeof labelUpdate>) {
    return this.db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      human(p);
      const [row] = await tx.query(
        'SELECT * FROM work_labels WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [p.workspaceId, id],
      );
      if (!row) throw notFound();
      if (row.created_by !== p.membershipId && !['owner', 'admin'].includes(p.role))
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the label creator or an administrator can change this label.',
        );
      revision(Number(row.version), input.version);
      const name = input.name ?? String(row.name),
        color = input.color ?? String(row.color),
        archived = input.archived ?? Boolean(row.archived);
      if (name === row.name && color === row.color && archived === row.archived)
        return { ok: true, replayed: true };
      await this.unique(tx, p, name, id);
      await tx.query(
        'UPDATE work_labels SET name=$3,color=$4,archived=$5,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, name, color, archived],
      );
      await recordChange(tx, p, 'label.updated', id);
      return { ok: true, replayed: false };
    });
  }
  private async unique(tx: Sql, p: Identity, name: string, id: string | null = null) {
    const [duplicate] = await tx.query(
      'SELECT id FROM work_labels WHERE workspace_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id<>$3)',
      [p.workspaceId, name, id],
    );
    if (duplicate)
      throw new AppError(
        409,
        'LABEL_NAME_TAKEN',
        'A label with that name already exists, including archived labels.',
      );
  }
}
