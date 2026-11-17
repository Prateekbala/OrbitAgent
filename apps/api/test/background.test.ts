import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dispatcherScope,
  identityScope,
  migrate,
  scopedDatabase,
  type Database,
} from '@ao/database';
import { testDatabase } from './database.js';
import { backgroundDatabase } from '../src/background/database.js';
import {
  BackgroundBusyError,
  BackgroundDispatcher,
  type BackgroundWorker,
} from '../src/background/dispatcher.js';
import type { BackgroundMessage, BackgroundPublisher } from '../src/background/queue.js';

let db: Database;
let messages: { message: BackgroundMessage; delay: number }[];
let failPublish: boolean;
const publisher: BackgroundPublisher = {
  async publish(message, delay) {
    if (failPublish) throw new Error('Synthetic broker failure');
    messages.push({ message, delay });
  },
};
const worker = (tick: () => Promise<void>): BackgroundWorker => ({
  tick,
  start: () => async () => {},
});
const dispatcher = (tick = async () => {}) =>
  new BackgroundDispatcher(db, new Map([['email', worker(tick)]]), publisher);
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  messages = [];
  failPublish = false;
  await db.query(
    'UPDATE background_schedules SET due_at=now(),generation=generation+1,published_generation=0,lease_token=NULL,lease_until=NULL,failures=0,last_due=NULL,idle_passes=0',
  );
});

describe('durable on-demand background execution', () => {
  it('plans every installed worker without exposing source content', async () => {
    const rows = await dispatcherScope(() =>
      scopedDatabase(db).query(
        'SELECT worker,background_next_at(worker) next_at FROM background_schedules',
      ),
    );
    expect(rows).toHaveLength(24);
    for (const row of rows)
      expect(new Date(String(row.next_at)).getTime()).toBeGreaterThan(Date.now());
    await expect(
      scopedDatabase(db).query('SELECT * FROM background_schedules'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      identityScope(() => scopedDatabase(db).query("SELECT background_next_at('email')")),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('coalesces notifications, acknowledges stale deliveries and sleeps when idle', async () => {
    let calls = 0;
    const runner = dispatcher(async () => {
      calls++;
    });
    await runner.publish();
    await runner.publish();
    expect(messages).toHaveLength(1);
    const message = messages[0]!.message;
    expect(Object.keys(message).sort()).toEqual(['generation', 'version', 'worker']);
    await runner.run(message);
    expect(calls).toBe(1);
    expect(messages.at(-1)!.delay).toBeGreaterThanOrEqual(86399);
    await runner.run(message);
    expect(calls).toBe(1);
  });

  it('retains the outbox when publication fails, then retries the same idempotency key', async () => {
    const runner = dispatcher();
    failPublish = true;
    await expect(runner.publish()).rejects.toThrow('Synthetic broker failure');
    const [row] = await db.query(
      "SELECT generation::text,published_generation::text FROM background_schedules WHERE worker='email'",
    );
    expect(row!.published_generation).toBe('0');
    failPublish = false;
    await runner.publish();
    expect(messages[0]!.message.generation).toBe(row!.generation);
  });

  it('fences concurrent consumers and does not run a duplicate job', async () => {
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const runner = dispatcher(async () => {
      calls++;
      entered();
      await gate;
    });
    await runner.publish();
    const message = messages[0]!.message;
    const first = runner.run(message);
    await started;
    await expect(runner.run(message)).rejects.toBeInstanceOf(BackgroundBusyError);
    finish();
    await first;
    await runner.run(message);
    expect(calls).toBe(1);
  });

  it('reschedules failures with backoff and preserves a wake-up committed during a run', async () => {
    const runner = dispatcher(async () => {
      throw new Error('Synthetic worker failure');
    });
    await runner.publish();
    await expect(runner.run(messages[0]!.message)).rejects.toThrow('Synthetic worker failure');
    expect(messages.at(-1)!.delay).toBeGreaterThanOrEqual(14);
    expect(messages.at(-1)!.delay).toBeLessThanOrEqual(16);
    const [failed] = await db.query(
      "SELECT failures FROM background_schedules WHERE worker='email'",
    );
    expect(failed!.failures).toBe(1);
    await db.query(
      "UPDATE background_schedules SET due_at=now()-interval '1 second',generation=generation+1 WHERE worker='email'",
    );
    const concurrent = dispatcher(async () => {
      await db.query(
        "UPDATE background_schedules SET due_at=now(),generation=generation+1 WHERE worker='email'",
      );
    });
    await concurrent.publish();
    await concurrent.run(messages.at(-1)!.message);
    expect(messages.at(-1)!.delay).toBeLessThanOrEqual(1);
  });

  it('recovers expired leases through a new durable delivery', async () => {
    let calls = 0;
    const runner = dispatcher(async () => {
      calls++;
    });
    await runner.publish();
    const stale = messages[0]!.message;
    await db.query(
      "UPDATE background_schedules SET lease_token=gen_random_uuid(),lease_until=now()-interval '1 second',due_at=now()-interval '1 second',generation=generation+1 WHERE worker='email'",
    );
    await runner.run(stale);
    expect(calls).toBe(0);
    const replacement = messages.at(-1)!.message;
    expect(replacement.generation).not.toBe(stale.generation);
    await runner.run(replacement);
    expect(calls).toBe(1);
  });

  it('republishes overdue accepted messages after an outage or retention expiry', async () => {
    const runner = dispatcher();
    await runner.publish();
    const original = messages[0]!.message.generation;
    await db.query(
      "UPDATE background_schedules SET due_at=now()-interval '8 days',published_at=now()-interval '8 days' WHERE worker='email'",
    );
    await runner.publish();
    expect(messages).toHaveLength(2);
    expect(messages[1]!.message.generation).not.toBe(original);
    expect(messages[1]!.delay).toBe(0);
  });

  it('records transactional source wake-ups and suppresses self-wakes only for the active worker', async () => {
    await db.query("UPDATE background_schedules SET due_at=now()+interval '1 day'");
    const trigger = 'SELECT request_background_work()';
    await expect(scopedDatabase(db).query(trigger)).rejects.toMatchObject({ code: '42501' });
    await db.query('CREATE TABLE background_test_source(id integer PRIMARY KEY,value integer)');
    await db.query(
      "CREATE TRIGGER background_wake AFTER INSERT OR UPDATE ON background_test_source FOR EACH ROW EXECUTE FUNCTION request_background_work('email','execution')",
    );
    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO background_test_source VALUES(1,1)');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        await db.query('SELECT worker FROM background_schedules WHERE due_at<=now()'),
      ).toHaveLength(0);
      await backgroundDatabase(db, 'email').query('INSERT INTO background_test_source VALUES(1,1)');
      expect(await db.query('SELECT worker FROM background_schedules WHERE due_at<=now()')).toEqual(
        [{ worker: 'execution' }],
      );
      await db.query('UPDATE background_test_source SET value=2 WHERE id=1');
      expect(
        await db.query(
          'SELECT worker FROM background_schedules WHERE due_at<=now() ORDER BY worker',
        ),
      ).toEqual([{ worker: 'email' }, { worker: 'execution' }]);
      await db.query("UPDATE background_schedules SET due_at=now()+interval '1 day'");
      await db.query('UPDATE background_test_source SET value=value');
      expect(
        await db.query('SELECT worker FROM background_schedules WHERE due_at<=now()'),
      ).toHaveLength(0);
    } finally {
      await db.query('DROP TABLE background_test_source');
    }
  });
});
