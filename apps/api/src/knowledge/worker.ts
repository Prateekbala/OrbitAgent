import { scopedDatabase, dispatcherScope, workerScope, type Database } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { knowledgePage, sourcePage } from './access.js';
import { recordChange } from '../lib/events.js';
export class KnowledgeWorker {
  private busy = false;
  private stopped = false;
  private active: Promise<void> | null = null;
  constructor(
    private db: Database,
    private onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  start() {
    const timer = setInterval(() => {
      if (!this.busy && !this.stopped)
        this.active = this.tick().catch(() => this.onError('KNOWLEDGE_WORKER_FAILED'));
    }, 15000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      this.stopped = true;
      await this.active;
    };
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const workspace of await dispatcherScope(() =>
        this.db.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id'),
      )) {
        if (this.stopped) break;
        await workerScope(workspace.id, async () => {
          await this.db.query(
            "UPDATE knowledge_metadata SET review_state='stale',version=version+1 WHERE state='active' AND fresh_until<now() AND review_state NOT IN ('stale','contradicted')",
          );
          const schedules = await this.db.query<{ page_id: string } & Record<string, unknown>>(
            'SELECT page_id FROM knowledge_schedules WHERE enabled AND next_at<=now() ORDER BY next_at LIMIT 20',
          );
          for (const schedule of schedules)
            await this.db.transaction(async (tx) => {
              await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace.id]);
              const [job] = await tx.query(
                'SELECT * FROM knowledge_schedules WHERE workspace_id=$1 AND page_id=$2 AND enabled AND next_at<=now() FOR UPDATE',
                [workspace.id, schedule.page_id],
              );
              if (!job) return;
              const [member] = await tx.query(
                "SELECT * FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND kind='human' AND access_type='member' AND coalesce((permissions->>'knowledge.read')::boolean,true) AND coalesce((permissions->>'knowledge.write')::boolean,true)",
                [workspace.id, job.owner_id],
              );
              const [authority] = member
                ? await tx.query('SELECT * FROM public.member_account_authority($1,$2)', [
                    workspace.id,
                    member.id,
                  ])
                : [];
              let failure = '';
              if (!member || !authority?.verified) failure = 'OWNER_UNAVAILABLE';
              else {
                const p: Identity = {
                  workspaceId: workspace.id,
                  membershipId: String(member.id),
                  name: String(member.name),
                  kind: 'human',
                  role: member.role as Identity['role'],
                };
                const [visible] = await tx.query(
                  'SELECT resource_visible_to($1,k.conversation_id,k.created_at,$3) allowed FROM knowledge_pages k WHERE k.workspace_id=$1 AND k.id=$2',
                  [workspace.id, job.page_id, p.membershipId],
                );
                if (!visible?.allowed) failure = 'OWNER_ACCESS_REVOKED';
                else {
                  const page = await knowledgePage(tx, p, String(job.page_id));
                  if (page.state !== 'active' || page.owner_id !== p.membershipId)
                    failure = 'PAGE_UNAVAILABLE';
                  else if (
                    !(
                      await tx.query(
                        "SELECT id FROM knowledge_proposals WHERE workspace_id=$1 AND page_id=$2 AND status='pending'",
                        [workspace.id, page.id],
                      )
                    ).length
                  ) {
                    const sources: { id: string; version: number }[] = [];
                    const sections: string[] = [];
                    for (const id of job.source_ids as string[]) {
                      const [access] = await tx.query(
                        'SELECT resource_visible_to($1,conversation_id,created_at,$3) allowed FROM knowledge_pages WHERE workspace_id=$1 AND id=$2',
                        [workspace.id, id, p.membershipId],
                      );
                      if (!access?.allowed) {
                        failure = 'SOURCE_ACCESS_REVOKED';
                        break;
                      }
                      try {
                        const source = await sourcePage(tx, p, page, id);
                        sources.push({ id: source.id, version: source.version });
                        sections.push(
                          '## ' +
                            source.title.replace(/[\r\n]/g, ' ') +
                            '\n\n' +
                            source.body.slice(0, 1800) +
                            '\n\nSource: page ' +
                            source.id +
                            ' · version ' +
                            source.version,
                        );
                      } catch {
                        failure = 'SOURCE_UNAVAILABLE';
                        break;
                      }
                    }
                    if (!failure) {
                      await tx.query(
                        'INSERT INTO knowledge_proposals(workspace_id,page_id,base_version,title,body,sources) VALUES($1,$2,$3,$4,$5,$6)',
                        [
                          workspace.id,
                          page.id,
                          page.version,
                          page.title,
                          '# Source digest\n\n' + sections.join('\n\n'),
                          JSON.stringify(sources),
                        ],
                      );
                      await recordChange(
                        tx,
                        p,
                        'knowledge.synthesis_proposed',
                        page.id,
                        page.conversation_id,
                      );
                    }
                  }
                }
              }
              await tx.query(
                "UPDATE knowledge_schedules SET next_at=now()+interval_days*interval '1 day',last_error=$3,enabled=CASE WHEN $3 IN ('OWNER_UNAVAILABLE','OWNER_ACCESS_REVOKED') THEN false ELSE enabled END WHERE workspace_id=$1 AND page_id=$2",
                [workspace.id, job.page_id, failure || null],
              );
            });
          for (const page of await this.db.query<{ page_id: string }>(
            "SELECT page_id FROM knowledge_metadata WHERE state='deleted' AND deleted_at<now()-interval '7 days' ORDER BY deleted_at LIMIT 20",
          ))
            await this.db.query('SELECT purge_deleted_knowledge($1,$2)', [
              workspace.id,
              page.page_id,
            ]);
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
