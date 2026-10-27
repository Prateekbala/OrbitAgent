import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import type { Database, Sql } from '@ao/database';
import type { z } from 'zod';
import type { fileInput } from '@ao/contracts';
import { AppError, notFound } from '../lib/errors.js';
import { requireActiveMember, requireConversation, type Identity } from '../lib/policy.js';
import type { FileDependencies } from './config.js';
import { getTask } from '../tasks/queries.js';
import { taskActor, manageTask } from '../tasks/service.js';
import { currentDlp, inspectDlp, requireDlp } from './dlp.js';
const previewLimit = 512 * 1024;
export async function fileAuthority(
  tx: Sql,
  p: Identity,
  source: { conversation_id?: unknown; task_id?: unknown },
) {
  if (source.task_id) {
    p = await taskActor(tx, p, false);
    manageTask(p, await getTask(tx, p, String(source.task_id), true));
  } else {
    await requireActiveMember(tx, p, p.membershipId);
    await requireConversation(tx, p, String(source.conversation_id), true);
  }
}
function publicFile(file: Record<string, unknown>) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    content_type: file.content_type,
    has_preview: Boolean(file.preview_key),
    status: file.status,
    scan_status: file.scan_status,
    version: file.version,
    dlp_status: file.dlp_status,
  };
}
export class FileService {
  private active = 0;
  private readonly members = new Map<string, number>();
  constructor(
    private readonly db: Database,
    readonly dependencies: FileDependencies,
  ) {}
  async reserve(p: Identity, conversation: string, input: z.infer<typeof fileInput>) {
    return this.reserveSource(p, { conversation_id: conversation, task_id: null }, input);
  }
  async reserveTask(p: Identity, taskId: string, input: z.infer<typeof fileInput>) {
    return this.reserveSource(p, { conversation_id: null, task_id: taskId }, input);
  }
  private async reserveSource(
    p: Identity,
    source: { conversation_id: string | null; task_id: string | null },
    input: z.infer<typeof fileInput>,
  ) {
    return this.db.transaction(async (tx) => {
      const [workspace] = await tx.query(
        'SELECT storage_bytes,storage_limit_bytes FROM workspaces WHERE id=$1 FOR UPDATE',
        [p.workspaceId],
      );
      await fileAuthority(tx, p, source);
      const conversation = source.task_id
        ? (await getTask(tx, p, source.task_id)).conversation_id
        : source.conversation_id;
      const [existing] = await tx.query(
        'SELECT * FROM files WHERE workspace_id=$1 AND uploader_id=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (existing) {
        if (
          existing.conversation_id !== conversation ||
          (existing.task_id ?? null) !== source.task_id ||
          existing.name !== input.name ||
          existing.size !== input.size ||
          existing.sha256 !== input.sha256
        )
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This upload ID was used for another file.',
          );
        return publicFile(existing);
      }
      const reserved = input.size + previewLimit;
      if (
        BigInt(String(workspace!.storage_bytes)) + BigInt(reserved) >
        BigInt(String(workspace!.storage_limit_bytes))
      )
        throw new AppError(409, 'STORAGE_QUOTA', 'Workspace file storage is full.');
      const [pending] = await tx.query(
        "SELECT count(*)::int total FROM files WHERE workspace_id=$1 AND uploader_id=$2 AND status IN ('pending','uploading','ready')",
        [p.workspaceId, p.membershipId],
      );
      if (Number(pending!.total) >= 30)
        throw new AppError(
          429,
          'UPLOAD_LIMIT',
          'Send or remove existing uploads before adding more.',
        );
      const id = randomUUID(),
        key = `${p.workspaceId}/${id}/original`;
      const [file] = await tx.query(
        'INSERT INTO files(id,workspace_id,conversation_id,uploader_id,client_id,name,size,sha256,storage_provider,object_key,reserved_bytes,task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [
          id,
          p.workspaceId,
          conversation,
          p.membershipId,
          input.clientId,
          input.name,
          input.size,
          input.sha256,
          this.dependencies.store.id,
          key,
          reserved,
          source.task_id,
        ],
      );
      await tx.query('UPDATE workspaces SET storage_bytes=storage_bytes+$2 WHERE id=$1', [
        p.workspaceId,
        reserved,
      ]);
      return publicFile(file!);
    });
  }
  async inspect(p: Identity, id: string, download = false) {
    const [file] = await this.db.query(
      `SELECT f.* FROM files f WHERE f.workspace_id=$1 AND f.id=$2
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=f.workspace_id AND m.id=$3 AND m.status='active')
      AND (f.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=f.workspace_id AND c.id=f.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$3))))
      AND (f.task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=f.workspace_id AND t.id=f.task_id AND t.conversation_id IS NOT DISTINCT FROM f.conversation_id))
      AND ((f.uploader_id=$3 AND f.status IN ('pending','uploading','ready','rejected') AND f.expires_at>now()) OR (f.status='attached' AND ((f.task_id IS NOT NULL AND EXISTS(SELECT 1 FROM task_attachments ta WHERE ta.workspace_id=f.workspace_id AND ta.task_id=f.task_id AND ta.file_id=f.id AND ta.removed_at IS NULL)) OR (f.task_id IS NULL AND EXISTS(SELECT 1 FROM message_attachments a JOIN messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id WHERE a.workspace_id=f.workspace_id AND a.file_id=f.id AND m.deleted_at IS NULL)))))`,
      [p.workspaceId, id, p.membershipId],
    );
    if (!file) throw notFound();
    if (download && !['ready', 'attached'].includes(String(file.status)))
      throw new AppError(409, 'FILE_NOT_READY', 'This file is not ready to download.');
    if (download) await requireDlp(this.db, p.workspaceId, file);
    return file;
  }
  async metadata(p: Identity, id: string) {
    const file = await this.inspect(p, id);
    return {
      ...publicFile(file),
      conversation_id: file.conversation_id,
      task_id: file.task_id,
      can_manage: file.uploader_id === p.membershipId || ['owner', 'admin'].includes(p.role),
    };
  }
  async discard(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      const [reference] = await tx.query(
        'SELECT conversation_id,task_id FROM files WHERE workspace_id=$1 AND id=$2 AND uploader_id=$3',
        [p.workspaceId, id, p.membershipId],
      );
      if (!reference) throw notFound();
      await fileAuthority(tx, p, reference);
      await tx.query(
        "UPDATE files SET status='deleting',cleanup_after=now()+interval '5 minutes' WHERE workspace_id=$1 AND id=$2 AND uploader_id=$3 AND status IN ('pending','uploading','ready','rejected')",
        [p.workspaceId, id, p.membershipId],
      );
      return { ok: true };
    });
  }
  async upload(
    p: Identity,
    id: string,
    source: () => Promise<{
      stream: Readable;
      truncated: () => boolean;
      complete: () => Promise<void>;
    }>,
    signal: AbortSignal,
  ) {
    const memberKey = `${p.workspaceId}:${p.membershipId}`;
    if (this.active >= 4 || (this.members.get(memberKey) ?? 0) >= 2)
      throw new AppError(429, 'UPLOAD_BUSY', 'Wait for another upload to finish.');
    this.active++;
    this.members.set(memberKey, (this.members.get(memberKey) ?? 0) + 1);
    let directory: string | undefined;
    let file: Record<string, unknown> | undefined;
    const lease = randomUUID();
    let infected = false;
    try {
      file = await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
        const [reference] = await tx.query(
          'SELECT conversation_id,task_id FROM files WHERE workspace_id=$1 AND id=$2 AND uploader_id=$3',
          [p.workspaceId, id, p.membershipId],
        );
        if (!reference) throw notFound();
        await fileAuthority(tx, p, reference);
        const [claimed] = await tx.query(
          "UPDATE files SET status='uploading',lease_token=$4,lease_expires_at=now()+interval '10 minutes' WHERE workspace_id=$1 AND id=$2 AND uploader_id=$3 AND status='pending' AND expires_at>now() AND storage_provider=$5 RETURNING *",
          [p.workspaceId, id, p.membershipId, lease, this.dependencies.store.id],
        );
        if (!claimed)
          throw new AppError(
            409,
            'UPLOAD_STATE',
            'This upload has already started or expired. Check its status before retrying.',
          );
        return claimed;
      });
      await mkdir(this.dependencies.stagingDirectory, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.dependencies.stagingDirectory, 'upload-'));
      const path = join(directory, 'original');
      const { stream, truncated, complete } = await source();
      let size = 0;
      const hash = createHash('sha256');
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > Number(file!.size))
            return callback(new AppError(413, 'FILE_SIZE', 'The file exceeds its declared size.'));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(stream, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), {
        signal,
      });
      await complete();
      if (truncated() || size !== file.size || hash.digest('hex') !== file.sha256)
        throw new AppError(
          400,
          'FILE_INTEGRITY',
          'File size or checksum does not match. Choose the file again.',
        );
      let scan: 'clean' | 'development_only';
      try {
        scan = await this.dependencies.scanner.scan(path, signal);
      } catch (error) {
        infected = error instanceof Error && error.message === 'FILE_INFECTED';
        throw new AppError(
          422,
          'FILE_REJECTED',
          error instanceof Error && error.message === 'FILE_INFECTED'
            ? 'This file failed the malware scan.'
            : 'File scanning is unavailable. Try again later.',
        );
      }
      signal.throwIfAborted();
      const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'r'));
      const header = Buffer.alloc(16384);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(header, 0, header.length, 0));
      } finally {
        await handle.close();
      }
      const detected = await fileTypeFromBuffer(header.subarray(0, bytesRead)).catch(
        () => undefined,
      );
      const contentType = detected?.mime ?? 'application/octet-stream';
      const policy = await currentDlp(this.db, p.workspaceId),
        dlp = await inspectDlp(path, String(file.name), policy);
      if (dlp.status === 'blocked') {
        await this.db.query(
          'UPDATE files SET dlp_status=$3,dlp_policy_version=$4,dlp_findings=$5::jsonb WHERE workspace_id=$1 AND id=$2 AND lease_token=$6',
          [p.workspaceId, id, dlp.status, dlp.version, JSON.stringify(dlp.findings), lease],
        );
        throw new AppError(
          422,
          'DLP_BLOCKED',
          'This file does not satisfy the workspace data policy.',
        );
      }
      let preview: Buffer | undefined;
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)) {
        try {
          const output = await sharp(path, { limitInputPixels: 16000000, animated: false })
            .rotate()
            .resize({ width: 640, height: 480, fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
          if (output.length <= previewLimit) preview = output;
        } catch {}
      }
      await this.dependencies.store.put(String(file.object_key), path, signal);
      const previewKey = preview ? `${p.workspaceId}/${id}/preview` : null;
      if (preview && previewKey) {
        const previewPath = join(directory, 'preview');
        await writeFile(previewPath, preview, { mode: 0o600 });
        await this.dependencies.store.put(previewKey, previewPath, signal);
      }
      signal.throwIfAborted();
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        await fileAuthority(tx, p, file!);
        if ((await currentDlp(tx, p.workspaceId)).version !== dlp.version)
          throw new AppError(
            409,
            'DLP_POLICY_CHANGED',
            'The data policy changed during upload. Retry under the new policy.',
          );
        const [ready] = await tx.query(
          "UPDATE files SET status='ready',scan_status=$4,content_type=$5,preview_key=$6,reserved_bytes=$7,lease_token=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND id=$2 AND status='uploading' AND lease_token=$3 AND lease_expires_at>now() RETURNING id",
          [p.workspaceId, id, lease, scan, contentType, previewKey, size + (preview?.length ?? 0)],
        );
        if (!ready)
          throw new AppError(409, 'UPLOAD_EXPIRED', 'This upload expired or was cancelled.');
        await tx.query(
          'UPDATE files SET dlp_status=$3,dlp_policy_version=$4,dlp_findings=$5::jsonb WHERE workspace_id=$1 AND id=$2',
          [p.workspaceId, id, dlp.status, dlp.version, JSON.stringify(dlp.findings)],
        );
        await tx.query('UPDATE workspaces SET storage_bytes=storage_bytes-$2 WHERE id=$1', [
          p.workspaceId,
          Number(file!.reserved_bytes) - size - (preview?.length ?? 0),
        ]);
      });
      return await this.metadata(p, id);
    } catch (error) {
      if (file)
        await this.db
          .query(
            "UPDATE files SET status=CASE WHEN status='uploading' THEN 'rejected' ELSE status END,cleanup_after=now()+interval '5 minutes',scan_status=CASE WHEN $4 THEN 'infected' ELSE scan_status END WHERE workspace_id=$1 AND id=$2 AND lease_token=$3",
            [p.workspaceId, id, lease, infected],
          )
          .catch(() => {});
      throw error;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      this.active--;
      const remaining = (this.members.get(memberKey) ?? 1) - 1;
      if (remaining) this.members.set(memberKey, remaining);
      else this.members.delete(memberKey);
    }
  }
}

export async function attachFiles(
  tx: Sql,
  p: Identity,
  conversation: string,
  message: string,
  ids: string[],
  ordinalOffset = 0,
) {
  for (const id of [...ids].sort()) {
    const [file] = await tx.query(
      "SELECT id FROM files WHERE workspace_id=$1 AND id=$2 AND conversation_id=$3 AND task_id IS NULL AND uploader_id=$4 AND status='ready' AND expires_at>now() AND NOT EXISTS(SELECT 1 FROM scheduled_message_files sf JOIN scheduled_messages s ON s.workspace_id=sf.workspace_id AND s.id=sf.schedule_id WHERE sf.workspace_id=$1 AND sf.file_id=$2 AND s.status='scheduled' AND s.client_id<>(SELECT client_id FROM messages WHERE workspace_id=$1 AND id=$5)) FOR UPDATE",
      [p.workspaceId, id, conversation, p.membershipId, message],
    );
    if (!file)
      throw new AppError(
        400,
        'INVALID_ATTACHMENT',
        'Choose ready files uploaded by you in this conversation.',
      );
  }
  for (const [ordinal, id] of ids.entries()) {
    await tx.query(
      'INSERT INTO message_attachments(workspace_id,conversation_id,message_id,file_id,ordinal) VALUES($1,$2,$3,$4,$5)',
      [p.workspaceId, conversation, message, id, ordinal + ordinalOffset],
    );
    await tx.query("UPDATE files SET status='attached' WHERE workspace_id=$1 AND id=$2", [
      p.workspaceId,
      id,
    ]);
  }
}

const services = new WeakMap<Database, WeakMap<FileDependencies, FileService>>();
export function sharedFileService(db: Database, dependencies: FileDependencies) {
  let stores = services.get(db);
  if (!stores) {
    stores = new WeakMap();
    services.set(db, stores);
  }
  let service = stores.get(dependencies);
  if (!service) {
    service = new FileService(db, dependencies);
    stores.set(dependencies, service);
  }
  return service;
}
