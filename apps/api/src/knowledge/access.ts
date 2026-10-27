import { randomUUID } from 'node:crypto';
import type { Sql } from '@ao/database';
import { AppError, notFound } from '../lib/errors.js';
import { requireActiveMember, requireConversation, type Identity } from '../lib/policy.js';
import { hasPermission } from '../identity/authorization.js';
import { recordChange } from '../lib/events.js';
export interface KnowledgeRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  title: string;
  body: string;
  version: number;
  owner_id: string;
  state: string;
  blocked: boolean;
  created_at: string;
}
export async function knowledgePage(tx: Sql, p: Identity, pageId: string, write = false) {
  if (write) {
    if (p.kind !== 'human')
      throw new AppError(403, 'HUMAN_REQUIRED', 'A person must author and govern knowledge.');
    await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
    await requireActiveMember(tx, p, p.membershipId);
    const [current] = await tx.query(
      'SELECT role,access_type,permissions FROM memberships WHERE workspace_id=$1 AND id=$2 FOR SHARE',
      [p.workspaceId, p.membershipId],
    );
    if (
      !current ||
      !hasPermission(
        {
          ...p,
          role: current.role as Identity['role'],
          accessType: current.access_type as NonNullable<Identity['accessType']>,
          permissions: current.permissions as NonNullable<Identity['permissions']>,
        },
        'knowledge.write',
      )
    )
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Current knowledge editing permission is required.',
      );
  }
  const [page] = await tx.query<KnowledgeRow>(
    `SELECT k.*,m.owner_id,m.state,m.blocked,o.status owner_status FROM knowledge_pages k JOIN knowledge_metadata m ON m.workspace_id=k.workspace_id AND m.page_id=k.id JOIN memberships o ON o.workspace_id=m.workspace_id AND o.id=m.owner_id WHERE k.workspace_id=$1 AND k.id=$2${write ? ' FOR UPDATE OF k,m' : ''}`,
    [p.workspaceId, pageId],
  );
  if (!page) throw notFound();
  if (page.conversation_id) await requireConversation(tx, p, page.conversation_id, write);
  return page;
}
export function requireKnowledgeOwner(p: Identity, page: KnowledgeRow) {
  if (
    p.kind !== 'human' ||
    (page.owner_id !== p.membershipId &&
      !(page.owner_status !== 'active' && ['owner', 'admin'].includes(p.role)))
  )
    throw new AppError(
      403,
      'PAGE_OWNER_REQUIRED',
      'The current page owner must make this governance change.',
    );
}
export async function publishKnowledge(
  tx: Sql,
  p: Identity,
  page: KnowledgeRow,
  title: string,
  body: string,
  summary: string,
) {
  if (page.state !== 'active')
    throw new AppError(409, 'PAGE_ARCHIVED', 'Restore this page before editing.');
  const version = Number(page.version) + 1;
  await tx.query(
    'UPDATE knowledge_pages SET title=$3,body=$4,version=$5 WHERE workspace_id=$1 AND id=$2',
    [p.workspaceId, page.id, title, body, version],
  );
  await tx.query(
    'INSERT INTO knowledge_versions(id,workspace_id,page_id,title,body,version,author_id,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), p.workspaceId, page.id, title, body, version, p.membershipId, summary],
  );
  await recordChange(tx, p, 'knowledge.updated', page.id, page.conversation_id);
  return version;
}
export async function sourcePage(
  tx: Sql,
  p: Identity,
  page: KnowledgeRow,
  sourceId: string,
  version?: number,
) {
  const source = await knowledgePage(tx, p, sourceId);
  const [lineage] = await tx.query('SELECT knowledge_lineage_visible($1,$2,$3) allowed', [
    p.workspaceId,
    sourceId,
    p.membershipId,
  ]);
  if (!lineage?.allowed)
    throw new AppError(
      409,
      'SOURCE_UNAVAILABLE',
      'Every source citation must remain visible to the editor.',
    );
  const [meta] = await tx.query(
    'SELECT review_state,fresh_until,superseded_by FROM knowledge_metadata WHERE workspace_id=$1 AND page_id=$2',
    [p.workspaceId, sourceId],
  );
  if (
    source.id === page.id ||
    source.state !== 'active' ||
    source.blocked ||
    source.conversation_id !== page.conversation_id ||
    (version !== undefined && source.version !== version) ||
    meta?.superseded_by ||
    meta?.review_state === 'contradicted' ||
    meta?.review_state === 'stale' ||
    (meta?.fresh_until && Date.parse(String(meta.fresh_until)) < Date.now())
  )
    throw new AppError(
      409,
      'SOURCE_UNAVAILABLE',
      'Use a current, active source with the same page audience.',
    );
  return source;
}
