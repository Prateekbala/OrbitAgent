import type { CallMedia } from '../calls/provider.js';
import { randomUUID, createPublicKey, verify } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  identityScope,
  erasureScope,
  scopedDatabase,
  accountSessionId,
  type Database,
} from '@ao/database';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import { AppError } from '../lib/errors.js';
import { verifyPassword } from '../lib/security.js';
import type { FileStore } from '../files/storage.js';
export const organizationErasureInput = z
  .object({
    requestKey: z.uuid(),
    confirmation: z.string().min(2).max(80),
    password: z.string().max(1024).default(''),
    reason: z.string().trim().min(20).max(1000),
  })
  .strict();
export class OrganizationErasureService {
  constructor(private db: Database) {}
  async status(org: string, account: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, account, true);
      const [row] = await this.db.query(
        'SELECT id,state,database_deleted_at,storage_deleted_at,backup_not_before,error_code,created_at,completed_at FROM organization_erasures WHERE organization_id=$1',
        [org],
      );
      return row ?? null;
    });
  }
  async request(org: string, account: string, input: z.infer<typeof organizationErasureInput>) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, account, true, true);
        if (actor.role !== 'owner')
          throw new AppError(403, 'OWNER_REQUIRED', 'An organization owner must request deletion.');
        const [profile] = await tx.query('SELECT password_hash FROM accounts WHERE id=$1', [
          account,
        ]);
        const [federated] = await tx.query(
          "SELECT EXISTS(SELECT 1 FROM sessions s JOIN identity_providers p ON p.id=s.provider_id JOIN federated_identities f ON f.provider_id=p.id AND f.account_id=s.account_id WHERE s.id=$1 AND s.account_id=$2 AND p.organization_id=$3 AND p.enabled AND s.authentication_method IN ('oidc','saml') AND s.created_at>now()-interval '5 minutes') valid",
          [accountSessionId(), account, org],
        );
        const passwordValid =
          profile && input.password
            ? await verifyPassword(input.password, String(profile.password_hash))
            : false;
        if (!passwordValid && !federated?.valid)
          throw new AppError(
            403,
            'REAUTHENTICATION_REQUIRED',
            'Confirm your current password or complete organization SSO within five minutes before deletion.',
          );
        const [prior] = await tx.query(
          'SELECT id,request_key FROM organization_erasures WHERE organization_id=$1',
          [org],
        );
        if (prior) {
          if (prior.request_key !== input.requestKey)
            throw new AppError(
              409,
              'ERASURE_EXISTS',
              'This organization already has a deletion request.',
            );
          return { id: prior.id, replayed: true };
        }
        if (input.confirmation !== actor.name)
          throw new AppError(400, 'CONFIRMATION_MISMATCH', 'Type the organization name exactly.');
        const workspaces = await tx.query('SELECT id FROM lock_governance_workspaces($1)', [org]);
        const [policy] = await tx.query(
          "SELECT coalesce((policy->>'backupMaxDays')::integer,35) days FROM governance_policies WHERE organization_id=$1",
          [org],
        );
        await tx.query('UPDATE organizations SET version=version+1 WHERE id=$1', [org]);
        await tx.query(
          'UPDATE scim_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE organization_id=$1',
          [org],
        );
        await tx.query(
          'UPDATE support_grants SET revoked_at=coalesce(revoked_at,now()) WHERE organization_id=$1',
          [org],
        );
        await tx.query(
          "UPDATE organization_model_keys SET sealed_key='',revoked_at=coalesce(revoked_at,now()),generation=generation+1 WHERE organization_id=$1 AND revoked_at IS NULL",
          [org],
        );
        await tx.query(
          "UPDATE shared_channel_grants SET state='revoked',revoked_at=coalesce(revoked_at,now()),version=version+1 WHERE (organization_id=$1 OR host_organization_id=$1) AND state<>'revoked'",
          [org],
        );
        const id = randomUUID();
        await tx.query(
          'INSERT INTO organization_erasures(id,organization_id,request_key,requested_by,reason,workspace_ids,backup_not_before) VALUES($1,$2,$3,$4,$5,$6,now()+$7::interval)',
          [
            id,
            org,
            input.requestKey,
            account,
            input.reason,
            workspaces.map((w) => w.id),
            (policy?.days ?? 35) + ' days',
          ],
        );
        await organizationAudit(tx, org, account, 'organization.erasure_requested', id);
        return { id, replayed: false };
      }),
    );
  }
}
const inventoryItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('object'),
    workspaceId: z.uuid(),
    provider: z.string(),
    key: z.string(),
    done: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('media'),
    workspaceId: z.uuid(),
    key: z.string(),
    done: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('runtime'), workspaceId: z.uuid(), sessionId: z.string() }),
  z.object({
    kind: z.literal('room'),
    workspaceId: z.uuid(),
    roomName: z.string(),
    done: z.boolean().optional(),
  }),
]);
export class OrganizationErasureWorker {
  private db: Database;
  private pending: Promise<void> | undefined;
  constructor(
    db: Database,
    private files?: FileStore,
    private recordings?: string,
    private onError: (code: string) => void = () => {},
    private media?: CallMedia,
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    return (this.pending ??= this.process().finally(() => {
      this.pending = undefined;
    }));
  }
  start() {
    const timer = setInterval(
      () => void this.tick().catch(() => this.onError('ORGANIZATION_ERASURE_FAILED')),
      30000,
    );
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
  private async process() {
    return erasureScope(async () => {
      const [job] = await this.db.query('SELECT * FROM claim_organization_erasure()');
      if (!job) return;
      try {
        const [prepared] = await this.db.query('SELECT prepare_organization_erasure($1,$2) value', [
          job.id,
          job.lease,
        ]);
        const data = prepared!.value as {
          held?: boolean;
          deferred?: boolean;
          manifest?: unknown;
          databaseDeleted?: boolean;
        };
        if (!data.held && !data.deferred && !data.databaseDeleted) {
          let processed = 0;
          const entries = z.array(inventoryItem).parse(data.manifest);
          for (const [index, item] of [...entries.entries()].sort(
            ([, a], [, b]) => Number(b.kind === 'room') - Number(a.kind === 'room'),
          )) {
            if (item.kind === 'runtime' || item.done) continue;
            if (processed >= 20) {
              await this.db.query('SELECT finish_organization_erasure($1,$2,false)', [
                job.id,
                job.lease,
              ]);
              return;
            }
            if (item.kind === 'room') {
              if (!this.media) throw new Error('Call media is unavailable.');
              for (const recording of await this.media.recordings(item.roomName))
                if (recording.state === 'active') await this.media.stopRecording(recording.id);
              await this.media.close(item.roomName);
            } else if (item.kind === 'object') {
              if (!this.files || this.files.id !== item.provider)
                throw new Error('Storage component unavailable.');
              if (!item.key.startsWith(item.workspaceId + '/'))
                throw new Error('Invalid storage namespace.');
              await this.files.delete(item.key);
            } else if (item.kind === 'media') {
              if (!this.recordings) throw new Error('Recording component unavailable.');
              const root = resolve(this.recordings),
                path = resolve(root, item.key);
              if (!path.startsWith(root + sep) || !/^[0-9a-f-]{36}\.mp4$/.test(item.key))
                throw new Error('Invalid recording namespace.');
              await rm(path, { force: true });
            }
            await this.db.query('SELECT acknowledge_organization_storage($1,$2,$3)', [
              job.id,
              job.lease,
              index,
            ]);
            processed++;
          }
          if (!this.files?.purgeWorkspace)
            throw new Error('Workspace storage erasure is unavailable.');
          for (const workspace of job.workspace_ids as string[])
            await this.files.purgeWorkspace(workspace, async () => {
              const [renewed] = await this.db.query(
                'SELECT renew_organization_erasure($1,$2) valid',
                [job.id, job.lease],
              );
              if (!renewed?.valid) throw new Error('Erasure lease expired.');
            });
          await this.db.query('SELECT acknowledge_organization_storage($1,$2)', [
            job.id,
            job.lease,
          ]);
          await this.db.query('SELECT purge_organization_database($1,$2)', [job.id, job.lease]);
        }
        await this.db.query('SELECT finish_organization_erasure($1,$2,false)', [job.id, job.lease]);
      } catch {
        this.onError('ORGANIZATION_ERASURE_COMPONENT_FAILED');
        await this.db.query('SELECT finish_organization_erasure($1,$2,true)', [job.id, job.lease]);
      }
    });
  }
}
const organizationReceipt = z
  .object({
    id: z.string().min(1).max(200),
    scope: z.literal('organization'),
    jobId: z.uuid(),
    processor: z.enum(['backup', 'runtime', 'provider']),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    completedAt: z.iso.datetime(),
  })
  .strict();
export async function ingestOrganizationReceipt(
  db: Database,
  payload: Buffer,
  signature: string,
  key: string,
) {
  if (
    payload.length > 8192 ||
    createPublicKey(key).asymmetricKeyType !== 'ed25519' ||
    !verify(null, payload, key, Buffer.from(signature, 'base64'))
  )
    throw new Error('Invalid deletion evidence signature.');
  const receipt = organizationReceipt.parse(JSON.parse(payload.toString()));
  return db.transaction(async (tx) => {
    const [job] = await tx.query('SELECT * FROM organization_erasures WHERE id=$1 FOR UPDATE', [
      receipt.jobId,
    ]);
    const at = Date.parse(receipt.completedAt);
    if (
      !job ||
      !job.database_deleted_at ||
      at < new Date(String(job.database_deleted_at)).getTime() ||
      at > Date.now() + 30000 ||
      at < new Date(String(job.created_at)).getTime() ||
      (receipt.processor === 'backup' && at < new Date(String(job.backup_not_before)).getTime())
    )
      throw new Error('Deletion evidence has an invalid completion time.');
    const [prior] = await tx.query(
      'SELECT evidence_hash FROM organization_erasure_receipts WHERE job_id=$1 AND processor=$2',
      [receipt.jobId, receipt.processor],
    );
    if (prior) {
      if (prior.evidence_hash !== receipt.evidenceHash)
        throw new Error('Conflicting deletion evidence.');
      return { replayed: true };
    }
    await tx.query(
      'INSERT INTO organization_erasure_receipts(id,job_id,processor,evidence_hash,signature,completed_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        receipt.id,
        receipt.jobId,
        receipt.processor,
        receipt.evidenceHash,
        signature,
        receipt.completedAt,
      ],
    );
    await tx.query('UPDATE organization_erasures SET available_at=now() WHERE id=$1', [
      receipt.jobId,
    ]);
    return { replayed: false };
  });
}
