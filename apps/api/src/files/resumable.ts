import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Database } from '@ao/database';
import { uploadChunkBytes } from '@ao/contracts/file-governance';
import type { Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { FileService, fileAuthority } from './service.js';
export class ResumableUploads {
  constructor(
    private readonly db: Database,
    private readonly files: FileService,
  ) {}
  async status(p: Identity, id: string) {
    const file = await this.files.inspect(p, id);
    if (file.uploader_id !== p.membershipId) throw notFound();
    const [row] = await this.db.query(
      'SELECT received_bytes,completed_at FROM file_upload_sessions WHERE workspace_id=$1 AND file_id=$2',
      [p.workspaceId, id],
    );
    return {
      fileId: id,
      offset: Number(row?.received_bytes ?? 0),
      size: Number(file.size),
      chunkBytes: uploadChunkBytes,
      complete: ['ready', 'attached'].includes(String(file.status)),
      expiresAt: file.expires_at,
    };
  }
  async chunk(
    p: Identity,
    id: string,
    offset: number,
    checksum: string,
    body: Buffer,
    signal: AbortSignal,
  ) {
    if (
      !body.length ||
      body.length > uploadChunkBytes ||
      createHash('sha256').update(body).digest('hex') !== checksum
    )
      throw new AppError(400, 'CHUNK_INTEGRITY', 'Chunk size or checksum does not match.');
    const lease = randomUUID(),
      key = `${p.workspaceId}/${id}/chunks/${offset}`;
    const replayed = await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      const [file] = await tx.query(
        "SELECT * FROM files WHERE workspace_id=$1 AND id=$2 AND uploader_id=$3 AND status='pending' AND expires_at>now() FOR UPDATE",
        [p.workspaceId, id, p.membershipId],
      );
      if (!file) throw notFound();
      await fileAuthority(tx, p, file);
      await tx.query(
        'INSERT INTO file_upload_sessions(workspace_id,file_id,membership_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [p.workspaceId, id, p.membershipId],
      );
      const [session] = await tx.query(
        'SELECT received_bytes FROM file_upload_sessions WHERE workspace_id=$1 AND file_id=$2 FOR UPDATE',
        [p.workspaceId, id],
      );
      const [prior] = await tx.query(
        'SELECT * FROM file_upload_chunks WHERE workspace_id=$1 AND file_id=$2 AND offset_bytes=$3',
        [p.workspaceId, id, offset],
      );
      if (prior && (prior.sha256 !== checksum || Number(prior.size) !== body.length))
        throw new AppError(
          409,
          'CHUNK_CONFLICT',
          'This chunk was already reserved with different bytes.',
        );
      if (prior?.state === 'complete') return true;
      if (prior && new Date(String(prior.lease_until)).getTime() > Date.now())
        throw new AppError(
          409,
          'CHUNK_BUSY',
          'This chunk is still being uploaded. Retry after its lease expires.',
        );
      if (
        offset !== Number(session!.received_bytes) ||
        offset + body.length > Number(file.size) ||
        body.length !== Math.min(uploadChunkBytes, Number(file.size) - offset)
      )
        throw new AppError(
          409,
          'UPLOAD_OFFSET',
          'Resume from the committed server offset using full-size chunks.',
        );
      await tx.query(
        "INSERT INTO file_upload_chunks(workspace_id,file_id,offset_bytes,size,sha256,object_key,state,lease,lease_until) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,now()+interval '1 minute') ON CONFLICT(workspace_id,file_id,offset_bytes) DO UPDATE SET lease=EXCLUDED.lease,lease_until=EXCLUDED.lease_until",
        [p.workspaceId, id, offset, body.length, checksum, key, lease],
      );
      return false;
    });
    if (replayed) return this.status(p, id);
    let directory: string | undefined;
    try {
      await mkdir(this.files.dependencies.stagingDirectory, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.files.dependencies.stagingDirectory, 'upload-'));
      const path = join(directory, 'chunk');
      await writeFile(path, body, { mode: 0o600 });
      await this.files.dependencies.store.put(key, path, signal);
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
        const [file] = await tx.query(
          "SELECT * FROM files WHERE workspace_id=$1 AND id=$2 AND status='pending' AND uploader_id=$3 AND expires_at>now() FOR UPDATE",
          [p.workspaceId, id, p.membershipId],
        );
        if (!file) throw notFound();
        await fileAuthority(tx, p, file);
        const [done] = await tx.query(
          "UPDATE file_upload_chunks SET state='complete' WHERE workspace_id=$1 AND file_id=$2 AND offset_bytes=$3 AND lease=$4 AND lease_until>now() AND state='pending' RETURNING offset_bytes",
          [p.workspaceId, id, offset, lease],
        );
        if (!done)
          throw new AppError(
            409,
            'CHUNK_LEASE_EXPIRED',
            'Resume the upload from its committed offset.',
          );
        await tx.query(
          'UPDATE file_upload_sessions SET received_bytes=$3 WHERE workspace_id=$1 AND file_id=$2 AND received_bytes=$4',
          [p.workspaceId, id, offset + body.length, offset],
        );
      });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    return this.status(p, id);
  }
  async complete(p: Identity, id: string, signal: AbortSignal) {
    const state = await this.status(p, id);
    if (state.complete) return this.files.metadata(p, id);
    if (state.offset !== state.size)
      throw new AppError(409, 'UPLOAD_INCOMPLETE', 'Upload all chunks before finalizing.');
    const chunks = await this.db.query(
      "SELECT object_key,size,sha256 FROM file_upload_chunks WHERE workspace_id=$1 AND file_id=$2 AND state='complete' ORDER BY offset_bytes",
      [p.workspaceId, id],
    );
    const store = this.files.dependencies.store;
    const uploaded = await this.files.upload(
      p,
      id,
      async () => ({
        stream: Readable.from(
          (async function* () {
            for (const chunk of chunks) {
              signal.throwIfAborted();
              const body = await store.get(String(chunk.object_key));
              const hash = createHash('sha256');
              let size = 0;
              try {
                for await (const value of body) {
                  const bytes = Buffer.from(value);
                  size += bytes.length;
                  hash.update(bytes);
                  yield bytes;
                }
                if (size !== Number(chunk.size) || hash.digest('hex') !== chunk.sha256)
                  throw new AppError(400, 'CHUNK_INTEGRITY', 'Stored chunk integrity failed.');
              } finally {
                body.destroy();
              }
            }
          })(),
        ),
        truncated: () => false,
        complete: async () => {},
      }),
      signal,
    );
    await this.db.query(
      'UPDATE file_upload_sessions SET completed_at=now() WHERE workspace_id=$1 AND file_id=$2',
      [p.workspaceId, id],
    );
    return uploaded;
  }
}
