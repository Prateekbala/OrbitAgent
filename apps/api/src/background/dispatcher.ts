import { randomUUID } from 'node:crypto';
import { dispatcherScope, scopedDatabase, type Database } from '@ao/database';
import type { BackgroundMessage, BackgroundPublisher } from './queue.js';

interface Schedule extends Record<string, unknown> {
  worker: string;
  generation: string;
  delay_seconds: number;
}
export interface BackgroundWorker {
  tick(): Promise<unknown>;
  start(): () => Promise<void>;
}
export class BackgroundBusyError extends Error {
  constructor() {
    super('Background worker is already leased.');
  }
}

export class BackgroundDispatcher {
  private readonly db: Database;
  constructor(
    db: Database,
    private readonly workers: ReadonlyMap<string, BackgroundWorker>,
    private readonly publisher: BackgroundPublisher,
  ) {
    this.db = scopedDatabase(db);
  }

  async publish() {
    await dispatcherScope(() =>
      this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE background_schedules SET generation=generation+1
           WHERE published_generation=generation AND due_at<now()-interval '15 minutes'
           AND published_at<now()-interval '15 minutes' AND (lease_until IS NULL OR lease_until<=now())`,
        );
        const schedules = await tx.query<Schedule>(
          `SELECT worker,generation::text,greatest(0,ceil(extract(epoch FROM due_at-clock_timestamp())))::int delay_seconds
           FROM background_schedules WHERE published_generation<generation
           ORDER BY due_at,worker FOR UPDATE SKIP LOCKED LIMIT 32`,
        );
        const results = await Promise.allSettled(
          schedules.map(async (schedule) => {
            if (this.workers.has(schedule.worker))
              await this.publisher.publish(
                { version: 1, worker: schedule.worker, generation: schedule.generation },
                Math.min(86400, schedule.delay_seconds),
              );
            await tx.query(
              'UPDATE background_schedules SET published_generation=$2,published_at=now() WHERE worker=$1 AND generation=$2',
              [schedule.worker, schedule.generation],
            );
          }),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }),
    );
  }

  async run(message: BackgroundMessage) {
    const worker = this.workers.get(message.worker);
    if (!worker || message.version !== 1 || !/^\d{1,19}$/.test(message.generation))
      throw new Error('Invalid background wake-up.');
    const token = randomUUID();
    const claim = await dispatcherScope(() =>
      this.db.transaction(async (tx) => {
        const [row] = await tx.query(
          'SELECT *,generation::text FROM background_schedules WHERE worker=$1 FOR UPDATE',
          [message.worker],
        );
        if (!row) throw new Error('Background schedule is missing. Run database migrations.');
        if (row.lease_until && new Date(String(row.lease_until)).getTime() > Date.now())
          throw new BackgroundBusyError();
        if (
          String(row.generation) !== message.generation ||
          new Date(String(row.due_at)).getTime() > Date.now()
        )
          return null;
        const [claimed] = await tx.query(
          `UPDATE background_schedules SET lease_token=$2,lease_until=now()+interval '6 minutes',
           due_at=now()+interval '6 minutes',generation=generation+1 WHERE worker=$1 RETURNING generation::text`,
          [message.worker, token],
        );
        return claimed!;
      }),
    );
    if (!claim) {
      await this.publish();
      return;
    }
    try {
      await worker.tick();
      await dispatcherScope(() =>
        this.db.query(
          `WITH candidate AS (SELECT background_next_at($1) next_at), planned AS (
             SELECT greatest(next_at,now()+least(900,5*power(2,least(CASE WHEN last_due=next_at THEN idle_passes+1 ELSE 0 END,8)))*interval '1 second') next_at,
               candidate.next_at raw_at,CASE WHEN last_due=candidate.next_at THEN least(idle_passes+1,8) ELSE 0 END idle
             FROM candidate,background_schedules WHERE worker=$1)
           UPDATE background_schedules s SET due_at=CASE WHEN generation=$3 THEN p.next_at ELSE least(due_at,p.next_at) END,
           generation=generation+1,lease_token=NULL,lease_until=NULL,failures=0,last_completed_at=now(),last_due=p.raw_at,idle_passes=p.idle
           FROM planned p WHERE worker=$1 AND lease_token=$2`,
          [message.worker, token, claim.generation],
        ),
      );
    } catch (error) {
      await dispatcherScope(() =>
        this.db.query(
          `UPDATE background_schedules SET due_at=least(due_at,now()+least(900,15*power(2,least(failures,6)))*interval '1 second'),
           generation=generation+1,lease_token=NULL,lease_until=NULL,failures=failures+1 WHERE worker=$1 AND lease_token=$2`,
          [message.worker, token],
        ),
      );
      throw error;
    } finally {
      await this.publish();
    }
  }
}
