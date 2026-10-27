import { afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { messagingFixture } from './messaging-fixture.js';
import { workspaceExtension, scimUserSchema, scimGroupSchema } from '../src/identity/scim.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  if (f) await f.close();
});
async function setup() {
  f = await messagingFixture();
  const org = (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0];
  const created = await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/scim/tokens`, {
    label: 'Identity provider',
    expiresInDays: 90,
  });
  expect(created.statusCode).toBe(201);
  const key = created.json();
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    payload?: unknown,
    etag?: string,
  ) =>
    f.app.inject({
      method,
      url: `/scim/v2/${org.id}` + path,
      headers: {
        authorization: 'Bearer ' + key.token,
        ...(payload === undefined ? {} : { 'content-type': 'application/scim+json' }),
        ...(etag ? { 'if-match': etag } : {}),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  return { org, key, call };
}
describe('organization SCIM provisioning', () => {
  it('deletes a user as a tombstone, hides it from SCIM reads, and reprovisions without restoring old grants', async () => {
    const { call } = await setup(),
      user = (
        await call('POST', '/Users', {
          userName: randomUUID() + '@deleted.test',
          displayName: 'Deleted user',
        })
      ).json();
    expect((await call('DELETE', '/Users/' + user.id)).statusCode).toBe(204);
    expect((await call('GET', '/Users/' + user.id)).statusCode).toBe(404);
    const restored = await call('POST', '/Users', {
      userName: user.userName,
      displayName: 'Returned user',
    });
    expect(restored.statusCode, restored.body).toBe(201);
    expect(restored.json().id).toBe(user.id);
    expect(restored.json().active).toBe(true);
  });
  it('protects discovery and credentials, returns standards-shaped discovery, and revokes tokens immediately', async () => {
    const { org, key, call } = await setup();
    expect((await f.app.inject(`/scim/v2/${org.id}/Users`)).statusCode).toBe(401);
    expect((await call('GET', '/ServiceProviderConfig')).json()).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      etag: { supported: true },
    });
    expect((await call('GET', '/Schemas')).json().totalResults).toBe(3);
    expect(
      (await call('GET', '/ResourceTypes')).json().Resources.map((r: { name: string }) => r.name),
    ).toEqual(['User', 'Group']);
    const other = (await f.call(f.other, 'GET', '/v1/organizations')).json()[0];
    expect(
      (
        await f.app.inject({
          url: `/scim/v2/${other.id}/Users`,
          headers: { authorization: 'Bearer ' + key.token },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.call(f.mate, 'POST', `/v1/organizations/${org.id}/scim/tokens`, {
          label: 'Forbidden key',
          expiresInDays: 1,
        })
      ).statusCode,
    ).toBe(403);
    const list = await f.call(f.owner, 'GET', `/v1/organizations/${org.id}/scim/tokens`);
    expect(list.body).not.toContain(key.token);
    await f.call(f.owner, 'DELETE', `/v1/organizations/${org.id}/scim/tokens/${key.id}`);
    expect((await call('GET', '/Users')).statusCode).toBe(401);
  });
  it('supports user creation, equality filtering, pagination, replacement and conditional PATCH without changing another tenant’s account', async () => {
    const { call } = await setup(),
      other = (await f.call(f.other, 'GET', '/v1/account')).json();
    const created = await call('POST', '/Users', {
      schemas: [scimUserSchema],
      userName: other.email,
      externalId: 'directory-123',
      displayName: 'Organization display name',
      active: true,
    });
    expect(created.statusCode).toBe(201);
    const user = created.json();
    expect(user.id).toBe(other.id);
    expect(user.meta.resourceType).toBe('User');
    expect((await f.call(f.other, 'GET', '/v1/account')).json().name).toBe(other.name);
    const filtered = await call(
      'GET',
      '/Users?filter=' + encodeURIComponent('externalId eq "directory-123"') + '&count=1',
    );
    expect(filtered.json().totalResults).toBe(1);
    expect(filtered.json().Resources[0].id).toBe(other.id);
    expect((await call('GET', '/Users?count=0')).json().itemsPerPage).toBe(0);
    const patch = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'displayName', value: 'Updated directory name' }],
    };
    const updated = await call('PATCH', '/Users/' + user.id, patch, created.headers.etag as string);
    expect(updated.statusCode).toBe(200);
    expect(updated.json().displayName).toBe('Updated directory name');
    expect(
      (await call('PATCH', '/Users/' + user.id, patch, created.headers.etag as string)).statusCode,
    ).toBe(412);
    expect(
      (
        await call('PUT', '/Users/' + user.id, {
          ...updated.json<Record<string, unknown>>(),
          userName: 'attacker@outside.test',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('GET', '/Users?filter=' + encodeURIComponent('userName pr'))).json().scimType,
    ).toBe('invalidFilter');
  });
  it('maps groups to organization workspaces and removes only provisioning-managed access', async () => {
    const { call } = await setup(),
      email = randomUUID() + '@managed.test';
    const created = await call('POST', '/Users', {
      userName: email,
      displayName: 'Directory member',
      externalId: 'managed-1',
    });
    expect(created.statusCode).toBe(201);
    const user = created.json();
    const group = await call('POST', '/Groups', {
      schemas: [scimGroupSchema, workspaceExtension],
      displayName: 'Engineering',
      members: [{ value: user.id }],
      [workspaceExtension]: { workspaceId: f.ownerBoot.workspace.id },
    });
    expect(group.statusCode).toBe(201);
    expect(
      (
        await f.db.query(
          'SELECT status,provisioned FROM memberships WHERE workspace_id=$1 AND account_id=$2',
          [f.ownerBoot.workspace.id, user.id],
        )
      )[0],
    ).toMatchObject({ status: 'active', provisioned: true });
    const patch = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'remove', path: `members[value eq "${user.id}"]` }],
    };
    expect((await call('PATCH', '/Groups/' + group.json().id, patch)).statusCode).toBe(200);
    expect(
      (
        await f.db.query('SELECT status FROM memberships WHERE workspace_id=$1 AND account_id=$2', [
          f.ownerBoot.workspace.id,
          user.id,
        ])
      )[0]!.status,
    ).toBe('suspended');
    const mate = (await f.call(f.mate, 'GET', '/v1/account')).json();
    const manual = await call('POST', '/Groups', {
      displayName: 'Manual member group',
      members: [{ value: mate.id }],
      [workspaceExtension]: { workspaceId: f.ownerBoot.workspace.id },
    });
    expect(manual.statusCode).toBe(201);
    expect((await call('DELETE', '/Groups/' + manual.json().id)).statusCode).toBe(204);
    expect((await f.call(f.mate, 'GET', '/v1/bootstrap')).statusCode).toBe(200);
  });
  it('deprovisions all organization workspaces, protects owners, and preserves other organizations', async () => {
    const { call } = await setup(),
      other = (await f.call(f.other, 'GET', '/v1/account')).json();
    await call('POST', '/Users', {
      userName: other.email,
      displayName: 'Shared account',
      externalId: 'shared-account',
    });
    const group = await call('POST', '/Groups', {
      displayName: 'Shared workspace',
      members: [{ value: other.id }],
      [workspaceExtension]: { workspaceId: f.ownerBoot.workspace.id },
    });
    expect(group.statusCode).toBe(201);
    const deactivate = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    };
    expect((await call('PATCH', '/Users/' + other.id, deactivate)).statusCode).toBe(200);
    expect((await f.call(f.other, 'GET', '/v1/bootstrap')).statusCode).toBe(200);
    expect(
      (
        await f.db.query('SELECT status FROM memberships WHERE workspace_id=$1 AND account_id=$2', [
          f.ownerBoot.workspace.id,
          other.id,
        ])
      )[0]!.status,
    ).toBe('suspended');
    const owner = (await f.call(f.owner, 'GET', '/v1/account')).json();
    expect((await call('PATCH', '/Users/' + owner.id, deactivate)).statusCode).toBe(409);
    expect((await call('GET', '/Groups/' + group.json().id)).json().members).toEqual([]);
  });
  it('rejects cross-organization group members and workspace mappings atomically', async () => {
    const { call } = await setup(),
      other = (await f.call(f.other, 'GET', '/v1/account')).json();
    const before = (await call('GET', '/Groups')).json().totalResults;
    expect(
      (
        await call('POST', '/Groups', {
          displayName: 'Forbidden group',
          members: [{ value: other.id }],
          [workspaceExtension]: { workspaceId: f.ownerBoot.workspace.id },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('POST', '/Groups', {
          displayName: 'Forbidden workspace',
          members: [],
          [workspaceExtension]: { workspaceId: f.otherBoot.workspace.id },
        })
      ).statusCode,
    ).toBe(400);
    expect((await call('GET', '/Groups')).json().totalResults).toBe(before);
  });
});
