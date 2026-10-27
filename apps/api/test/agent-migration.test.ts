import { it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { migrate, statements } from '@ao/database';
import { testDatabase } from './database.js';
it('migrates open legacy sessions into captured configuration and conservative reservations without rewriting terminal history', async () => {
  const db = await testDatabase();
  try {
    const directory = new URL('../../../packages/database/migrations/', import.meta.url);
    await db.transaction(async (tx) => {
      await tx.query(
        'CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const name of (await readdir(directory))
        .filter((name) => /^\d+_.*\.sql$/.test(name) && Number(name.split('_')[0]) <= 37)
        .sort()) {
        for (const statement of statements(await readFile(new URL(name, directory), 'utf8')))
          await tx.query(statement);
        await tx.query('INSERT INTO schema_migrations(version) VALUES($1)', [
          Number(name.split('_')[0]),
        ]);
      }
    });
    const workspace = randomUUID(),
      account = randomUUID(),
      member = randomUUID(),
      agentMember = randomUUID(),
      agent = randomUUID(),
      conversation = randomUUID(),
      queued = randomUUID(),
      approval = randomUUID(),
      terminal = randomUUID();
    await db.query(
      'INSERT INTO accounts(id,email,name,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())',
      [account, 'legacy@example.test', 'Legacy operator', 'fixture-password-hash'],
    );
    await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
      workspace,
      'Legacy workspace',
    ]);
    await db.query(
      "INSERT INTO memberships(id,workspace_id,account_id,name,kind,role) VALUES($1,$2,$3,'Legacy operator','human','owner')",
      [member, workspace, account],
    );
    await db.query(
      "INSERT INTO memberships(id,workspace_id,name,kind,role) VALUES($1,$2,'Legacy agent','agent','member')",
      [agentMember, workspace],
    );
    await db.query(
      "INSERT INTO agents(id,workspace_id,membership_id,instructions,runtime,owner_id) VALUES($1,$2,$3,'Current legacy instructions','managed',$4)",
      [agent, workspace, agentMember, member],
    );
    await db.query(
      "INSERT INTO conversations(id,workspace_id,name,visibility) VALUES($1,$2,'legacy','public')",
      [conversation, workspace],
    );
    for (const [id, status] of [
      [queued, 'queued'],
      [approval, 'awaiting_approval'],
      [terminal, 'succeeded'],
    ])
      await db.query(
        'INSERT INTO agent_runs(id,workspace_id,agent_id,requester_id,conversation_id,request_key,request_hash,prompt,instructions,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          workspace,
          agent,
          member,
          conversation,
          randomUUID(),
          'fixture-request-hash',
          'Original legacy request',
          'Captured legacy instructions',
          status,
        ],
      );
    await migrate(db);
    const [run] = await db.query(
      'SELECT prompt,instructions,agent_revision,configuration FROM agent_runs WHERE id=$1',
      [queued],
    );
    expect(run).toMatchObject({
      prompt: 'Original legacy request',
      instructions: 'Captured legacy instructions',
      agent_revision: 1,
      configuration: expect.objectContaining({ instructions: 'Captured legacy instructions' }),
    });
    const reservations = await db.query(
      'SELECT run_id,state,amount_micros,actual_micros FROM execution_reservations ORDER BY run_id',
    );
    expect(reservations).toHaveLength(2);
    expect(reservations.find((row) => row.run_id === queued)?.state).toBe('reserved');
    expect(reservations.find((row) => row.run_id === approval)?.state).toBe('settled');
    expect(reservations.some((row) => row.run_id === terminal)).toBe(false);
    const [policy] = await db.query(
      'SELECT needs_work FROM execution_policies WHERE workspace_id=$1',
      [workspace],
    );
    expect(policy?.needs_work).toBe(true);
    await expect(
      db.query('UPDATE execution_reservations SET amount_micros=1 WHERE run_id=$1', [queued]),
    ).rejects.toThrow('immutable');
    await migrate(db);
    expect(await db.query('SELECT run_id FROM execution_reservations')).toHaveLength(2);
  } finally {
    await db.close();
  }
}, 30000);
