import { randomUUID } from 'node:crypto';
import {
  dispatcherScope,
  scopedDatabase,
  workerScope,
  type Database,
  type Sql,
} from '@ao/database';
import type { SourceKind } from '@ao/contracts/retrieval';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { requireSources, type Embeddings } from './service.js';
import { assertVectors } from './text.js';
interface EmbeddingJob extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  member_id: string;
  credential_id: string | null;
  kind: SourceKind;
  source_id: string;
  source_version: number;
  epoch: string;
  model: string;
  auth_version: number | null;
  policy_version: number;
  lease: string;
  next_ordinal: number;
}
export class EmbeddingWorker {
  private busy = false;
  private stopped = false;
  private active: Promise<void> | undefined;
  constructor(
    private db: Database,
    private embeddings: Embeddings,
    private onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  start(interval = 3000) {
    const timer = setInterval(() => {
      if (!this.busy && !this.stopped)
        this.active = this.tick().catch(() => this.onError('EMBEDDING_WORKER_FAILED'));
    }, interval);
    timer.unref();
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      await this.active;
    };
  }
  private async authorize(tx: Sql, job: EmbeddingJob) {
    const [epoch] = await tx.query('SELECT epoch FROM retrieval_authority WHERE workspace_id=$1', [
      job.workspace_id,
    ]);
    const [member] = await tx.query(
      "SELECT * FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND access_type='member'",
      [job.workspace_id, job.member_id],
    );
    const [policy] = await tx.query(
      'SELECT workspace_policy_version($1) version,retrieval_principal_current($1,$2) allowed',
      [job.workspace_id, job.member_id],
    );
    if (
      !member ||
      !policy?.allowed ||
      Number(policy.version) !== job.policy_version ||
      String(epoch?.epoch) !== String(job.epoch) ||
      job.model !== this.embeddings.model
    )
      throw new AppError(
        409,
        'EMBEDDING_AUTHORITY_CHANGED',
        'The embedding request requires renewed authorization.',
      );
    if (member.kind === 'human') {
      const [authority] = await tx.query('SELECT * FROM member_account_authority($1,$2)', [
        job.workspace_id,
        job.member_id,
      ]);
      if (!authority?.verified || Number(authority.auth_version) !== job.auth_version)
        throw new AppError(409, 'EMBEDDING_AUTHORITY_CHANGED', 'The account is unavailable.');
    }
    if (job.credential_id) {
      const [credential] = await tx.query(
        "SELECT id FROM agent_credentials WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>now() AND 'search.read'=ANY(scopes)",
        [job.workspace_id, job.credential_id],
      );
      if (!credential)
        throw new AppError(
          409,
          'EMBEDDING_AUTHORITY_CHANGED',
          'The credential is no longer valid.',
        );
    }
    const p: Identity = {
      workspaceId: job.workspace_id,
      membershipId: job.member_id,
      kind: member.kind as Identity['kind'],
      role: member.role as Identity['role'],
      name: String(member.name),
      accessType: 'member',
      permissions: member.permissions as NonNullable<Identity['permissions']>,
    };
    await tx.query(
      "SELECT set_config('ao.membership_id',$1,true),set_config('ao.access_type','member',true),set_config('ao.agent_credential_id',$2,true)",
      [job.member_id, job.credential_id ?? ''],
    );
    await tx.query('SET LOCAL ROLE ao_runtime');
    await requireSources(tx, p, [
      { kind: job.kind, id: job.source_id, version: job.source_version },
    ]);
    return p;
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const tenant of await dispatcherScope(() =>
        this.db.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM retrieval_authority ORDER BY workspace_id',
        ),
      )) {
        if (this.stopped) break;
        await workerScope(tenant.workspace_id, async () => {
          await this.db.query(
            "UPDATE retrieval_embedding_jobs SET state='dead',error_code='REQUEST_EXPIRED',lease=NULL,lease_until=NULL WHERE state IN ('pending','leased') AND expires_at<=now()",
          );
          await this.db.query(
            "DELETE FROM retrieval_embedding_jobs WHERE created_at<now()-interval '7 days'",
          );
          const [job] = await this.db.query<EmbeddingJob>(
            `WITH due AS(SELECT id FROM retrieval_embedding_jobs WHERE expires_at>now() AND model=$2 AND available_at<=now() AND (state='pending' OR state='leased' AND lease_until<now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE retrieval_embedding_jobs j SET state='leased',lease=$1,lease_until=now()+interval '45 seconds',attempts=attempts+1 FROM due WHERE j.id=due.id RETURNING j.*`,
            [randomUUID(), this.embeddings.model],
          );
          if (!job) return;
          try {
            const rows = await this.db.transaction(async (tx) => {
              await this.authorize(tx, job);
              return tx.query<{ ordinal: number; body: string }>(
                'SELECT c.ordinal,c.body FROM retrieval_chunks c JOIN retrieval_documents d USING(workspace_id,kind,source_id) WHERE c.workspace_id=$1 AND c.kind=$2 AND c.source_id=$3 AND d.source_version=$4 AND c.ordinal>=$5 ORDER BY c.ordinal LIMIT 16',
                [job.workspace_id, job.kind, job.source_id, job.source_version, job.next_ordinal],
              );
            });
            if (!rows.length) {
              await this.db.query(
                "UPDATE retrieval_embedding_jobs SET state='completed',lease=NULL,lease_until=NULL,error_code=NULL WHERE workspace_id=$1 AND id=$2 AND lease=$3",
                [job.workspace_id, job.id, job.lease],
              );
              return;
            }
            const vectors = await this.embeddings.embed(
              rows.map((r) => r.body),
              AbortSignal.timeout(20000),
            );
            assertVectors(vectors, rows.length);
            await this.db.transaction(async (tx) => {
              await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [job.workspace_id]);
              const [current] = await tx.query(
                "SELECT id FROM retrieval_embedding_jobs WHERE workspace_id=$1 AND id=$2 AND lease=$3 AND lease_until>now() AND state='leased' FOR UPDATE",
                [job.workspace_id, job.id, job.lease],
              );
              if (!current) return;
              await this.authorize(tx, job);
              await tx.query('SET LOCAL ROLE ao_worker');
              for (const [i, row] of rows.entries())
                await tx.query(
                  'UPDATE retrieval_chunks c SET embedding=$5,embedding_model=$6 FROM retrieval_documents d WHERE c.workspace_id=$1 AND c.kind=$2 AND c.source_id=$3 AND c.ordinal=$4 AND d.workspace_id=c.workspace_id AND d.kind=c.kind AND d.source_id=c.source_id AND d.source_version=$7',
                  [
                    job.workspace_id,
                    job.kind,
                    job.source_id,
                    row.ordinal,
                    vectors[i],
                    job.model,
                    job.source_version,
                  ],
                );
              await tx.query(
                "UPDATE retrieval_embedding_jobs SET state=CASE WHEN $4<16 THEN 'completed' ELSE 'pending' END,next_ordinal=$5,attempts=0,lease=NULL,lease_until=NULL,error_code=NULL,available_at=now() WHERE workspace_id=$1 AND id=$2 AND lease=$3",
                [job.workspace_id, job.id, job.lease, rows.length, rows.at(-1)!.ordinal + 1],
              );
            });
          } catch (error) {
            const code = error instanceof AppError ? error.code : 'EMBEDDING_PROVIDER_FAILED';
            await this.db.query(
              "UPDATE retrieval_embedding_jobs SET state=CASE WHEN attempts>=5 OR $4 IN ('EMBEDDING_AUTHORITY_CHANGED','EVIDENCE_UNAVAILABLE') THEN 'dead' ELSE 'pending' END,error_code=$4,lease=NULL,lease_until=NULL,available_at=now()+interval '30 seconds' WHERE workspace_id=$1 AND id=$2 AND lease=$3",
              [job.workspace_id, job.id, job.lease, code],
            );
          }
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
