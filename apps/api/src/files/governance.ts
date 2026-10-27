import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { type Database, type Sql } from '@ao/database';
import { dlpPolicy, fileVersionInput, fileShareInput } from '@ao/contracts/file-governance';
import { lockAdministrator, requireActiveMember, type Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { token, digest } from '../lib/security.js';
import { FileService, fileAuthority } from './service.js';
import { currentDlp, requireDlp } from './dlp.js';
const fields =
  'name,size,sha256,content_type,object_key,preview_key,storage_provider,dlp_status,dlp_policy_version,dlp_findings';
export class FileGovernance {
  constructor(
    private readonly db: Database,
    private readonly files: FileService,
  ) {}
  async policy(p: Identity, input?: z.infer<typeof dlpPolicy>) {
    if (!input) return currentDlp(this.db, p.workspaceId);
    return this.db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'workspace.manage');
      const before = await currentDlp(tx, p.workspaceId);
      if (input.version !== before.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'Refresh the data policy before saving.');
      const [plan] = await tx.query('SELECT commercial_plan($1) value', [p.workspaceId]);
      if (input.enabled && !(plan?.value as { features?: { dlp?: boolean } })?.features?.dlp)
        throw new AppError(
          403,
          'ENTITLEMENT_REQUIRED',
          'The current plan does not include data inspection.',
        );
      const next = { ...input, version: input.version + 1 };
      await tx.query(
        'INSERT INTO file_dlp_policies(workspace_id,version,policy,updated_by) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(workspace_id) DO UPDATE SET version=EXCLUDED.version,policy=EXCLUDED.policy,updated_by=EXCLUDED.updated_by,updated_at=now()',
        [p.workspaceId, next.version, JSON.stringify(next), p.membershipId],
      );
      await tx.query(
        "INSERT INTO audit_events(id,workspace_id,actor_id,action,resource_id) VALUES(gen_random_uuid(),$1,$2,'files.policy_changed',$1)",
        [p.workspaceId, p.membershipId],
      );
      return next;
    });
  }
  async versions(p: Identity, id: string) {
    await this.files.inspect(p, id);
    return this.db.query(
      'SELECT version,name,size,sha256,content_type,added_by,created_at,dlp_status FROM file_versions WHERE workspace_id=$1 AND file_id=$2 ORDER BY version DESC LIMIT 100',
      [p.workspaceId, id],
    );
  }
  async version(p: Identity, id: string, version: number): Promise<Record<string, unknown>> {
    const root = await this.files.inspect(p, id);
    const file =
      Number(root.version) === version
        ? root
        : (
            await this.db.query(
              'SELECT * FROM file_versions WHERE workspace_id=$1 AND file_id=$2 AND version=$3',
              [p.workspaceId, id, version],
            )
          )[0];
    if (!file) throw notFound();
    await requireDlp(this.db, p.workspaceId, file);
    return { ...root, ...file, id };
  }
  private async editable(tx: Sql, p: Identity, id: string) {
    const [root] = await tx.query(
      "SELECT * FROM files WHERE workspace_id=$1 AND id=$2 AND status='attached' AND promoted_to IS NULL FOR UPDATE",
      [p.workspaceId, id],
    );
    if (!root) throw notFound();
    await fileAuthority(tx, p, root);
    if (root.uploader_id !== p.membershipId && !['owner', 'admin'].includes(p.role))
      throw new AppError(
        403,
        'FILE_OWNER_REQUIRED',
        'Only the uploader or an administrator can publish file versions.',
      );
    return root;
  }
  async promote(p: Identity, id: string, input: z.infer<typeof fileVersionInput>) {
    await this.files.inspect(p, id);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const root = await this.editable(tx, p, id);
      const [prior] = await tx.query(
        'SELECT version,successor_id FROM file_versions WHERE workspace_id=$1 AND file_id=$2 AND client_id=$3',
        [p.workspaceId, id, input.clientId],
      );
      if (prior) {
        if (prior.successor_id !== input.fileId)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This version request has different content.',
          );
        return { version: Number(prior.version) + 1 };
      }
      if (root.version !== input.expectedVersion)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Refresh the file before publishing a new version.',
        );
      if (Number(root.version) >= 100)
        throw new AppError(409, 'VERSION_LIMIT', 'This file has reached its version limit.');
      const [child] = await tx.query(
        "SELECT * FROM files WHERE workspace_id=$1 AND id=$2 AND uploader_id=$3 AND status='ready' AND expires_at>now() AND promoted_to IS NULL FOR UPDATE",
        [p.workspaceId, input.fileId, p.membershipId],
      );
      if (
        !child ||
        child.conversation_id !== root.conversation_id ||
        child.task_id !== root.task_id ||
        child.storage_provider !== root.storage_provider ||
        root.id === child.id
      )
        throw new AppError(
          400,
          'INVALID_VERSION',
          'Upload a ready file into the same conversation or task.',
        );
      await requireDlp(tx, p.workspaceId, child);
      await tx.query(
        `INSERT INTO file_versions(workspace_id,file_id,version,added_by,client_id,successor_id,${fields}) SELECT workspace_id,id,version,$3,$4,$5,${fields} FROM files WHERE workspace_id=$1 AND id=$2`,
        [p.workspaceId, id, p.membershipId, input.clientId, input.fileId],
      );
      await tx.query(
        "UPDATE files SET object_key=$3,preview_key=NULL,status='deleted',promoted_to=$4,reserved_bytes=0,purged_at=now(),cleanup_after='infinity' WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, child.id, `${p.workspaceId}/${child.id}/promoted`, id],
      );
      await tx.query(
        `UPDATE files SET version=version+1,reserved_bytes=reserved_bytes+$3,${fields
          .split(',')
          .filter((f) => f !== 'reserved_bytes')
          .map((f, i) => `${f}=$${i + 4}${f === 'dlp_findings' ? '::jsonb' : ''}`)
          .join(',')} WHERE workspace_id=$1 AND id=$2`,
        [
          p.workspaceId,
          id,
          child.reserved_bytes,
          ...fields
            .split(',')
            .map((f) => (f === 'dlp_findings' ? JSON.stringify(child[f]) : child[f])),
        ],
      );
      await tx.query(
        "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id) VALUES($1,'file.version_published',$2,$3)",
        [p.workspaceId, id, root.conversation_id],
      );
      return { version: Number(root.version) + 1 };
    });
  }
  async share(p: Identity, id: string, input: z.infer<typeof fileShareInput>) {
    const file = await this.files.inspect(p, id, true),
      policy = await currentDlp(this.db, p.workspaceId);
    if (!policy.sharing || input.expiresInHours > policy.maxShareHours)
      throw new AppError(
        403,
        'SHARING_DISABLED',
        'The workspace sharing policy does not allow this link.',
      );
    if (
      file.status !== 'attached' ||
      (file.uploader_id !== p.membershipId && !['owner', 'admin'].includes(p.role))
    )
      throw new AppError(
        403,
        'FILE_OWNER_REQUIRED',
        'Only the uploader or an administrator can share attached files.',
      );
    const value = token(),
      share = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      const current = await this.editable(tx, p, id),
        currentPolicy = await currentDlp(tx, p.workspaceId);
      await requireDlp(tx, p.workspaceId, current);
      if (
        !currentPolicy.sharing ||
        input.expiresInHours > currentPolicy.maxShareHours ||
        current.version !== file.version
      )
        throw new AppError(
          409,
          'SHARE_POLICY_CHANGED',
          'Refresh this file and its sharing policy.',
        );
      for (const recipient of new Set(input.recipientIds))
        await requireActiveMember(tx, p, recipient);
      await tx.query(
        'INSERT INTO file_shares(id,workspace_id,file_id,file_version,created_by,token_hash,recipients,expires_at,max_downloads) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8::interval,$9)',
        [
          share,
          p.workspaceId,
          id,
          file.version,
          p.membershipId,
          digest(value),
          [...new Set(input.recipientIds)],
          input.expiresInHours + ' hours',
          input.maxDownloads,
        ],
      );
    });
    return { id: share, path: `/app#share=${share}.${value}` };
  }
  async shares(p: Identity, id: string) {
    await this.files.inspect(p, id);
    return this.db.query(
      'SELECT id,file_version,recipients,expires_at,max_downloads,downloads,revoked_at FROM file_shares WHERE workspace_id=$1 AND file_id=$2 AND created_by=$3 ORDER BY created_at DESC LIMIT 100',
      [p.workspaceId, id, p.membershipId],
    );
  }
  async revoke(p: Identity, id: string, share: string) {
    const rows = await this.db.query(
      'UPDATE file_shares SET revoked_at=now() WHERE workspace_id=$1 AND file_id=$2 AND id=$3 AND created_by=$4 RETURNING id',
      [p.workspaceId, id, share, p.membershipId],
    );
    if (!rows.length) throw notFound();
    return { ok: true };
  }
  async resolve(p: Identity, id: string, proof: string, consume = false) {
    return this.db.transaction(async (tx) => {
      const [share] = await tx.query(
        `SELECT s.* FROM file_shares s WHERE s.workspace_id=$1 AND s.id=$2 AND s.token_hash=$3 AND $4=ANY(s.recipients) AND s.revoked_at IS NULL AND s.expires_at>now() AND s.downloads<s.max_downloads AND file_share_creator_current(s.workspace_id,s.created_by,s.file_id)${consume ? ' FOR UPDATE' : ''}`,
        [p.workspaceId, id, digest(proof), p.membershipId],
      );
      if (!share) throw notFound();
      if (!(await currentDlp(tx, p.workspaceId)).sharing) throw notFound();
      const fileService = new FileService(
        { ...this.db, query: tx.query, transaction: async (work) => work(tx) },
        this.files.dependencies,
      );
      const root = await fileService.inspect(p, String(share.file_id), true);
      const file =
        Number(root.version) === Number(share.file_version)
          ? root
          : (
              await tx.query(
                'SELECT * FROM file_versions WHERE workspace_id=$1 AND file_id=$2 AND version=$3',
                [p.workspaceId, root.id, share.file_version],
              )
            )[0];
      if (!file) throw notFound();
      await requireDlp(tx, p.workspaceId, file);
      if (consume) {
        const [result] = await tx.query('SELECT consume_file_share($1,$2,$3) consumed', [
          p.workspaceId,
          id,
          digest(proof),
        ]);
        if (!result?.consumed) throw notFound();
      }
      return file;
    });
  }
}
