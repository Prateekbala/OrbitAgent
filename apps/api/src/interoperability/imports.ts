import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import type { z } from 'zod';
import {
  migrationBatch,
  migrationCreate,
  migrationMappings,
  type MigrationRecord,
} from '@ao/contracts/interoperability';
import { digest } from '../lib/security.js';
import { canonicalJson } from '../lib/canonical-json.js';
import { requireConversation, requireActiveMember, type Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { attachFiles } from '../files/service.js';
import { MessageService } from '../messaging/service.js';
import { importActor, sourceFor } from './authority.js';
function version(row: Record<string, unknown>, expected: number) {
  if (row.version !== expected)
    throw new AppError(409, 'VERSION_CONFLICT', 'Reload this migration before changing it.');
}
export class ImportService {
  constructor(private readonly db: Database) {}
  async list(p: Identity) {
    return this.db.transaction(async (tx) => {
      await importActor(tx, p);
      return tx.query(
        'SELECT id,name,provider,source_workspace_id,mode,conflict_owner,state,version,source_complete,created_at FROM migration_sources WHERE workspace_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 100',
        [p.workspaceId, p.membershipId],
      );
    });
  }
  async create(p: Identity, input: z.infer<typeof migrationCreate>) {
    return this.db.transaction(async (tx) => {
      await importActor(tx, p);
      const [old] = await tx.query(
        'SELECT * FROM migration_sources WHERE workspace_id=$1 AND owner_id=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (old) {
        if (
          old.name !== input.name ||
          old.provider !== input.provider ||
          old.source_workspace_id !== input.sourceWorkspaceId ||
          old.mode !== input.mode ||
          old.conflict_owner !== input.conflictOwner
        )
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This request ID was used for another source.',
          );
        return { id: old.id, replayed: true };
      }
      const [count] = await tx.query(
        'SELECT count(*)::int total FROM migration_sources WHERE workspace_id=$1',
        [p.workspaceId],
      );
      if (Number(count?.total) >= 100)
        throw new AppError(
          409,
          'SOURCE_LIMIT',
          'This workspace supports up to 100 migration sources.',
        );
      const id = randomUUID();
      await tx.query(
        'INSERT INTO migration_sources(id,workspace_id,owner_id,client_id,name,provider,source_workspace_id,mode,conflict_owner,owner_auth_version,owner_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          id,
          p.workspaceId,
          p.membershipId,
          input.clientId,
          input.name,
          input.provider,
          input.sourceWorkspaceId,
          input.mode,
          input.conflictOwner,
          p.authVersion,
          p.policyVersion,
        ],
      );
      await recordChange(tx, p, 'migration.created', id, null, p.membershipId);
      return { id, replayed: false };
    });
  }
  async mappings(p: Identity, id: string, input: z.infer<typeof migrationMappings>) {
    return this.db.transaction(async (tx) => {
      const source = await sourceFor(tx, p, id);
      version(source, input.version);
      if (source.state !== 'paused')
        throw new AppError(409, 'PAUSE_REQUIRED', 'Pause this source before changing mappings.');
      if (
        new Set(input.channels.map((c) => c.sourceId)).size !== input.channels.length ||
        new Set(input.channels.map((c) => c.conversationId)).size !== input.channels.length ||
        new Set(input.identities.map((i) => i.sourceId)).size !== input.identities.length
      )
        throw new AppError(400, 'DUPLICATE_MAPPING', 'Choose unique identities and channels.');
      for (const channel of input.channels) {
        await requireConversation(tx, p, channel.conversationId, true);
        const [target] = await tx.query(
          'SELECT visibility,kind FROM conversations WHERE workspace_id=$1 AND id=$2',
          [p.workspaceId, channel.conversationId],
        );
        if (target?.kind !== 'channel')
          throw new AppError(400, 'CHANNEL_REQUIRED', 'Map imports to explicit channels.');
        if (
          (channel.visibility === 'private' || target.visibility === 'public') &&
          !channel.acknowledgeAudienceExpansion
        )
          throw new AppError(
            409,
            'AUDIENCE_REVIEW_REQUIRED',
            'Explicitly acknowledge the target audience for private history or public targets.',
          );
        const [old] = await tx.query(
          'SELECT conversation_id FROM migration_origins WHERE workspace_id=$1 AND source_id=$2 AND external_channel_id=$3 LIMIT 1',
          [p.workspaceId, id, channel.sourceId],
        );
        if (old && old.conversation_id !== channel.conversationId)
          throw new AppError(
            409,
            'IMMUTABLE_ORIGIN_MAPPING',
            'A channel with imported history cannot be remapped.',
          );
      }
      const origins = await tx.query(
        'SELECT DISTINCT external_channel_id FROM migration_origins WHERE workspace_id=$1 AND source_id=$2',
        [p.workspaceId, id],
      );
      if (origins.some((o) => !input.channels.some((c) => c.sourceId === o.external_channel_id)))
        throw new AppError(
          409,
          'IMMUTABLE_ORIGIN_MAPPING',
          'Retain mappings for imported history.',
        );
      for (const identity of input.identities)
        if (identity.membershipId) await requireActiveMember(tx, p, identity.membershipId);
      await tx.query('DELETE FROM migration_channels WHERE workspace_id=$1 AND source_id=$2', [
        p.workspaceId,
        id,
      ]);
      for (const c of input.channels)
        await tx.query(
          'INSERT INTO migration_channels(workspace_id,source_id,external_id,conversation_id,visibility,expansion_ack) VALUES($1,$2,$3,$4,$5,$6)',
          [
            p.workspaceId,
            id,
            c.sourceId,
            c.conversationId,
            c.visibility,
            c.acknowledgeAudienceExpansion,
          ],
        );
      await tx.query('DELETE FROM migration_identities WHERE workspace_id=$1 AND source_id=$2', [
        p.workspaceId,
        id,
      ]);
      for (const i of input.identities)
        await tx.query(
          'INSERT INTO migration_identities(workspace_id,source_id,external_id,name,membership_id) VALUES($1,$2,$3,$4,$5)',
          [p.workspaceId, id, i.sourceId, i.name, i.membershipId],
        );
      await tx.query(
        'UPDATE migration_sources SET version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id],
      );
      await recordChange(tx, p, 'migration.mappings_updated', id, null, p.membershipId);
      return { ok: true, version: input.version + 1 };
    });
  }
  async stage(p: Identity, id: string, input: z.infer<typeof migrationBatch>) {
    return this.db.transaction(async (tx) => {
      const source = await sourceFor(tx, p, id);
      if (source.state === 'disconnected')
        throw new AppError(409, 'SOURCE_DISCONNECTED', 'This source is disconnected.');
      if (
        new Set(input.records.map((r) => r.channelId + '\n' + r.id)).size !== input.records.length
      )
        throw new AppError(
          400,
          'DUPLICATE_SOURCE_RECORD',
          'A batch may contain one revision of each source message.',
        );
      const hash = digest(canonicalJson(input));
      const [old] = await tx.query(
        'SELECT id,fingerprint FROM migration_batches WHERE workspace_id=$1 AND source_id=$2 AND client_id=$3',
        [p.workspaceId, id, input.clientId],
      );
      if (old) {
        if (old.fingerprint !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This batch ID was used for different data.',
          );
        return { id: old.id, replayed: true };
      }
      const [count] = await tx.query(
        "SELECT count(*)::int total FROM migration_records WHERE workspace_id=$1 AND source_id=$2 AND state IN ('pending','conflict')",
        [p.workspaceId, id],
      );
      if (Number(count?.total) + input.records.length > 10000)
        throw new AppError(
          429,
          'IMPORT_BACKPRESSURE',
          'Process or resolve staged records before adding more.',
        );
      const batch = randomUUID();
      await tx.query(
        'INSERT INTO migration_batches(id,workspace_id,source_id,client_id,fingerprint,cursor,complete) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [batch, p.workspaceId, id, input.clientId, hash, input.cursor, input.complete],
      );
      for (const r of input.records) {
        const [existing] = await tx.query(
          'SELECT payload_hash FROM migration_records WHERE workspace_id=$1 AND source_id=$2 AND external_channel_id=$3 AND external_id=$4 AND revision=$5',
          [p.workspaceId, id, r.channelId, r.id, r.revision],
        );
        if (existing) {
          if (existing.payload_hash !== digest(canonicalJson(r)))
            throw new AppError(
              409,
              'REVISION_CONFLICT',
              'The provider revision contains different content.',
            );
          continue;
        }
        await tx.query(
          'INSERT INTO migration_records(id,workspace_id,source_id,batch_id,external_id,external_channel_id,revision,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            randomUUID(),
            p.workspaceId,
            id,
            batch,
            r.id,
            r.channelId,
            r.revision,
            JSON.stringify(r),
            digest(canonicalJson(r)),
          ],
        );
      }
      await tx.query(
        'UPDATE migration_sources SET source_complete=$3 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, input.complete],
      );
      return { id: batch, replayed: false };
    });
  }
  async report(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      const source = await sourceFor(tx, p, id);
      const channels = await tx.query(
        'SELECT mc.*,c.name target_name,c.visibility target_visibility FROM migration_channels mc JOIN conversations c ON c.workspace_id=mc.workspace_id AND c.id=mc.conversation_id WHERE mc.workspace_id=$1 AND mc.source_id=$2',
        [p.workspaceId, id],
      );
      for (const channel of channels)
        await requireConversation(tx, p, String(channel.conversation_id));
      const counts = await tx.query(
        'SELECT state,count(*)::int count FROM migration_records WHERE workspace_id=$1 AND source_id=$2 GROUP BY state',
        [p.workspaceId, id],
      );
      const issues = await tx.query(
        `SELECT r.id,r.external_id,r.external_channel_id,r.state,r.reason,r.version,r.payload->'unsupported' unsupported,(SELECT count(*)::int FROM jsonb_array_elements(r.payload->'files') f WHERE f->>'fileId' IS NULL AND NOT EXISTS(SELECT 1 FROM migration_file_mappings fm WHERE fm.workspace_id=r.workspace_id AND fm.source_id=r.source_id AND fm.external_id=f->>'sourceId')) missing_files FROM migration_records r WHERE r.workspace_id=$1 AND r.source_id=$2 AND (r.state IN ('pending','conflict','omitted') OR jsonb_array_length(r.payload->'unsupported')>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.payload->'files') f WHERE f->>'fileId' IS NULL AND NOT EXISTS(SELECT 1 FROM migration_file_mappings fm WHERE fm.workspace_id=r.workspace_id AND fm.source_id=r.source_id AND fm.external_id=f->>'sourceId'))) ORDER BY r.created_at,r.id LIMIT 200`,
        [p.workspaceId, id],
      );
      const checksums = await tx.query(
        `SELECT external_channel_id,count(*)::int messages,encode(sha256(convert_to(string_agg(external_id||':'||source_revision,',' ORDER BY external_id),'UTF8')),'hex') checksum FROM migration_origins WHERE workspace_id=$1 AND source_id=$2 GROUP BY external_channel_id`,
        [p.workspaceId, id],
      );
      const unmapped = await tx.query(
        `SELECT DISTINCT payload->>'authorId' source_id,payload->>'authorName' name FROM migration_records r WHERE workspace_id=$1 AND source_id=$2 AND NOT EXISTS(SELECT 1 FROM migration_identities i WHERE i.workspace_id=r.workspace_id AND i.source_id=r.source_id AND i.external_id=r.payload->>'authorId' AND i.membership_id IS NOT NULL) LIMIT 200`,
        [p.workspaceId, id],
      );
      const pending = counts
        .filter((c) => c.state !== 'applied' && c.state !== 'omitted')
        .reduce((n, c) => n + Number(c.count), 0);
      return {
        source: {
          id: source.id,
          name: source.name,
          provider: source.provider,
          state: source.state,
          version: source.version,
          mode: source.mode,
          conflictOwner: source.conflict_owner,
          cursor: source.cursor,
          sourceComplete: source.source_complete,
        },
        channels,
        identities: await tx.query(
          'SELECT external_id source_id,name,membership_id FROM migration_identities WHERE workspace_id=$1 AND source_id=$2',
          [p.workspaceId, id],
        ),
        counts,
        issues,
        unmappedIdentities: unmapped,
        checksums,
        complete: !!source.source_complete && pending === 0,
        hasOmissions: issues.some(
          (i) =>
            i.state === 'omitted' ||
            Number(i.missing_files) > 0 ||
            (Array.isArray(i.unsupported) && i.unsupported.length > 0),
        ),
        reportTruncated: issues.length === 200,
      };
    });
  }
  async preflight(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      const source = await sourceFor(tx, p, id);
      const channels = await tx.query(
        'SELECT mc.*,c.name,c.visibility target_visibility,c.archived_at FROM migration_channels mc JOIN conversations c ON c.workspace_id=mc.workspace_id AND c.id=mc.conversation_id WHERE mc.workspace_id=$1 AND mc.source_id=$2',
        [p.workspaceId, id],
      );
      const audiences = [];
      for (const c of channels) {
        await requireConversation(tx, p, String(c.conversation_id), true);
        const participants = await tx.query(
          "SELECT m.id,m.name,m.kind FROM conversation_members cm JOIN memberships m ON m.workspace_id=cm.workspace_id AND m.id=cm.membership_id WHERE cm.workspace_id=$1 AND cm.conversation_id=$2 AND m.status='active' ORDER BY m.id",
          [p.workspaceId, c.conversation_id],
        );
        audiences.push({
          sourceChannelId: c.external_id,
          targetChannelId: c.conversation_id,
          targetName: c.name,
          visibility: c.target_visibility,
          participants,
          archived: !!c.archived_at,
          expansionAcknowledged: c.expansion_ack,
        });
      }
      const blockers = await tx.query(
        `SELECT r.id,r.external_id,CASE WHEN mc.external_id IS NULL THEN 'CHANNEL_MAPPING_REQUIRED' WHEN c.archived_at IS NOT NULL THEN 'CHANNEL_ARCHIVED' WHEN NOT shared_message_retained(r.workspace_id,c.id,(r.payload->>'timestamp')::timestamptz) THEN 'OUTSIDE_AGREED_RETENTION' WHEN r.payload->>'threadId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM migration_origins o WHERE o.workspace_id=r.workspace_id AND o.source_id=r.source_id AND o.external_channel_id=r.external_channel_id AND o.external_id=r.payload->>'threadId') AND NOT EXISTS(SELECT 1 FROM migration_records root WHERE root.workspace_id=r.workspace_id AND root.source_id=r.source_id AND root.external_channel_id=r.external_channel_id AND root.external_id=r.payload->>'threadId' AND root.payload->>'threadId' IS NULL) THEN 'MISSING_THREAD_ROOT' ELSE NULL END reason FROM migration_records r LEFT JOIN migration_channels mc ON mc.workspace_id=r.workspace_id AND mc.source_id=r.source_id AND mc.external_id=r.external_channel_id LEFT JOIN conversations c ON c.workspace_id=mc.workspace_id AND c.id=mc.conversation_id WHERE r.workspace_id=$1 AND r.source_id=$2 AND r.state='pending' ORDER BY r.created_at,r.id LIMIT 1000`,
        [p.workspaceId, id],
      );
      return {
        sourceId: id,
        state: source.state,
        publishesMessages: false,
        audiences,
        blockers: blockers.filter((b) => b.reason),
        truncated: blockers.length === 1000,
        identityPolicy: 'Explicit mapping only; no email matching or automatic membership grants.',
        filePolicy:
          'Only explicitly mapped scanned uploads are retained; missing bodies appear in completeness reports.',
      };
    });
  }
  async control(
    p: Identity,
    id: string,
    expected: number,
    action: 'start' | 'pause' | 'disconnect',
  ) {
    return this.db.transaction(async (tx) => {
      const source = await sourceFor(tx, p, id);
      version(source, expected);
      if (source.state === 'disconnected')
        throw new AppError(
          409,
          'SOURCE_DISCONNECTED',
          'Create a new source to reconnect after disconnect.',
        );
      if (action === 'start') {
        const channels = await tx.query(
          'SELECT conversation_id FROM migration_channels WHERE workspace_id=$1 AND source_id=$2',
          [p.workspaceId, id],
        );
        if (!channels.length)
          throw new AppError(409, 'MAPPINGS_REQUIRED', 'Review channel mappings before starting.');
        for (const c of channels) await requireConversation(tx, p, String(c.conversation_id), true);
      }
      await tx.query(
        "UPDATE migration_sources SET state=$3,version=version+1,owner_auth_version=$4,owner_policy_version=$5,relay_secret=CASE WHEN $3='disconnected' OR owner_auth_version<>$4 OR owner_policy_version<>$5 THEN NULL ELSE relay_secret END WHERE workspace_id=$1 AND id=$2",
        [
          p.workspaceId,
          id,
          action === 'start' ? 'active' : action === 'pause' ? 'paused' : 'disconnected',
          p.authVersion,
          p.policyVersion,
        ],
      );
      if (action !== 'start')
        await tx.query(
          "UPDATE migration_deliveries SET state=CASE WHEN state='leased' THEN 'uncertain' ELSE 'cancelled' END,lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND source_id=$2 AND state IN ('leased','pending')",
          [p.workspaceId, id],
        );
      await recordChange(tx, p, 'migration.' + action, id, null, p.membershipId);
      return { ok: true, version: expected + 1 };
    });
  }
  async process(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      const source = await sourceFor(tx, p, id);
      if (source.state !== 'active') return { processed: 0 };
      await tx.query("SELECT set_config('ao.import_source',$1,true)", [id]);
      const rows = await tx.query(
        `SELECT * FROM migration_records WHERE workspace_id=$1 AND source_id=$2 AND state='pending' ORDER BY (payload->>'threadId' IS NOT NULL),created_at,(payload->>'timestamp')::timestamptz,id LIMIT 100 FOR UPDATE`,
        [p.workspaceId, id],
      );
      let processed = 0;
      for (const row of rows) {
        const r = row.payload as MigrationRecord;
        const result = await this.apply(tx, p, source, r);
        await tx.query(
          'UPDATE migration_records SET state=$3,reason=$4,version=version+1 WHERE workspace_id=$1 AND id=$2',
          [p.workspaceId, row.id, result.state, result.reason ?? null],
        );
        if (result.state !== 'pending') processed++;
      }
      const [batch] = await tx.query(
        `SELECT b.cursor FROM migration_batches b WHERE b.workspace_id=$1 AND b.source_id=$2 AND NOT EXISTS(SELECT 1 FROM migration_records r WHERE r.workspace_id=b.workspace_id AND r.source_id=b.source_id AND r.created_at<=b.created_at AND r.state IN ('pending','conflict')) ORDER BY b.created_at DESC,b.id DESC LIMIT 1`,
        [p.workspaceId, id],
      );
      if (batch)
        await tx.query('UPDATE migration_sources SET cursor=$3 WHERE workspace_id=$1 AND id=$2', [
          p.workspaceId,
          id,
          batch.cursor,
        ]);
      return { processed };
    });
  }
  private async apply(
    tx: Sql,
    p: Identity,
    source: Record<string, unknown>,
    r: MigrationRecord,
    force = false,
  ): Promise<{ state: string; reason?: string }> {
    const id = String(source.id);
    const [mapping] = await tx.query(
      'SELECT * FROM migration_channels WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3',
      [p.workspaceId, id, r.channelId],
    );
    if (!mapping) return { state: 'conflict', reason: 'CHANNEL_MAPPING_REQUIRED' };
    const conversation = String(mapping.conversation_id);
    const [retained] = await tx.query(
      'SELECT shared_message_retained($1,$2,$3::timestamptz) allowed',
      [p.workspaceId, conversation, r.timestamp],
    );
    if (!retained?.allowed) return { state: 'omitted', reason: 'OUTSIDE_AGREED_RETENTION' };
    await requireConversation(tx, p, conversation, true);
    const [channel] = await tx.query(
      'SELECT visibility,archived_at FROM conversations WHERE workspace_id=$1 AND id=$2',
      [p.workspaceId, conversation],
    );
    if (channel?.archived_at) return { state: 'conflict', reason: 'CHANNEL_ARCHIVED' };
    if (
      mapping.visibility === 'private' &&
      channel?.visibility !== 'private' &&
      !mapping.expansion_ack
    )
      return { state: 'conflict', reason: 'AUDIENCE_CHANGED' };
    if (r.echoActionId) {
      const [echo] = await tx.query(
        "SELECT id FROM migration_deliveries WHERE workspace_id=$1 AND source_id=$2 AND id=$3 AND state IN ('completed','leased','uncertain')",
        [p.workspaceId, id, r.echoActionId],
      );
      if (echo) return { state: 'applied', reason: 'ECHO_SUPPRESSED' };
    }
    const [origin] = await tx.query(
      'SELECT o.*,m.version,m.deleted_at FROM migration_origins o JOIN messages m ON m.workspace_id=o.workspace_id AND m.id=o.message_id WHERE o.workspace_id=$1 AND o.source_id=$2 AND o.external_channel_id=$3 AND o.external_id=$4 FOR UPDATE OF o,m',
      [p.workspaceId, id, r.channelId, r.id],
    );
    if (origin?.deleted_at && r.deleted) return { state: 'applied', reason: 'ALREADY_DELETED' };
    if (origin && !force && origin.source_revision !== r.revision) {
      const prior = String(origin.source_revision),
        incoming = r.revision;
      const position = (value: string) =>
        /^\d+\.\d+$/.test(value) ? Number(value) : Date.parse(value);
      const a = position(prior),
        b = position(incoming);
      if (!Number.isFinite(a) || !Number.isFinite(b))
        return { state: 'conflict', reason: 'REVISION_ORDER_REVIEW' };
      if (b < a) return { state: 'applied', reason: 'STALE_SOURCE_REVISION' };
    }
    if (
      origin &&
      !force &&
      (source.conflict_owner === 'local' || origin.local_version !== origin.version)
    )
      return {
        state: 'conflict',
        reason: source.conflict_owner === 'local' ? 'LOCAL_OWNS_REVISION' : 'LOCAL_EDIT_CONFLICT',
      };
    const [identity] = await tx.query(
      'SELECT i.name,i.membership_id,m.status FROM migration_identities i LEFT JOIN memberships m ON m.workspace_id=i.workspace_id AND m.id=i.membership_id WHERE i.workspace_id=$1 AND i.source_id=$2 AND i.external_id=$3',
      [p.workspaceId, id, r.authorId],
    );
    const author = identity?.status === 'active' ? String(identity.membership_id) : p.membershipId;
    let thread: string | null = null;
    if (r.threadId) {
      const [root] = await tx.query(
        'SELECT message_id FROM migration_origins WHERE workspace_id=$1 AND source_id=$2 AND external_channel_id=$3 AND external_id=$4',
        [p.workspaceId, id, r.channelId, r.threadId],
      );
      if (!root) return { state: 'pending', reason: 'MISSING_THREAD_ROOT' };
      thread = String(root.message_id);
      const [message] = await tx.query(
        'SELECT thread_id FROM messages WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, thread],
      );
      if (message?.thread_id) return { state: 'conflict', reason: 'NESTED_THREAD_UNSUPPORTED' };
    }
    const files: MigrationRecord['files'] = [];
    for (const file of r.files) {
      let fileId = file.fileId;
      if (fileId) {
        const [valid] = await tx.query(
          "SELECT id FROM files WHERE workspace_id=$1 AND id=$2 AND conversation_id=$3 AND uploader_id=$4 AND status IN ('ready','attached') AND scan_status='clean'",
          [p.workspaceId, fileId, conversation, p.membershipId],
        );
        if (!valid) return { state: 'conflict', reason: 'FILE_MAPPING_NOT_READY' };
        await tx.query(
          'INSERT INTO migration_file_mappings(workspace_id,source_id,external_id,conversation_id,file_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,source_id,external_id) DO UPDATE SET file_id=EXCLUDED.file_id WHERE migration_file_mappings.conversation_id=EXCLUDED.conversation_id',
          [p.workspaceId, id, file.sourceId, conversation, fileId],
        );
      } else {
        const [mapped] = await tx.query(
          "SELECT f.id FROM migration_file_mappings fm JOIN files f ON f.workspace_id=fm.workspace_id AND f.id=fm.file_id WHERE fm.workspace_id=$1 AND fm.source_id=$2 AND fm.external_id=$3 AND fm.conversation_id=$4 AND f.status IN ('ready','attached') AND f.scan_status='clean'",
          [p.workspaceId, id, file.sourceId, conversation],
        );
        if (mapped) fileId = String(mapped.id);
      }
      files.push({ ...file, ...(fileId ? { fileId } : {}) });
    }
    const attribution = {
      provider: source.provider,
      sourceId: id,
      sourceWorkspaceId: source.source_workspace_id,
      externalId: r.id,
      externalChannelId: r.channelId,
      authorId: r.authorId,
      authorName: identity?.name ?? r.authorName,
      timestamp: r.timestamp,
      revision: r.revision,
      reactions: r.reactions,
      files: files.map((f) => ({ sourceId: f.sourceId, name: f.name, retained: !!f.fileId })),
      unsupported: r.unsupported,
    };
    let message = origin ? String(origin.message_id) : randomUUID();
    if (origin?.deleted_at && !r.deleted) return { state: 'conflict', reason: 'LOCAL_DELETION' };
    if (!origin) {
      const [counter] = await tx.query(
        'UPDATE conversations SET next_sequence=next_sequence+1 WHERE workspace_id=$1 AND id=$2 RETURNING next_sequence',
        [p.workspaceId, conversation],
      );
      await tx.query(
        'INSERT INTO messages(id,workspace_id,conversation_id,author_id,body,client_id,thread_id,sequence,created_at,source_attribution) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          message,
          p.workspaceId,
          conversation,
          author,
          r.body || '[Imported file]',
          randomUUID(),
          thread,
          counter!.next_sequence,
          r.timestamp,
          JSON.stringify(attribution),
        ],
      );
      if (files.some((f) => f.fileId))
        await attachFiles(
          tx,
          p,
          conversation,
          message,
          files.flatMap((f) => (f.fileId ? [f.fileId] : [])),
        );
      await tx.query(
        'INSERT INTO migration_origins(workspace_id,source_id,external_channel_id,external_id,conversation_id,message_id,source_revision,local_version) VALUES($1,$2,$3,$4,$5,$6,$7,1)',
        [p.workspaceId, id, r.channelId, r.id, conversation, message, r.revision],
      );
    } else {
      const attachments = await tx.query(
        'SELECT file_id FROM message_attachments WHERE workspace_id=$1 AND message_id=$2',
        [p.workspaceId, message],
      );
      const retained = new Set(files.flatMap((f) => (f.fileId ? [f.fileId] : [])));
      for (const old of attachments)
        if (!retained.has(String(old.file_id))) {
          await tx.query(
            'DELETE FROM message_attachments WHERE workspace_id=$1 AND message_id=$2 AND file_id=$3',
            [p.workspaceId, message, old.file_id],
          );
          await tx.query(
            "UPDATE files SET status='deleting',cleanup_after=now()+interval '5 minutes' WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, old.file_id],
          );
        }
      const additions = files.flatMap((f) =>
        f.fileId && !attachments.some((a) => a.file_id === f.fileId) ? [f.fileId] : [],
      );
      if (additions.length) {
        const [ordinal] = await tx.query(
          'SELECT coalesce(max(ordinal),-1)+1 next FROM message_attachments WHERE workspace_id=$1 AND message_id=$2',
          [p.workspaceId, message],
        );
        await attachFiles(tx, p, conversation, message, additions, Number(ordinal!.next));
      }
      await tx.query(
        'UPDATE messages SET body=$3,source_attribution=$4,version=version+1,edited_at=now() WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, message, r.body || '[Imported file]', JSON.stringify(attribution)],
      );
      await tx.query(
        'UPDATE migration_origins SET source_revision=$5,local_version=$6 WHERE workspace_id=$1 AND source_id=$2 AND external_channel_id=$3 AND external_id=$4',
        [p.workspaceId, id, r.channelId, r.id, r.revision, Number(origin.version) + 1],
      );
    }
    if (r.deleted) {
      const [current] = await tx.query(
        'SELECT version FROM messages WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, message],
      );
      await new MessageService({
        query: tx.query.bind(tx),
        transaction: (fn) => fn(tx),
        close: async () => {},
      }).delete(p, message, Number(current!.version));
    }
    await recordChange(tx, p, 'migration.message_imported', message, conversation);
    return { state: 'applied' };
  }
  async resolve(
    p: Identity,
    id: string,
    recordId: string,
    expected: number,
    action: 'source' | 'local' | 'omit',
  ) {
    return this.db.transaction(async (tx) => {
      const source = await sourceFor(tx, p, id);
      const [row] = await tx.query(
        'SELECT * FROM migration_records WHERE workspace_id=$1 AND source_id=$2 AND id=$3 FOR UPDATE',
        [p.workspaceId, id, recordId],
      );
      if (!row) throw notFound();
      version(row, expected);
      if (row.state !== 'conflict' && row.state !== 'pending')
        throw new AppError(409, 'NOT_CONFLICTED', 'This record is already resolved.');
      await tx.query("SELECT set_config('ao.import_source',$1,true)", [id]);
      const result =
        action === 'source'
          ? await this.apply(tx, p, source, row.payload as MigrationRecord, true)
          : {
              state: 'omitted',
              reason: action === 'local' ? 'LOCAL_REVISION_RETAINED' : 'EXPLICIT_OMISSION',
            };
      await tx.query(
        'UPDATE migration_records SET state=$3,reason=$4,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, recordId, result.state, result.reason ?? null],
      );
      await recordChange(tx, p, 'migration.conflict_resolved', recordId, null, p.membershipId);
      return result;
    });
  }
}
