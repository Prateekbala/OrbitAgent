import {
  tenantScope,
  identifyPrincipal,
  identifyAccountSession,
  type Database,
} from '@ao/database';
import type { Identity } from '../lib/policy.js';
import type { FileDependencies } from '../files/config.js';
import { FileService } from '../files/service.js';
import { AppError } from '../lib/errors.js';
import { textEntry, verifiedFile, type ArchiveEntry } from './archive.js';
import type { SharedChannelService } from './shared.js';
export async function* sharedExport(
  db: Database,
  shared: SharedChannelService,
  p: Identity,
  id: string,
  sessionId: string,
  files?: FileDependencies,
): AsyncGenerator<ArchiveEntry> {
  const scope = <T>(work: (guest: Identity, c: string) => Promise<T>) =>
    tenantScope(p.workspaceId, async () => {
      identifyPrincipal(p.membershipId, p.accessType ?? 'member');
      identifyAccountSession(sessionId);
      const [governance] = await db.query(
        "SELECT coalesce((governance_policy($1)->>'exports')::boolean,true) allowed",
        [p.workspaceId],
      );
      if (!governance?.allowed)
        throw new AppError(403, 'EXPORT_DISABLED', 'Organization policy disables exports.');
      return shared.inChannel(p, id, false, async (guest, c, policy) => {
        const [host] = await db.query(
          "SELECT coalesce((governance_policy($1)->>'exports')::boolean,true) allowed",
          [guest.workspaceId],
        );
        if (!host?.allowed)
          throw new AppError(403, 'EXPORT_DISABLED', 'Organization policy disables exports.');
        if (!policy.export)
          throw new AppError(
            403,
            'SHARED_EXPORT_DISABLED',
            'Participating organizations disabled exports.',
          );
        return work(guest, c);
      });
    });
  await scope(async () => {});
  let after: string | null = null,
    page = 0,
    count = 0;
  const omissions: { id: string; reason: string }[] = [];
  yield textEntry(
    'README.md',
    '# Shared channel export\n\nThis live export applies current participation, history, retention and export policies before each page and file chunk. Discard an incomplete archive if delivery aborts. Stable message, thread, author and file IDs are retained in JSON.\n',
  );
  while (true) {
    const rows = await scope((guest, c) =>
      db.query(
        'SELECT m.id,m.author_id,a.name author_name,m.body,m.thread_id,m.created_at,m.deleted_at,m.source_attribution,member_external_attribution(m.workspace_id,m.author_id) external_organization FROM messages m JOIN memberships a ON a.workspace_id=m.workspace_id AND a.id=m.author_id WHERE m.workspace_id=$1 AND m.conversation_id=$2 AND ($3::uuid IS NULL OR m.id>$3::uuid) ORDER BY m.id LIMIT 100',
        [guest.workspaceId, c, after],
      ),
    );
    if (!rows.length) break;
    after = String(rows.at(-1)!.id);
    page++;
    count += rows.length;
    yield textEntry(`messages/${page}.json`, JSON.stringify(rows, null, 2) + '\n');
    yield textEntry(
      `messages/${page}.md`,
      rows
        .map(
          (m) =>
            `## ${String(m.author_name).replace(/[\r\n]/g, ' ')}\n\nID: ${m.id}\nTime: ${m.created_at}\nThread: ${m.thread_id ?? 'root'}\n\n${m.deleted_at ? '[Deleted]' : m.body}\n`,
        )
        .join('\n'),
    );
    for (const message of rows) {
      if (message.deleted_at) continue;
      const attachments = await scope((guest, c) =>
        db.query(
          "SELECT f.id FROM message_attachments a JOIN files f ON f.workspace_id=a.workspace_id AND f.id=a.file_id WHERE a.workspace_id=$1 AND a.message_id=$2 AND f.conversation_id=$3 AND f.status='attached'",
          [guest.workspaceId, message.id, c],
        ),
      );
      for (const attachment of attachments) {
        if (!files) {
          omissions.push({ id: String(attachment.id), reason: 'File storage is unavailable.' });
          continue;
        }
        const file = await scope((guest) =>
          new FileService(db, files).inspect(guest, String(attachment.id), true),
        );
        if (file.storage_provider !== files.store.id) {
          omissions.push({
            id: String(file.id),
            reason: 'The retained storage provider is unavailable.',
          });
          continue;
        }
        const body = await files.store.get(String(file.object_key));
        yield textEntry(
          `files/${file.id}/metadata.json`,
          JSON.stringify(
            {
              id: file.id,
              name: file.name,
              size: file.size,
              sha256: file.sha256,
              messageId: message.id,
            },
            null,
            2,
          ) + '\n',
        );
        yield {
          name: `files/${file.id}/original`,
          size: Number(file.size),
          body: verifiedFile(body, String(file.sha256), async () => {
            await scope((guest) =>
              new FileService(db, files).inspect(guest, String(file.id), true),
            );
          }),
        };
      }
    }
  }
  await scope(async () => {});
  yield textEntry(
    'manifest.json',
    JSON.stringify(
      {
        format: 'orbit.shared-channel.v1',
        grantId: id,
        exportedAt: new Date().toISOString(),
        messages: count,
        omissions,
      },
      null,
      2,
    ) + '\n',
  );
}
