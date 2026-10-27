import { randomUUID } from 'node:crypto';
import {
  dispatcherScope,
  workerScope,
  scopedDatabase,
  type Database,
  type Sql,
} from '@ao/database';
import type { Credentials } from 'google-auth-library';
import { IdentitySecrets } from '../identity/secrets.js';
import { workPrincipal, assumeWorkPrincipal } from '../workflows/authority.js';
import { CalendarProviderError, type CalendarProvider, type CalendarEvent } from './google.js';
import { AppError } from '../lib/errors.js';
export function calendarContext(ws: string, id: string) {
  return `calendar:${ws}:${id}`;
}
export class CalendarSyncWorker {
  private readonly db: Database;
  private pending: Promise<void> | null = null;
  constructor(
    db: Database,
    private readonly provider: CalendarProvider | null,
    private readonly secrets: IdentitySecrets,
    private readonly onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    if (!this.pending)
      this.pending = this.sweep().finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  private async sweep() {
    if (!this.provider) return;
    const spaces = await dispatcherScope(() =>
      this.db.query('SELECT id FROM workspaces ORDER BY id'),
    );
    for (const ws of spaces)
      await workerScope(String(ws.id), async () => {
        const rows = await this.db.query(
          "SELECT id FROM calendar_connections WHERE workspace_id=$1 AND status='active' AND next_sync_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY next_sync_at,id LIMIT 10",
          [ws.id],
        );
        for (const row of rows) await this.sync(String(ws.id), String(row.id));
      });
  }
  private async fence(tx: Sql, ws: string, id: string, lease: string) {
    await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [ws]);
    const [row] = await tx.query(
      "SELECT * FROM calendar_connections WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND lease_expires_at>now() AND status='active' FOR UPDATE",
      [ws, id, lease],
    );
    if (!row)
      throw new AppError(409, 'CALENDAR_LEASE_LOST', 'Calendar synchronization was superseded.');
    const p = await workPrincipal(tx, ws, String(row.membership_id), {
      auth: Number(row.auth_version),
      policy: Number(row.policy_version),
    });
    return { row, p };
  }
  private async sync(ws: string, id: string) {
    const lease = randomUUID();
    let claimedVersion: number | null = null;
    let credentials: Credentials | null = null;
    try {
      const connection = await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [ws]);
        const [row] = await tx.query(
          "UPDATE calendar_connections SET lease_token=$3,lease_expires_at=now()+interval '2 minutes' WHERE workspace_id=$1 AND id=$2 AND status='active' AND (lease_expires_at IS NULL OR lease_expires_at<now()) RETURNING *",
          [ws, id, lease],
        );
        if (!row) return null;
        claimedVersion = Number(row.version);
        await workPrincipal(tx, ws, String(row.membership_id), {
          auth: Number(row.auth_version),
          policy: Number(row.policy_version),
        });
        return row;
      });
      if (!connection) return;
      credentials = JSON.parse(
        this.secrets.open(calendarContext(ws, id), String(connection.credentials)),
      ) as Credentials;
      let page = connection.page_token as string | null,
        sync = connection.sync_token as string | null;
      for (let i = 0; i < 5; i++) {
        await this.db.transaction((tx) => this.fence(tx, ws, id, lease));
        const response = await this.provider!.changes(credentials, sync, page);
        credentials = response.credentials;
        await this.db.transaction(async (tx) => {
          await this.fence(tx, ws, id, lease);
          for (const event of response.data.items ?? []) {
            const [mapping] = await tx.query(
              'SELECT * FROM calendar_exports WHERE workspace_id=$1 AND connection_id=$2 AND event_id=$3 FOR UPDATE',
              [ws, id, event.id],
            );
            if (!mapping || mapping.etag === event.etag) continue;
            if (mapping.status === 'pending' && mapping.pending_payload) {
              const payload = mapping.pending_payload as { event: CalendarEvent; remove: boolean };
              if (
                (payload.remove && event.status === 'cancelled') ||
                (!payload.remove &&
                  payload.event.summary === event.summary &&
                  payload.event.start?.date === event.start?.date &&
                  event.extendedProperties?.private?.orbitTask === String(mapping.task_id))
              ) {
                await tx.query(
                  'UPDATE calendar_exports SET status=$4,etag=$5,task_version=pending_task_version,pending_payload=NULL,pending_task_version=NULL WHERE workspace_id=$1 AND connection_id=$2 AND task_id=$3',
                  [
                    ws,
                    id,
                    mapping.task_id,
                    payload.remove ? 'removed' : 'synced',
                    event.etag ?? null,
                  ],
                );
                continue;
              }
            }
            await tx.query(
              "UPDATE calendar_exports SET status='conflict',remote=$4::jsonb,updated_at=clock_timestamp() WHERE workspace_id=$1 AND connection_id=$2 AND task_id=$3",
              [
                ws,
                id,
                mapping.task_id,
                JSON.stringify({
                  id: event.id,
                  etag: event.etag ?? null,
                  status: event.status ?? 'confirmed',
                  summary: event.summary ?? '',
                  date: event.start?.date ?? null,
                }),
              ],
            );
          }
          await tx.query(
            'UPDATE calendar_connections SET credentials=$4,sync_token=CASE WHEN $5::text IS NULL THEN $6 ELSE sync_token END,page_token=$5 WHERE workspace_id=$1 AND id=$2 AND lease_token=$3',
            [
              ws,
              id,
              lease,
              this.secrets.seal(calendarContext(ws, id), JSON.stringify(credentials)),
              response.data.nextPageToken ?? null,
              response.data.nextSyncToken ?? sync,
            ],
          );
        });
        page = response.data.nextPageToken ?? null;
        if (!page) {
          sync = response.data.nextSyncToken ?? sync;
          break;
        }
      }
      if (!page)
        for (let n = 0; n < 20; n++) {
          const operation = await this.db.transaction(async (tx) => {
            const { p } = await this.fence(tx, ws, id, lease);
            await assumeWorkPrincipal(tx, p);
            const [task] = await tx.query(
              "SELECT t.id,t.title,t.state,t.version,to_char(t.due_date,'YYYY-MM-DD') due_date,t.assignee_id,t.conversation_id,e.status export_status,e.etag,e.event_id,e.pending_payload,e.pending_task_version FROM tasks t LEFT JOIN calendar_exports e ON e.workspace_id=t.workspace_id AND e.task_id=t.id AND e.connection_id=$3 WHERE t.workspace_id=$1 AND ((t.conversation_id IS NULL AND t.assignee_id=$2 AND t.due_date IS NOT NULL AND t.state NOT IN ('completed','cancelled')) OR e.task_id IS NOT NULL) AND NOT coalesce(e.suppressed,false) AND coalesce(e.status,'pending')<>'conflict' AND (e.task_id IS NULL OR e.task_version<>t.version OR e.pending_payload IS NOT NULL) ORDER BY t.updated_at,t.id LIMIT 1",
              [ws, p.membershipId, id],
            );
            if (!task) return null;
            const remove =
              task.conversation_id !== null ||
              task.assignee_id !== p.membershipId ||
              !task.due_date ||
              ['completed', 'cancelled'].includes(String(task.state));
            if (!task.event_id && remove) return null;
            let payload = task.pending_payload as { event: CalendarEvent; remove: boolean } | null;
            if (!payload) {
              const end = new Date(String(task.due_date ?? '2000-01-01') + 'T12:00:00Z');
              end.setUTCDate(end.getUTCDate() + 1);
              if (end.getUTCFullYear() > 9999)
                throw new AppError(
                  400,
                  'CALENDAR_DATE_UNSUPPORTED',
                  'Choose a due date before the end of year 9999.',
                );
              payload = {
                remove,
                event: {
                  id: String(task.event_id ?? 'ao' + String(task.id).replaceAll('-', '')),
                  summary: String(task.title),
                  status: 'confirmed',
                  start: { date: String(task.due_date) },
                  end: { date: end.toISOString().slice(0, 10) },
                  extendedProperties: {
                    private: { orbitTask: String(task.id), orbitWorkspace: ws },
                  },
                },
              };
              await tx.query(
                "INSERT INTO calendar_exports(workspace_id,connection_id,task_id,event_id,status,pending_payload,pending_task_version) VALUES($1,$2,$3,$4,'pending',$5::jsonb,$6) ON CONFLICT(workspace_id,connection_id,task_id) DO UPDATE SET status='pending',pending_payload=EXCLUDED.pending_payload,pending_task_version=EXCLUDED.pending_task_version",
                [ws, id, task.id, payload.event.id, JSON.stringify(payload), task.version],
              );
            }
            return { taskId: task.id, payload, etag: task.etag as string | null };
          });
          if (!operation) break;
          try {
            const response = await this.provider!.write(
              credentials,
              operation.payload.event,
              operation.etag,
              operation.payload.remove,
            );
            credentials = response.credentials;
            await this.db.transaction(async (tx) => {
              await this.fence(tx, ws, id, lease);
              await tx.query(
                'UPDATE calendar_exports SET status=$4,etag=$5,task_version=pending_task_version,pending_payload=NULL,pending_task_version=NULL,remote=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND connection_id=$2 AND task_id=$3',
                [
                  ws,
                  id,
                  operation.taskId,
                  operation.payload.remove ? 'removed' : 'synced',
                  response.data.etag ?? null,
                ],
              );
              await tx.query(
                'UPDATE calendar_connections SET credentials=$4 WHERE workspace_id=$1 AND id=$2 AND lease_token=$3',
                [
                  ws,
                  id,
                  lease,
                  this.secrets.seal(calendarContext(ws, id), JSON.stringify(credentials)),
                ],
              );
            });
          } catch (error) {
            if (!(error instanceof CalendarProviderError) || error.status !== 412) throw error;
            await this.db.transaction(async (tx) => {
              await this.fence(tx, ws, id, lease);
              await tx.query(
                "UPDATE calendar_exports SET status='conflict',remote=NULL,pending_payload=NULL,pending_task_version=NULL WHERE workspace_id=$1 AND connection_id=$2 AND task_id=$3",
                [ws, id, operation.taskId],
              );
              await tx.query(
                'UPDATE calendar_connections SET sync_token=NULL,page_token=NULL WHERE workspace_id=$1 AND id=$2',
                [ws, id],
              );
            });
          }
        }
      await this.db.transaction(async (tx) => {
        const [updated] = await tx.query(
          "UPDATE calendar_connections SET lease_token=NULL,lease_expires_at=NULL,next_sync_at=now()+interval '1 minute',last_synced_at=clock_timestamp(),error_code=NULL WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 RETURNING membership_id",
          [ws, id, lease],
        );
        if (updated) await this.changed(tx, ws, id, String(updated.membership_id));
      });
    } catch (error) {
      const invalid =
          (error instanceof AppError &&
            ['AUTHORITY_REVOKED', 'PERMISSION_DENIED'].includes(error.code)) ||
          (error instanceof CalendarProviderError && [401, 403].includes(error.status)),
        reset = error instanceof CalendarProviderError && error.status === 410;
      await this.db.transaction(async (tx) => {
        const [updated] = await tx.query(
          "UPDATE calendar_connections SET status=CASE WHEN $4 THEN 'needs_auth' ELSE status END,credentials=CASE WHEN $4 THEN '' ELSE credentials END,sync_token=CASE WHEN $5 THEN NULL ELSE sync_token END,page_token=CASE WHEN $5 THEN NULL ELSE page_token END,lease_token=NULL,lease_expires_at=NULL,next_sync_at=now()+interval '5 minutes',error_code=$6 WHERE workspace_id=$1 AND id=$2 AND status='active' AND (lease_token=$3 OR ($4 AND lease_token IS NULL AND version=$7)) RETURNING membership_id",
          [
            ws,
            id,
            lease,
            invalid,
            reset,
            invalid
              ? 'CALENDAR_RECONNECT_REQUIRED'
              : reset
                ? 'SYNC_TOKEN_EXPIRED'
                : 'CALENDAR_SYNC_FAILED',
            claimedVersion,
          ],
        );
        if (updated) await this.changed(tx, ws, id, String(updated.membership_id));
      });
      if (!(error instanceof AppError) && !(error instanceof CalendarProviderError))
        this.onError('CALENDAR_SYNC_FAILED');
    }
  }
  private async changed(tx: Sql, workspace: string, connection: string, member: string) {
    await tx.query(
      "INSERT INTO outbox_events(workspace_id,event_type,resource_id,audience_membership_id) VALUES($1,'calendar.changed',$2,$3)",
      [workspace, connection, member],
    );
  }
  start(interval = 15000) {
    const run = () => {
      void this.tick().catch(() => this.onError('CALENDAR_SYNC_FAILED'));
    };
    const timer = setInterval(run, interval);
    timer.unref();
    run();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
}
