import { randomUUID, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import {
  identityScope,
  dispatcherScope,
  workerScope,
  scopedDatabase,
  type Database,
} from '@ao/database';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest } from '../lib/security.js';
export const erasureInput = z
  .object({
    workspaceId: z.uuid(),
    kind: z.enum(['message', 'task', 'knowledge', 'file', 'transcript']),
    sourceId: z.uuid(),
    requestKey: z.uuid(),
    reason: z.string().trim().min(20).max(1000),
  })
  .strict();
export class LifecycleService {
  constructor(private readonly db: Database) {}
  async list(org: string, account: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, account, true);
      return this.db.query(
        'SELECT id,workspace_id,kind,source_id,state,attempts,error_code,required_receipts,receipt_after,created_at,completed_at FROM lifecycle_jobs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200',
        [org],
      );
    });
  }
  async request(org: string, account: string, input: z.infer<typeof erasureInput>) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, account, true, true);
        if (actor.role !== 'owner')
          throw new AppError(403, 'OWNER_REQUIRED', 'An owner must request governed erasure.');
        const [w] = await tx.query('SELECT id FROM lock_governance_workspaces($1,$2)', [
          org,
          input.workspaceId,
        ]);
        if (!w) throw notFound();
        const [prior] = await tx.query(
          'SELECT id,workspace_id,kind,source_id FROM lifecycle_jobs WHERE organization_id=$1 AND request_key=$2',
          [org, input.requestKey],
        );
        if (prior) {
          if (
            prior.workspace_id !== input.workspaceId ||
            prior.kind !== input.kind ||
            prior.source_id !== input.sourceId
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This request key names another source.',
            );
          return { id: prior.id, replayed: true };
        }
        const [source] = await tx.query('SELECT lifecycle_source($1,$2,$3) value', [
          input.workspaceId,
          input.kind,
          input.sourceId,
        ]);
        if (!source?.value) throw notFound();
        const [policy] = await tx.query(
          "SELECT coalesce((policy->>'backupMaxDays')::integer,35) days FROM governance_policies WHERE organization_id=$1",
          [org],
        );
        const [row] = await tx.query(
          'INSERT INTO lifecycle_jobs(organization_id,workspace_id,kind,source_id,request_key,requested_by,reason,receipt_after) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8::interval) ON CONFLICT(workspace_id,kind,source_id) DO NOTHING RETURNING id',
          [
            org,
            input.workspaceId,
            input.kind,
            input.sourceId,
            input.requestKey,
            account,
            input.reason,
            (policy?.days ?? 35) + ' days',
          ],
        );
        if (!row)
          throw new AppError(409, 'ERASURE_EXISTS', 'This source already has a deletion job.');
        await organizationAudit(tx, org, account, 'lifecycle.erasure_requested', String(row.id));
        return { id: row.id, replayed: false };
      }),
    );
  }
}
export class LifecycleWorker {
  private readonly db: Database;
  private pending: Promise<void> | undefined;
  constructor(
    db: Database,
    private readonly onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    if (this.pending) return this.pending;
    this.pending = this.process().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  start() {
    const timer = setInterval(
      () => void this.tick().catch(() => this.onError('LIFECYCLE_WORKER_FAILED')),
      30000,
    );
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
  private async process() {
    for (const w of await dispatcherScope(() => this.db.query('SELECT id FROM workspaces')))
      await workerScope(String(w.id), async () => {
        await this.db.query('SELECT queue_governed_retention($1)', [w.id]);
        const lease = randomUUID(),
          jobs = await this.db.query(
            "UPDATE lifecycle_jobs SET state='leased',lease=$2,lease_until=now()+interval '2 minutes',attempts=attempts+1 WHERE id IN(SELECT id FROM lifecycle_jobs WHERE workspace_id=$1 AND state IN ('pending','leased','held','waiting_storage','waiting_receipts') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 20) RETURNING id",
            [w.id, lease],
          );
        for (const job of jobs)
          try {
            const [result] = await this.db.query('SELECT erase_lifecycle_source($1,$2,$3) state', [
              w.id,
              job.id,
              lease,
            ]);
            await this.db.query(
              "UPDATE lifecycle_jobs SET state=$4,completed_at=CASE WHEN $4='completed' THEN now() END,lease=NULL,lease_until=NULL,available_at=now()+interval '5 minutes',error_code=NULL,failures=0 WHERE workspace_id=$1 AND id=$2 AND lease=$3",
              [w.id, job.id, lease, result!.state],
            );
          } catch {
            this.onError('LIFECYCLE_ERASURE_FAILED');
            await this.db.query(
              "UPDATE lifecycle_jobs SET state=CASE WHEN failures>=7 THEN 'dead' ELSE 'pending' END,failures=failures+1,error_code='ERASURE_FAILED',lease=NULL,lease_until=NULL,available_at=now()+interval '5 minutes' WHERE workspace_id=$1 AND id=$2 AND lease=$3",
              [w.id, job.id, lease],
            );
          }
      });
  }
}
const deletionReceipt = z
  .object({
    id: z.string().min(1).max(200),
    jobId: z.uuid(),
    processor: z.enum(['backup', 'runtime', 'provider', 'derived']),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    completedAt: z.iso.datetime(),
  })
  .strict();
export async function ingestDeletionReceipt(
  db: Database,
  payload: Buffer,
  signature: string,
  publicKey: string,
) {
  if (
    payload.length > 8192 ||
    createPublicKey(publicKey).asymmetricKeyType !== 'ed25519' ||
    !verify(null, payload, publicKey, Buffer.from(signature, 'base64'))
  )
    throw new Error('Invalid deletion evidence signature.');
  const receipt = deletionReceipt.parse(JSON.parse(payload.toString('utf8')));
  return db.transaction(async (tx) => {
    const [job] = await tx.query('SELECT * FROM lifecycle_jobs WHERE id=$1 FOR UPDATE', [
      receipt.jobId,
    ]);
    if (!job) throw new Error('Unknown deletion job.');
    const time = Date.parse(receipt.completedAt);
    if (
      time > Date.now() + 30000 ||
      (receipt.processor === 'backup' && time < new Date(String(job.receipt_after)).getTime())
    )
      throw new Error('Deletion evidence predates the required expiry.');
    const [existing] = await tx.query(
      'SELECT evidence_hash FROM deletion_receipts WHERE job_id=$1 AND processor=$2',
      [receipt.jobId, receipt.processor],
    );
    if (existing) {
      if (existing.evidence_hash !== receipt.evidenceHash)
        throw new Error('Conflicting deletion evidence.');
      return { replayed: true };
    }
    await tx.query(
      'INSERT INTO deletion_receipts(id,job_id,processor,evidence_hash,signature) VALUES($1,$2,$3,$4,$5)',
      [receipt.id, receipt.jobId, receipt.processor, receipt.evidenceHash, signature],
    );
    await tx.query(
      "UPDATE lifecycle_jobs SET available_at=now() WHERE id=$1 AND state<>'completed'",
      [receipt.jobId],
    );
    return { replayed: false, receiptHash: digest(payload.toString('utf8')) };
  });
}
