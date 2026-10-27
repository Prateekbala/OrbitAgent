import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  migrate,
  scopedDatabase,
  tenantScope,
  workerScope,
  identityScope,
  type Database,
} from '@ao/database';
import { testDatabase } from './database.js';
let db: Database;
beforeAll(async () => {
  db = await testDatabase();
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});
it('upgrades legacy workspace row-lock grants without removing records or tenant restrictions', async () => {
  const own = randomUUID(),
    other = randomUUID();
  await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2),($3,$4)', [
    own,
    'Existing workspace',
    other,
    'Other workspace',
  ]);
  await db.transaction(async (tx) => {
    await tx.query('REVOKE UPDATE ON workspaces FROM ao_runtime,ao_worker,ao_identity');
    await tx.query('DELETE FROM schema_migrations WHERE version=33');
  });
  const scoped = scopedDatabase(db);
  const lock = () => scoped.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [own]);
  await expect(workerScope(own, lock)).rejects.toMatchObject({ code: '42501' });
  await migrate(db);
  for (const run of [
    () => tenantScope(own, lock),
    () => workerScope(own, lock),
    () => identityScope(lock, own),
  ])
    expect(await run()).toEqual([{ id: own }]);
  expect(await workerScope(other, lock)).toEqual([]);
  expect(await tenantScope(other, lock)).toEqual([]);
  expect(
    await db.query('SELECT count(*)::int total FROM workspaces WHERE id=ANY($1::uuid[])', [
      [own, other],
    ]),
  ).toEqual([{ total: 2 }]);
  await migrate(db);
  expect(await workerScope(own, lock)).toEqual([{ id: own }]);
});
