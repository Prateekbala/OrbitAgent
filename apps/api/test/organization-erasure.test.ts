import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scopedDatabase, erasureScope } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
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
it('requires owner reauthentication, freezes content and erases only the requested organization', async () => {
  const source = await f.send(
    f.owner,
    f.ownerBoot.channels[0]!.id,
    'Delete this organization content',
  );
  const other = await f.send(f.other, f.otherBoot.channels[0]!.id, 'Preserve another organization');
  const input = {
    requestKey: randomUUID(),
    confirmation: 'Owner Studio',
    password: 'messaging-test-password',
    reason: 'Delete the entire organization following authorized account closure.',
  };
  const url = `/v1/organizations/${org}/erasure`;
  expect((await f.call(f.mate, 'POST', url, input)).statusCode).toBe(403);
  expect((await f.call(f.owner, 'POST', url, { ...input, password: 'incorrect' })).statusCode).toBe(
    403,
  );
  const requested = await f.call(f.owner, 'POST', url, input);
  expect(requested.statusCode, requested.body).toBe(200);
  expect((await f.call(f.owner, 'POST', url, input)).json().replayed).toBe(true);
  const blocked = await f.call(
    f.owner,
    'GET',
    `/v1/conversations/${f.ownerBoot.channels[0]!.id}/messages`,
  );
  expect(blocked.body).not.toContain('Delete this organization content');
  await f.db.query(
    "UPDATE organization_erasures SET created_at=now()-interval '4 minutes' WHERE id=$1",
    [requested.json().id],
  );
  await erasureScope(() =>
    scopedDatabase(f.db).transaction(async (tx) => {
      const [job] = await tx.query('SELECT * FROM claim_organization_erasure()');
      expect(job!.id).toBe(requested.json().id);
      const prepared = await tx.query('SELECT prepare_organization_erasure($1,$2) value', [
        job!.id,
        job!.lease,
      ]);
      expect((prepared[0]!.value as { held: boolean }).held).toBe(false);
      await tx.query('SELECT acknowledge_organization_storage($1,$2)', [job!.id, job!.lease]);
      await tx.query('SELECT purge_organization_database($1,$2)', [job!.id, job!.lease]);
      expect(
        (
          await tx.query('SELECT finish_organization_erasure($1,$2,false) state', [
            job!.id,
            job!.lease,
          ])
        )[0]!.state,
      ).toBe('waiting_receipts');
    }),
  );
  expect(
    (await f.db.query('SELECT body FROM messages WHERE id=$1', [source.json().id])).length,
  ).toBe(0);
  expect(
    (await f.db.query('SELECT body FROM messages WHERE id=$1', [other.json().id]))[0]!.body,
  ).toBe('Preserve another organization');
  expect(
    (
      await f.db.query('SELECT count(*)::int total FROM run_checkpoints WHERE workspace_id=$1', [
        f.ownerBoot.workspace.id,
      ])
    )[0]!.total,
  ).toBe(0);
});
it('retains owner progress access after source deletion and refuses workspace re-creation', async () => {
  const response = await f.call(f.owner, 'GET', `/v1/organizations/${org}/erasure`);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().state).toBe('waiting_receipts');
  await expect(
    f.db.query('INSERT INTO workspaces(id,name,organization_id) VALUES($1,$2,$3)', [
      randomUUID(),
      'Recreated sensitive workspace',
      org,
    ]),
  ).rejects.toThrow(/deletion is in progress/);
});
it('blocks storage removal under legal holds and requires signed component receipts', async () => {
  const local = await messagingFixture();
  try {
    const organization = String(
      (
        await local.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
          local.ownerBoot.workspace.id,
        ])
      )[0]!.organization_id,
    );
    const path = `/v1/organizations/${organization}/governance`;
    const hold = await local.call(local.owner, 'POST', path + '/holds', {
      workspaceId: local.ownerBoot.workspace.id,
      conversationId: null,
      reason: 'Preserve all retained source data during this legal case.',
      reference: 'ORG-PRESERVATION',
    });
    expect(hold.statusCode, hold.body).toBe(200);
    const request = await local.call(
      local.owner,
      'POST',
      `/v1/organizations/${organization}/erasure`,
      {
        requestKey: randomUUID(),
        confirmation: 'Owner Studio',
        password: 'messaging-test-password',
        reason: 'An authorized closure request subject to legal preservation.',
      },
    );
    expect(request.statusCode, request.body).toBe(200);
    const { OrganizationErasureWorker } = await import('../src/governance/organization-erasure.js');
    let deleted = 0;
    const store = {
      id: 'local' as const,
      async put() {},
      async get() {
        throw new Error('unused');
      },
      async delete() {
        deleted++;
      },
      async purgeWorkspace() {
        deleted++;
      },
    };
    const worker = new OrganizationErasureWorker(local.db, store);
    await worker.tick();
    expect(deleted).toBe(0);
    expect(
      (
        await local.db.query('SELECT state FROM organization_erasures WHERE id=$1', [
          request.json().id,
        ])
      )[0]!.state,
    ).toBe('held');
    expect(
      (
        await local.call(local.owner, 'DELETE', path + '/holds/' + hold.json().id, {
          reason: 'Legal preservation has been explicitly released after review.',
        })
      ).statusCode,
    ).toBe(200);
    await local.db.query(
      "UPDATE organization_erasures SET available_at=now(),created_at=now()-interval '4 minutes' WHERE id=$1",
      [request.json().id],
    );
    await worker.tick();
    expect(deleted).toBeGreaterThan(0);
    expect(
      (
        await local.db.query('SELECT state FROM organization_erasures WHERE id=$1', [
          request.json().id,
        ])
      )[0]!.state,
    ).toBe('waiting_receipts');
    const { generateKeyPairSync, sign, createHash } = await import('node:crypto');
    const signing = generateKeyPairSync('ed25519');
    const { ingestOrganizationReceipt } = await import('../src/governance/organization-erasure.js');
    await local.db.query(
      "UPDATE organization_erasures SET backup_not_before=now()-interval '1 second' WHERE id=$1",
      [request.json().id],
    );
    for (const processor of ['runtime', 'provider', 'backup']) {
      const bytes = Buffer.from(
        JSON.stringify({
          id: 'org-fixture-' + processor,
          scope: 'organization',
          jobId: request.json().id,
          processor,
          evidenceHash: createHash('sha256').update('Synthetic deletion acceptance').digest('hex'),
          completedAt: new Date().toISOString(),
        }),
      );
      await ingestOrganizationReceipt(
        local.db,
        bytes,
        sign(null, bytes, signing.privateKey).toString('base64'),
        signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      );
    }
    await worker.tick();
    expect(
      (
        await local.db.query('SELECT state FROM organization_erasures WHERE id=$1', [
          request.json().id,
        ])
      )[0]!.state,
    ).toBe('completed');
    expect(
      (
        await local.db.query(
          "SELECT action FROM organization_audit WHERE organization_id=$1 AND action='organization.erasure_completed'",
          [organization],
        )
      ).length,
    ).toBe(1);
  } finally {
    await local.close();
  }
}, 30000);
it('accepts recent organization SSO as step-up and rejects an older federated session', async () => {
  const local = await messagingFixture();
  try {
    const workspace = local.ownerBoot.workspace.id,
      [orgRow] = await local.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
        workspace,
      ]);
    const organization = String(orgRow!.organization_id),
      [member] = await local.db.query('SELECT account_id FROM memberships WHERE id=$1', [
        local.ownerBoot.me.id,
      ]),
      provider = randomUUID();
    await local.db.query(
      "INSERT INTO identity_providers(id,organization_id,name,protocol,configuration,workspace_id) VALUES($1,$2,'Synthetic SSO','oidc',$3::jsonb,$4)",
      [provider, organization, JSON.stringify({ workspaceId: workspace }), workspace],
    );
    await local.db.query(
      'INSERT INTO federated_identities(provider_id,subject,account_id) VALUES($1,$2,$3)',
      [provider, 'verified-fixture-subject', member!.account_id],
    );
    await local.db.query(
      "UPDATE sessions SET provider_id=$2,authentication_method='oidc',created_at=now()-interval '6 minutes' WHERE membership_id=$1",
      [local.ownerBoot.me.id, provider],
    );
    const input = {
      requestKey: randomUUID(),
      confirmation: 'Owner Studio',
      reason: 'Close the organization following a fresh authenticated SSO review.',
    };
    expect(
      (await local.call(local.owner, 'POST', `/v1/organizations/${organization}/erasure`, input))
        .statusCode,
    ).toBe(403);
    await local.db.query('UPDATE sessions SET created_at=now() WHERE membership_id=$1', [
      local.ownerBoot.me.id,
    ]);
    const response = await local.call(
      local.owner,
      'POST',
      `/v1/organizations/${organization}/erasure`,
      input,
    );
    expect(response.statusCode, response.body).toBe(200);
  } finally {
    await local.close();
  }
}, 30000);
