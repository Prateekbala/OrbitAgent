import { tenantScope, identifyPrincipal, type Database } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { hasPermission } from '../identity/authorization.js';
import { FileService } from '../files/service.js';
import type { FileDependencies } from '../files/config.js';
import { textEntry, verifiedFile, type ArchiveEntry } from './archive.js';
import { importActor } from './authority.js';
const visible = (alias: string) =>
  `(${alias}.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=${alias}.workspace_id AND c.id=${alias}.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2)))) AND NOT EXISTS(SELECT 1 FROM shared_channel_grants_access(${alias}.workspace_id,${alias}.conversation_id) g WHERE NOT g.export_allowed)`;
const exportableKnowledge = (alias: string) =>
  `EXISTS(SELECT 1 FROM knowledge_metadata km JOIN memberships owner ON owner.workspace_id=km.workspace_id AND owner.id=km.owner_id WHERE km.workspace_id=${alias}.workspace_id AND km.page_id=${alias}.id AND (km.owner_id=$2 OR owner.status<>'active') AND km.state='active' AND NOT km.blocked AND km.superseded_by IS NULL AND km.review_state='approved' AND (km.fresh_until IS NULL OR km.fresh_until>now()) AND knowledge_lineage_visible(km.workspace_id,km.page_id,$2) AND NOT EXISTS(SELECT 1 FROM knowledge_sources ks WHERE ks.workspace_id=km.workspace_id AND ks.page_id=km.page_id AND ks.stale))`;
const noSecrets = {
  channels: {
    table: 'conversations',
    columns: 't.id,t.name,t.description,t.visibility,t.kind,t.created_at',
    where: `(t.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=t.workspace_id AND cm.conversation_id=t.id AND cm.membership_id=$2))`,
  },
  messages: {
    table: 'messages',
    columns: `t.id,t.conversation_id,t.author_id,a.name author_name,t.body,t.format,t.thread_id,t.sequence,t.created_at,t.edited_at,t.deleted_at,t.source_attribution,(SELECT jsonb_agg(jsonb_build_object('emoji',r.emoji,'membershipId',r.membership_id)) FROM message_reactions r WHERE r.workspace_id=t.workspace_id AND r.message_id=t.id) reactions,(SELECT jsonb_agg(jsonb_build_object('fileId',f.id,'name',f.name,'sha256',f.sha256)) FROM message_attachments ma JOIN files f ON f.workspace_id=ma.workspace_id AND f.id=ma.file_id WHERE ma.workspace_id=t.workspace_id AND ma.message_id=t.id AND f.status='attached') attachments`,
    join: 'JOIN memberships a ON a.workspace_id=t.workspace_id AND a.id=t.author_id',
    where: visible('t'),
  },
  tasks: {
    table: 'tasks',
    columns:
      't.id,t.conversation_id,t.title,t.description,t.state,t.priority,t.assignee_id,t.created_at,t.version,t.due_date',
    where: visible('t'),
  },
  knowledge: {
    table: 'knowledge_pages',
    columns: 't.id,t.conversation_id,t.title,t.body,t.author_id,t.version,t.updated_at',
    where: visible('t') + ' AND ' + exportableKnowledge('t'),
  },
  projects: {
    table: 'projects',
    columns: 't.id,t.conversation_id,t.name,t.description,t.status,t.created_at',
    where: visible('t'),
  },
  task_comments: {
    table: 'task_comments',
    columns: 't.id,t.task_id,t.author_id,t.body,t.created_at,t.deleted_at',
    where: `EXISTS(SELECT 1 FROM tasks parent WHERE parent.workspace_id=t.workspace_id AND parent.id=t.task_id AND ${visible('parent')})`,
  },
  knowledge_versions: {
    table: 'knowledge_versions',
    columns: 't.id,t.page_id,t.title,t.body,t.version,t.author_id,t.created_at',
    where: `EXISTS(SELECT 1 FROM knowledge_pages parent WHERE parent.workspace_id=$1 AND parent.id=t.page_id AND parent.version=t.version AND ${visible('parent')} AND ${exportableKnowledge('parent')})`,
  },
} as const;
export class WorkspaceExport {
  constructor(
    private db: Database,
    private files?: FileDependencies,
  ) {}
  async authorize(p: Identity) {
    await this.db.transaction(async (tx) => {
      await importActor(tx, p);
      const [governance] = await tx.query(
        "SELECT coalesce((governance_policy($1)->>'exports')::boolean,true) allowed",
        [p.workspaceId],
      );
      if (!governance?.allowed)
        throw new AppError(403, 'EXPORT_DISABLED', 'Organization policy disables content exports.');
      const [member] = await tx.query(
        'SELECT permissions FROM memberships WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, p.membershipId],
      );
      const current = {
        ...p,
        permissions: member?.permissions as NonNullable<Identity['permissions']>,
      };
      if (
        !['tasks.read', 'knowledge.read', 'projects.read', 'files.read'].every((v) =>
          hasPermission(current, v as 'tasks.read'),
        )
      )
        throw new AppError(
          403,
          'EXPORT_PERMISSION_REQUIRED',
          'Export requires current read access to each included content type.',
        );
    });
  }
  async *entries(p: Identity): AsyncGenerator<ArchiveEntry> {
    const scope = <T>(work: () => Promise<T>) =>
      tenantScope(p.workspaceId, async () => {
        identifyPrincipal(p.membershipId, p.accessType ?? 'member');
        return work();
      });
    const check = () => scope(() => this.authorize(p));
    await check();
    const omissions: { kind: string; id?: string; reason: string }[] = [
      {
        kind: 'private_content',
        reason:
          'Only conversations currently accessible to the exporter are included; private content without membership is omitted.',
      },
      {
        kind: 'credentials_and_private_state',
        reason:
          'Credentials, private memories/drafts, provider payloads and sessions are excluded.',
      },
    ];
    omissions.push({
      kind: 'governed_knowledge',
      reason:
        'Only current versions eligible under page export governance are included. Unapproved, blocked, superseded, stale, inaccessible-source and historical knowledge is omitted.',
    });
    omissions.push({
      kind: 'shared_policy',
      reason: 'Shared-channel content with an active export prohibition is omitted.',
    });
    const counts: Record<string, number> = {};
    yield textEntry(
      'README.md',
      '# Orbit workspace export\n\nThis archive contains readable Markdown and JSON with stable local IDs, authors, timestamps and source attribution. Channel links use `orbit://conversation/<id>/message/<id>`. Files are under files/<id>/original; names and hashes are in the manifest. This is a live, access-checked export, not a point-in-time database backup. Revocation aborts delivery; discard incomplete archives. See manifest.json for omissions.\n',
    );
    for (const [kind, d] of Object.entries(noSecrets)) {
      let after: string | null = null,
        page = 0;
      counts[kind] = 0;
      while (true) {
        await check();
        const rows = await scope(() =>
          this.db.query(
            `SELECT ${d.columns} FROM ${d.table} t ${'join' in d ? d.join : ''} WHERE ${kind === 'knowledge_versions' ? 'EXISTS(SELECT 1 FROM knowledge_pages p WHERE p.id=t.page_id AND p.workspace_id=$1)' : 't.workspace_id=$1'} AND ${d.where} AND ($3::uuid IS NULL OR t.id>$3::uuid) ${kind === 'messages' ? 'AND NOT EXISTS(SELECT 1 FROM shared_channel_grants_access(t.workspace_id,t.conversation_id) g WHERE NOT g.export_allowed)' : ''} ORDER BY t.id LIMIT 100`,
            [p.workspaceId, p.membershipId, after],
          ),
        );
        if (!rows.length) break;
        counts[kind]! += rows.length;
        after = String(rows.at(-1)!.id);
        page++;
        yield textEntry(`${kind}/${page}.json`, JSON.stringify(rows, null, 2) + '\n');
        if (['messages', 'tasks', 'knowledge'].includes(kind))
          yield textEntry(
            `${kind}/${page}.md`,
            rows
              .map(
                (r) =>
                  `## ${String(r.title ?? r.author_name ?? r.id).replace(/[\r\n]/g, ' ')}\n\nID: ${r.id}\n${r.conversation_id ? 'Channel: ' + r.conversation_id + '\n' : ''}${r.created_at ?? r.updated_at ?? ''}\n\n${r.deleted_at ? '[Deleted]' : (r.body ?? r.description ?? '')}\n`,
              )
              .join('\n'),
          );
      }
    }
    let after: string | null = null;
    counts.files = 0;
    while (true) {
      await check();
      const rows = await scope(() =>
        this.db.query(
          `SELECT f.id,f.name,f.size,f.sha256,f.conversation_id FROM files f WHERE f.workspace_id=$1 AND f.status='attached' AND ($3::uuid IS NULL OR f.id>$3::uuid) AND ${visible('f')} AND NOT EXISTS(SELECT 1 FROM shared_channel_grants_access(f.workspace_id,f.conversation_id) g WHERE NOT g.export_allowed) ORDER BY f.id LIMIT 50`,
          [p.workspaceId, p.membershipId, after],
        ),
      );
      if (!rows.length) break;
      after = String(rows.at(-1)!.id);
      for (const row of rows) {
        if (!this.files) {
          omissions.push({
            kind: 'file',
            id: String(row.id),
            reason: 'File storage is unavailable.',
          });
          continue;
        }
        let file: Record<string, unknown>;
        try {
          file = await scope(() =>
            new FileService(this.db, this.files!).inspect(p, String(row.id), true),
          );
        } catch {
          omissions.push({
            kind: 'file',
            id: String(row.id),
            reason: 'File is no longer retained or accessible.',
          });
          continue;
        }
        if (file.storage_provider !== this.files.store.id) {
          omissions.push({
            kind: 'file',
            id: String(row.id),
            reason: 'File storage provider is not available.',
          });
          continue;
        }
        await check();
        const body = await this.files.store.get(String(file.object_key));
        yield textEntry(`files/${row.id}/metadata.json`, JSON.stringify(row, null, 2) + '\n');
        yield {
          name: `files/${row.id}/original`,
          size: Number(file.size),
          body: verifiedFile(body, String(file.sha256), async () => {
            await check();
            await scope(() =>
              new FileService(this.db, this.files!).inspect(p, String(row.id), true),
            );
          }),
        };
        counts.files!++;
      }
    }
    await check();
    yield textEntry(
      'manifest.json',
      JSON.stringify(
        {
          format: 'orbit.workspace.v1',
          workspaceId: p.workspaceId,
          exportedAt: new Date().toISOString(),
          consistency: 'live-access-checked',
          counts,
          omissions,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
