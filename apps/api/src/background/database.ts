import type { Database } from '@ao/database';

export function backgroundDatabase(base: Database, worker: string): Database {
  return {
    query: (sql, params) =>
      base.transaction(async (tx) => {
        await tx.query("SELECT set_config('ao.background_worker',$1,true)", [worker]);
        return tx.query(sql, params);
      }),
    transaction: (work) =>
      base.transaction(async (tx) => {
        await tx.query("SELECT set_config('ao.background_worker',$1,true)", [worker]);
        return work(tx);
      }),
    close: () => base.close(),
  };
}
