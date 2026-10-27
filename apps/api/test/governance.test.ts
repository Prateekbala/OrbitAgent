import { workerScope, scopedDatabase } from '@ao/database';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { defaultGovernancePolicy } from '@ao/contracts/governance';
import { messagingFixture } from './messaging-fixture.js';
import { LifecycleWorker, ingestDeletionReceipt } from '../src/governance/lifecycle.js';
let f: Awaited<ReturnType<typeof messagingFixture>>, org: string;
beforeAll(async () => {
  f = await messagingFixture();
  org = String(
    (
      await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
        f.ownerBoot.workspace.id,
      ])
    )[0]!.organization_id,
  );
}, 30000);
afterAll(async () => f?.close());
const path = () => `/v1/organizations/${org}/governance`;
async function policy(change: Record<string, unknown>) {
  const p = (await f.call(f.owner, 'GET', path())).json<Record<string, unknown>>();
  const r = await f.call(f.owner, 'PUT', path(), { ...p, ...change });
  expect(r.statusCode, r.body).toBe(200);
  return r;
}
it('versions owner-only policies and produces verifiable immutable audit records', async () => {
  expect((await f.call(f.owner, 'GET', path())).json()).toEqual(defaultGovernancePolicy);
  expect((await f.call(f.other, 'GET', path())).statusCode).toBe(404);
  expect((await f.call(f.mate, 'PUT', path(), defaultGovernancePolicy)).statusCode).toBe(403);
  await policy({ hostedExecution: false, connections: false });
  expect((await f.call(f.owner, 'PUT', path(), defaultGovernancePolicy)).statusCode).toBe(409);
  const audit = await f.call(f.owner, 'GET', path() + '/audit?action=governance');
  expect(audit.statusCode, audit.body).toBe(200);
  expect(audit.json().items[0].action).toBe('governance.policy_changed');
  const proof = await f.call(f.owner, 'GET', path() + '/audit/verify');
  expect(proof.json().valid).toBe(true);
  await expect(
    f.db.query('UPDATE security_audit SET resource_id=$2 WHERE organization_id=$1', [
      org,
      'tampered',
    ]),
  ).rejects.toThrow(/Immutable/);
  const exported = await f.call(f.owner, 'GET', path() + '/audit/export');
  expect(exported.statusCode, exported.body).toBe(200);
  expect(exported.body).toContain('"type":"complete"');
});
it('enforces connection and model restrictions for direct database admissions too', async () => {
  const response = await f.call(f.owner, 'POST', '/v1/connections', {
    name: 'Restricted connector',
    provider: 'github',
    audience: 'personal',
    config: { owner: 'acme', repository: 'app' },
    subscriptions: [],
  });
  expect([400, 409]).toContain(response.statusCode);
  await expect(
    f.db.query(
      "INSERT INTO connections(workspace_id,owner_id,provider,name,audience,auth_version,policy_version) VALUES($1,$2,'github','Denied','personal',1,1)",
      [f.ownerBoot.workspace.id, f.ownerBoot.me.id],
    ),
  ).rejects.toThrow(/governance denied/);
});
it('preserves held content, records release reasons, and waits for physical-deletion evidence', async () => {
  const channel = await f.channel(),
    sent = await f.send(f.owner, channel, 'Governed private evidence'),
    message = sent.json().id;
  const hold = await f.call(f.owner, 'POST', path() + '/holds', {
    workspaceId: f.ownerBoot.workspace.id,
    conversationId: channel,
    reason: 'Preserve this conversation for an active legal review.',
    reference: 'CASE-42',
  });
  expect(hold.statusCode, hold.body).toBe(200);
  expect(
    (await f.call(f.owner, 'DELETE', `/v1/messages/${message}`, { version: 1 })).json().error.code,
  ).toBe('LEGAL_HOLD');
  const created = await f.call(f.owner, 'POST', path() + '/erasures', {
    workspaceId: f.ownerBoot.workspace.id,
    kind: 'message',
    sourceId: message,
    requestKey: randomUUID(),
    reason: 'Delete this source after the legal preservation window ends.',
  });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().id,
    worker = new LifecycleWorker(f.db);
  await worker.tick();
  expect((await f.db.query('SELECT state FROM lifecycle_jobs WHERE id=$1', [id]))[0]!.state).toBe(
    'held',
  );
  const released = await f.call(f.owner, 'DELETE', path() + '/holds/' + hold.json().id, {
    reason: 'The legal review is complete and preservation has been released.',
  });
  expect(released.statusCode, released.body).toBe(200);
  await f.db.query('UPDATE lifecycle_jobs SET available_at=now() WHERE id=$1', [id]);
  await worker.tick();
  expect((await f.db.query('SELECT body FROM messages WHERE id=$1', [message]))[0]!.body).toBe('');
  expect((await f.db.query('SELECT state FROM lifecycle_jobs WHERE id=$1', [id]))[0]!.state).toBe(
    'waiting_receipts',
  );
  const keys = generateKeyPairSync('ed25519'),
    publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await f.db.query(
    "UPDATE lifecycle_jobs SET receipt_after=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  const data = Buffer.from(
      JSON.stringify({
        id: 'fixture-backup-expiry',
        jobId: id,
        processor: 'backup',
        evidenceHash: createHash('sha256').update('verified deletion manifest').digest('hex'),
        completedAt: new Date().toISOString(),
      }),
    ),
    signature = sign(null, data, keys.privateKey).toString('base64');
  await expect(
    ingestDeletionReceipt(f.db, Buffer.concat([data, Buffer.from(' ')]), signature, publicKey),
  ).rejects.toThrow(/signature/);
  expect((await ingestDeletionReceipt(f.db, data, signature, publicKey)).replayed).toBe(false);
  await worker.tick();
  expect((await f.db.query('SELECT state FROM lifecycle_jobs WHERE id=$1', [id]))[0]!.state).toBe(
    'waiting_receipts',
  );
  for (const processor of ['runtime', 'provider', 'derived']) {
    const proof = Buffer.from(
      JSON.stringify({ ...JSON.parse(data.toString()), id: 'fixture-' + processor, processor }),
    );
    await ingestDeletionReceipt(
      f.db,
      proof,
      sign(null, proof, keys.privateKey).toString('base64'),
      publicKey,
    );
  }
  await worker.tick();
  expect((await f.db.query('SELECT state FROM lifecycle_jobs WHERE id=$1', [id]))[0]!.state).toBe(
    'completed',
  );
});
it('requires purpose, owner consent and MFA for scoped support diagnostics; revokes immediately', async () => {
  await policy({ supportAccess: true });
  const target = (
    await f.db.query('SELECT account_id FROM memberships WHERE id=$1', [f.otherBoot.me.id])
  )[0]!.account_id;
  const grant = await f.call(f.owner, 'POST', path() + '/support', {
    accountId: target,
    workspaceIds: [f.ownerBoot.workspace.id],
    purpose: 'Investigate queue latency for the customer support ticket.',
    ticket: 'SUPPORT-42',
    minutes: 30,
  });
  expect(grant.statusCode, grant.body).toBe(200);
  const url = `/v1/support/${grant.json().id}/diagnostics`;
  expect((await f.call(f.other, 'GET', url)).statusCode).toBe(403);
  await f.db.query('UPDATE sessions SET mfa_verified_at=now() WHERE membership_id=$1', [
    f.otherBoot.me.id,
  ]);
  const read = await f.call(f.other, 'GET', url);
  expect(read.statusCode, read.body).toBe(200);
  expect(read.body).not.toContain('Governed private evidence');
  expect(
    (await f.call(f.other, 'GET', `/v1/conversations/${f.ownerBoot.channels[0]!.id}/messages`))
      .statusCode,
  ).toBe(404);
  await f.call(f.owner, 'DELETE', path() + '/support/' + grant.json().id);
  expect((await f.call(f.other, 'GET', url)).statusCode).toBe(404);
});
it('keeps operator metrics private and exposes only explicitly published status incidents', async () => {
  expect((await f.call(f.owner, 'GET', '/internal/metrics')).statusCode).toBe(401);
  expect((await f.call('', 'GET', '/v1/status')).json()).toEqual({ incidents: [] });
  const snapshot = await f.call(f.owner, 'GET', `/v1/organizations/${org}/operations`);
  expect(snapshot.statusCode, snapshot.body).toBe(200);
  expect(snapshot.json().queues).toHaveProperty('developer');
});
it('exports organization content using workspace membership and obeys current export policy', async () => {
  await policy({ exports: true });
  const result = await f.call(f.owner, 'GET', `/v1/organizations/${org}/export`);
  expect(result.statusCode, result.body.slice(0, 200)).toBe(200);
  expect(result.rawPayload.toString()).toContain('organization.json');
  expect(result.rawPayload.toString()).toContain('manifest.json');
  expect((await f.call(f.other, 'GET', `/v1/organizations/${org}/export`)).statusCode).toBe(404);
  await policy({ exports: false });
  expect((await f.call(f.owner, 'GET', '/v1/workspace-export')).statusCode).toBe(403);
  expect((await f.call(f.owner, 'GET', '/v1/memory/' + randomUUID() + '/export')).statusCode).toBe(
    403,
  );
  expect(
    (await f.call(f.owner, 'GET', '/v1/knowledge/' + randomUUID() + '/export')).statusCode,
  ).toBe(403);
  expect((await f.call(f.owner, 'GET', `/v1/organizations/${org}/export`)).statusCode).toBe(403);
});
it('redacts task comments and purges immutable knowledge history through fenced erasure', async () => {
  const task = await f.call(f.owner, 'POST', '/v1/tasks', {
    title: 'Source task',
    description: 'Private task evidence',
  });
  const comment = await f.call(f.owner, 'POST', `/v1/tasks/${task.json().id}/comments`, {
    body: 'Private comment evidence',
    clientId: randomUUID(),
  });
  expect(comment.statusCode, comment.body).toBe(201);
  const page = await f.call(f.owner, 'POST', '/v1/knowledge', {
    title: 'Source page',
    body: 'Private page evidence',
  });
  expect(page.statusCode, page.body).toBe(201);
  const ids = [];
  for (const [kind, sourceId] of [
    ['task', task.json().id],
    ['knowledge', page.json().id],
  ]) {
    const job = await f.call(f.owner, 'POST', path() + '/erasures', {
      workspaceId: f.ownerBoot.workspace.id,
      kind,
      sourceId,
      requestKey: randomUUID(),
      reason: 'An approved source deletion with component evidence still pending.',
    });
    expect(job.statusCode, job.body).toBe(200);
    ids.push(job.json().id);
  }
  for (const id of ids)
    await workerScope(f.ownerBoot.workspace.id, () =>
      scopedDatabase(f.db).transaction(async (tx) => {
        const lease = randomUUID();
        await tx.query(
          "UPDATE lifecycle_jobs SET state='leased',lease=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
          [id, lease],
        );
        const [result] = await tx.query('SELECT erase_lifecycle_source($1,$2,$3) state', [
          f.ownerBoot.workspace.id,
          id,
          lease,
        ]);
        expect(result!.state).toBe('waiting_receipts');
      }),
    );
  expect(
    (await f.db.query('SELECT body FROM task_comments WHERE id=$1', [comment.json().id]))[0]!.body,
  ).toBe('');
  expect(
    (await f.db.query('SELECT body FROM knowledge_pages WHERE id=$1', [page.json().id]))[0]!.body,
  ).toBe('[erased]');
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int total FROM knowledge_versions WHERE page_id=$1 AND body<>'[erased]'",
        [page.json().id],
      )
    )[0]!.total,
  ).toBe(0);
});
it('holds task content and bounds erasure to the correct organization', async () => {
  const task = await f.call(f.owner, 'POST', '/v1/tasks', {
    title: 'Preserve acceptance evidence',
  });
  expect(task.statusCode, task.body).toBe(201);
  const hold = await f.call(f.owner, 'POST', path() + '/holds', {
    workspaceId: f.ownerBoot.workspace.id,
    conversationId: null,
    reason: 'Preserve task artifacts for active case review.',
    reference: 'TASK-HOLD',
  });
  expect(hold.statusCode, hold.body).toBe(200);
  await expect(
    f.db.query('UPDATE tasks SET description=$2 WHERE id=$1', [task.json().id, 'changed']),
  ).rejects.toThrow(/legal hold/);
  expect(
    (
      await f.call(f.owner, 'POST', path() + '/erasures', {
        workspaceId: f.otherBoot.workspace.id,
        kind: 'task',
        sourceId: task.json().id,
        requestKey: randomUUID(),
        reason: 'This request must never cross organization boundaries.',
      })
    ).statusCode,
  ).toBe(404);
});
it('does not expose owner-executed audit triggers or cross-tenant lifecycle metadata to worker roles', async () => {
  for (const name of [
    'capture_security_audit()',
    'append_security_audit(uuid,text,jsonb,uuid)',
    'preserve_held_content()',
    'preserve_held_child()',
  ]) {
    expect(
      (
        await f.db.query("SELECT has_function_privilege('ao_runtime',$1,'EXECUTE') allowed", [name])
      )[0]!.allowed,
    ).toBe(false);
  }
  const sent = await f.send(f.other, f.otherBoot.channels[0]!.id, 'Another tenant private source');
  await workerScope(f.ownerBoot.workspace.id, async () => {
    const [row] = await scopedDatabase(f.db).query('SELECT lifecycle_source($1,$2,$3) source', [
      f.otherBoot.workspace.id,
      'message',
      sent.json().id,
    ]);
    expect(row!.source).toBeNull();
  });
});
