import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import { personalListQuery } from '@ao/contracts/personal';
import type { Permission } from '@ao/contracts/identity';
import { authenticate } from './auth.js';
import { hasPermission } from '../identity/authorization.js';
import { requireAdmin } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { pageBoundary, pageResult } from '../messaging/pagination.js';
const audience = (alias: string) =>
  `(${alias}.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=${alias}.workspace_id AND c.id=${alias}.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2))))`;
const definitions = {
  agents: {
    permission: 'agents.read',
    select:
      'a.id,a.membership_id,m.name,a.instructions,a.status,a.runtime,a.owner_id,a.version,a.revision,a.last_seen_at,a.created_at',
    from: 'agents a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id',
    where: 'true',
    alias: 'a',
    time: 'created_at',
  },
  members: {
    permission: 'people.read',
    select:
      'm.id,m.name,m.kind,m.role,m.status,m.version,m.access_type,m.permissions,m.account_id,m.created_at',
    from: 'memberships m',
    where: 'true',
    alias: 'm',
    time: 'created_at',
  },
  knowledge: {
    permission: 'knowledge.read',
    select: 'k.*,m.name author_name',
    from: 'knowledge_pages k JOIN memberships m ON m.workspace_id=k.workspace_id AND m.id=k.author_id',
    where: audience('k'),
    alias: 'k',
    time: 'updated_at',
  },
  audit: {
    permission: 'workspace.manage',
    select: 'e.id,e.action,m.name actor_name,e.created_at',
    from: 'audit_events e JOIN memberships m ON m.workspace_id=e.workspace_id AND m.id=e.actor_id',
    where: `(e.audience_membership_id IS NULL OR e.audience_membership_id=$2) AND ${audience('e')}`,
    alias: 'e',
    time: 'created_at',
  },
  runs: {
    permission: 'execution.read',
    select:
      "r.id,r.prompt,r.status,r.error_code,r.created_at,r.updated_at,r.conversation_id,m.name agent_name,CASE WHEN c.kind='group' THEN c.title ELSE c.name END channel_name",
    from: 'agent_runs r JOIN agents a ON a.workspace_id=r.workspace_id AND a.id=r.agent_id JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id JOIN conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id',
    where: audience('r'),
    alias: 'r',
    time: 'created_at',
  },
  approvals: {
    permission: 'execution.read',
    select:
      't.id,t.run_id,t.tool_name,t.parameters,t.action_digest,t.authorization_snapshot,t.status,t.expires_at,t.result,t.error_code,t.created_at,m.name agent_name,c.name channel_name',
    from: 'tool_invocations t JOIN agent_runs r ON r.workspace_id=t.workspace_id AND r.id=t.run_id JOIN agents a ON a.workspace_id=r.workspace_id AND a.id=r.agent_id JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id JOIN conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id',
    where: audience('r'),
    alias: 't',
    time: 'created_at',
  },
  invitations: {
    permission: 'people.manage',
    select:
      'i.id,i.email,i.role,i.status,i.expires_at,i.created_at,(SELECT j.status FROM email_jobs j WHERE j.invitation_id=i.id ORDER BY j.created_at DESC LIMIT 1) delivery_status,(SELECT j.error_code FROM email_jobs j WHERE j.invitation_id=i.id ORDER BY j.created_at DESC LIMIT 1) delivery_error',
    from: 'invitations i',
    where: 'true',
    alias: 'i',
    time: 'created_at',
  },
} as const;
export function collectionPageRoutes(app: FastifyInstance, db: Database) {
  app.get('/v1/collections/:kind', async (req) => {
    const p = await authenticate(db, req),
      kind = z
        .enum(['agents', 'members', 'knowledge', 'audit', 'runs', 'approvals', 'invitations'])
        .parse((req.params as { kind: string }).kind),
      q = personalListQuery.parse(req.query),
      definition = definitions[kind],
      b = pageBoundary(p, kind, q.after);
    if (
      !hasPermission(p, definition.permission as Permission) ||
      (['guest', 'service'].includes(p.accessType ?? '') &&
        ['agents', 'runs', 'approvals', 'audit', 'invitations'].includes(kind))
    )
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'This collection is not available to this account.',
      );
    if (kind === 'audit' || kind === 'invitations') requireAdmin(p);
    const { select, from, where, alias, time } = definition;
    const rows = await db.query(
      `SELECT ${select},to_char(${alias}.${time} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') position_time FROM ${from} WHERE ${alias}.workspace_id=$1 AND ${where} AND ($3::timestamptz IS NULL OR (${alias}.${time},${alias}.id)<($3::timestamptz,$4::uuid)) AND $2::uuid IS NOT NULL ORDER BY ${alias}.${time} DESC,${alias}.id DESC LIMIT $5`,
      [p.workspaceId, p.membershipId, b?.at ?? null, b?.id ?? null, q.limit + 1],
    );
    return pageResult(p, kind, rows, q.limit, time);
  });
}
