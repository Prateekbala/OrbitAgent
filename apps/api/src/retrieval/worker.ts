import { randomUUID } from 'node:crypto';
import {
  scopedDatabase,
  dispatcherScope,
  workerScope,
  type Database,
  type Sql,
} from '@ao/database';
import type { SourceKind } from '@ao/contracts/retrieval';
import { chunks, terms } from './text.js';
interface Job extends Record<string, unknown> {
  workspace_id: string;
  kind: SourceKind;
  source_id: string;
  generation: number;
  lease: string;
}
interface Document extends Record<string, unknown> {
  version: number;
  title: string;
  body: string;
  language?: string;
  freshness?: string;
  conflict?: boolean;
}
export class RetrievalWorker {
  private busy = false;
  private active: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private db: Database,
    private onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  start(interval = 2000) {
    const timer = setInterval(() => {
      if (!this.busy && !this.stopped)
        this.active = this.tick().catch(() => this.onError('RETRIEVAL_WORKER_FAILED'));
    }, interval);
    timer.unref();
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      await this.active;
    };
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const tenants = await dispatcherScope(() =>
        this.db.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM retrieval_authority ORDER BY workspace_id',
        ),
      );
      for (const tenant of tenants)
        await workerScope(tenant.workspace_id, async () => {
          await this.db.query('DELETE FROM retrieval_contexts WHERE expires_at<=now()');
          await this.db.query(
            "DELETE FROM retrieval_answer_attempts WHERE created_at<now()-interval '30 days'",
          );
          await this.db.query(
            "UPDATE retrieval_answer_attempts SET state='failed',completed_at=now() WHERE state='reserved' AND lease_until<=now()",
          );
          await this.db.query(
            'DELETE FROM agent_memories WHERE expires_at<=now() OR deleted_at IS NOT NULL',
          );
          await this.db.query(
            'DELETE FROM retained_transcripts WHERE retained_until<=now() OR deleted_at IS NOT NULL',
          );
          for (let depth = 0; depth < 8; depth++) {
            const removed = await this.db.query(
              "DELETE FROM agent_memories m WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(m.sources) ref WHERE retrieval_source_version(m.workspace_id,ref->>'kind',(ref->>'id')::uuid) IS NULL) RETURNING id",
            );
            if (!removed.length) break;
          }
          await this.db.query(
            'DELETE FROM connection_resources WHERE retained_until<=now() OR deleted_at IS NOT NULL',
          );
          await this.db.query(
            "DELETE FROM file_extractions e WHERE EXISTS(SELECT 1 FROM files f WHERE f.workspace_id=e.workspace_id AND f.id=e.file_id AND f.status IN ('deleted','deleting','rejected'))",
          );
          await this.db.query(
            "DELETE FROM retrieval_metrics WHERE created_at<now()-interval '30 days'",
          );
          const [sweep] = await this.db.query(
            "UPDATE retrieval_authority SET next_orphan_sweep=now()+interval '1 minute' WHERE workspace_id=$1 AND next_orphan_sweep<=now() RETURNING workspace_id",
            [tenant.workspace_id],
          );
          if (sweep)
            await this.db.query(
              'DELETE FROM retrieval_documents d WHERE retrieval_source_version(workspace_id,kind,source_id) IS NULL',
            );
          for (let slot = 0; slot < 20 && !this.stopped; slot++) {
            const [job] = await this.db.query<Job>(
              `WITH candidates AS (SELECT workspace_id,kind,source_id FROM retrieval_jobs WHERE available_at<=now() AND (state='pending' OR state='leased' AND lease_until<now()) ORDER BY available_at,source_id LIMIT 1 FOR UPDATE SKIP LOCKED)
          UPDATE retrieval_jobs j SET state='leased',lease=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1 FROM candidates c WHERE j.workspace_id=c.workspace_id AND j.kind=c.kind AND j.source_id=c.source_id RETURNING j.*`,
              [randomUUID()],
            );
            if (!job) break;
            try {
              await this.db.transaction((tx) => this.index(tx, job));
            } catch {
              await this.db.query(
                "UPDATE retrieval_jobs SET state=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,error_code='INDEX_FAILED',available_at=now()+interval '30 seconds' WHERE workspace_id=$1 AND kind=$2 AND source_id=$3 AND generation=$4 AND lease=$5",
                [job.workspace_id, job.kind, job.source_id, job.generation, job.lease],
              );
            }
          }
        });
    } finally {
      this.busy = false;
    }
  }
  private async index(tx: Sql, job: Job) {
    const params = [job.workspace_id, job.source_id];
    const queries: Record<SourceKind, string> = {
      message:
        "SELECT version,'' title,body FROM messages WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL",
      task: 'SELECT version,title,description body FROM tasks WHERE workspace_id=$1 AND id=$2',
      knowledge:
        "SELECT p.version,p.title,p.body,CASE WHEN m.review_state='stale' OR m.fresh_until<now() THEN 'stale' ELSE 'current' END freshness,m.review_state='contradicted' conflict FROM knowledge_pages p JOIN knowledge_metadata m ON m.workspace_id=p.workspace_id AND m.page_id=p.id WHERE p.workspace_id=$1 AND p.id=$2 AND m.state='active' AND NOT m.blocked AND m.superseded_by IS NULL",
      file: "SELECT e.version,f.name title,e.body FROM files f JOIN file_extractions e ON e.workspace_id=f.workspace_id AND e.file_id=f.id AND e.sha256=f.sha256 WHERE f.workspace_id=$1 AND f.id=$2 AND f.status='attached' AND f.scan_status IN ('clean','development_only')",
      document:
        "SELECT r.version,r.title,r.body,r.language,CASE WHEN r.fetched_at<now()-interval '24 hours' THEN 'stale' ELSE 'current' END freshness FROM connection_resources r JOIN connections c ON c.workspace_id=r.workspace_id AND c.id=r.connection_id WHERE r.workspace_id=$1 AND r.id=$2 AND r.deleted_at IS NULL AND r.retained_until>now() AND c.state='connected'",
      transcript:
        'SELECT version,title,body,language FROM retained_transcripts WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL AND retained_until>now()',
      memory:
        'SELECT version,title,body FROM agent_memories WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL AND expires_at>now()',
    };
    const [locked] = await tx.query(
      'SELECT generation FROM retrieval_jobs WHERE workspace_id=$1 AND kind=$2 AND source_id=$3 AND generation=$4 AND lease=$5 AND lease_until>now() FOR UPDATE',
      [job.workspace_id, job.kind, job.source_id, job.generation, job.lease],
    );
    if (!locked) return;
    const [doc] = await tx.query<Document>(queries[job.kind], params);
    await tx.query(
      'DELETE FROM retrieval_documents WHERE workspace_id=$1 AND kind=$2 AND source_id=$3',
      [job.workspace_id, job.kind, job.source_id],
    );
    if (doc) {
      await tx.query(
        'INSERT INTO retrieval_documents(workspace_id,kind,source_id,source_version,title,body,language,freshness,conflict) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          job.workspace_id,
          job.kind,
          job.source_id,
          doc.version,
          doc.title,
          doc.body,
          doc.language ?? 'und',
          doc.freshness ?? 'current',
          doc.conflict ?? false,
        ],
      );
      const fragments = chunks(doc.title + '\n' + doc.body);
      for (const [ordinal, body] of fragments.entries())
        await tx.query(
          "INSERT INTO retrieval_chunks(workspace_id,kind,source_id,ordinal,body,terms) VALUES($1,$2,$3,$4,$5,to_tsvector('simple',$6))",
          [job.workspace_id, job.kind, job.source_id, ordinal, body, terms(body).join(' ')],
        );
    }
    await tx.query(
      "UPDATE retrieval_jobs SET state='completed',lease=NULL,lease_until=NULL,error_code=NULL,updated_at=now() WHERE workspace_id=$1 AND kind=$2 AND source_id=$3 AND generation=$4 AND lease=$5",
      [job.workspace_id, job.kind, job.source_id, job.generation, job.lease],
    );
  }
}
