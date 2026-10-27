import { afterEach, describe, it, expect } from 'vitest';
import { messagingFixture } from './messaging-fixture.js';
import { oidcFixture, samlFixture } from './federation-fixture.js';
import { verifyFixtureAccount } from './email.js';
let f: Awaited<ReturnType<typeof messagingFixture>> | undefined,
  idp: Awaited<ReturnType<typeof oidcFixture>> | undefined;
afterEach(async () => {
  await f?.close();
  await idp?.close();
  f = undefined;
  idp = undefined;
});
describe('federated authentication', () => {
  it('requires explicit JIT enablement and verified domain ownership before admitting a new federated account', async () => {
    idp = await oidcFixture();
    let records: string[][] = [];
    f = await messagingFixture(undefined, undefined, {
      federation: { allowedHosts: ['127.0.0.1'], allowLoopback: true },
      organization: { resolveDomain: async () => records },
    });
    const org = (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0],
      email = 'new-user@verified.test';
    const domain = (
      await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/domains`, {
        domain: 'verified.test',
      })
    ).json();
    records = [[domain.value]];
    await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/domains/${domain.id}/verify`, {});
    const input = {
      protocol: 'oidc',
      name: 'Verified domain IdP',
      issuer: idp.origin,
      clientId: 'orbit-client',
      clientSecret: 'test-client-secret',
      workspaceId: f.ownerBoot.workspace.id,
    };
    async function login(provider: string) {
      const start = await f!.call('', 'GET', `/v1/auth/federation/${provider}/start`),
        proof = idp!.code(start.headers.location as string, email);
      return f!.app.inject({
        url: `/v1/auth/federation/${provider}/callback?` + new URLSearchParams(proof),
        headers: { cookie: `ao_federation=${start.cookies[0]!.value}` },
      });
    }
    const disabled = (
      await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/providers`, input)
    ).json();
    expect((await login(disabled.id)).statusCode).toBe(403);
    expect(await f.db.query('SELECT id FROM accounts WHERE email=$1', [email])).toEqual([]);
    const enabled = (
        await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/providers`, {
          ...input,
          jitProvisioning: true,
        })
      ).json(),
      response = await login(enabled.id);
    expect(response.statusCode, response.body).toBe(302);
    expect(
      (await f.boot(response.cookies.find((c) => c.name === 'ao_session')!.value)).workspace.id,
    ).toBe(f.ownerBoot.workspace.id);
  });
  it('binds SSO assurance to the destination organization for both old sessions and workspace switching', async () => {
    idp = await oidcFixture();
    f = await messagingFixture(undefined, undefined, {
      federation: { allowedHosts: ['127.0.0.1'], allowLoopback: true },
    });
    const org = (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0],
      account = (await f.call(f.owner, 'GET', '/v1/account')).json();
    const provider = (
      await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/providers`, {
        protocol: 'oidc',
        name: 'Source organization IdP',
        issuer: idp.origin,
        clientId: 'orbit-client',
        clientSecret: 'test-client-secret',
        workspaceId: f.ownerBoot.workspace.id,
      })
    ).json();
    async function login(link = false) {
      const begin = await f!.call(
          link ? f!.owner : '',
          'GET',
          `/v1/auth/federation/${provider.id}/start${link ? '?link=true' : ''}`,
        ),
        proof = idp!.code(begin.headers.location as string, account.email),
        result = await f!.app.inject({
          url: `/v1/auth/federation/${provider.id}/callback?` + new URLSearchParams(proof),
          headers: { cookie: `ao_federation=${begin.cookies[0]!.value}` },
        });
      expect(result.statusCode, result.body).toBe(302);
      return result.cookies.find((c) => c.name === 'ao_session')!.value;
    }
    const source = await login(true),
      other = (
        await f.call(source, 'POST', '/v1/organizations', { name: 'Destination organization' })
      ).json();
    const workspace = (
      await f.call(source, 'POST', `/v1/organizations/${other.id}/workspaces`, {
        name: 'Destination workspace',
        region: 'global',
      })
    ).json();
    const second = await login(),
      switched = await f.call(second, 'POST', '/v1/workspaces/switch', {
        membershipId: workspace.membershipId,
      });
    expect(switched.statusCode).toBe(200);
    const foreignSession = switched.cookies[0]!.value;
    await f.db.query('UPDATE organizations SET require_sso=true WHERE id=$1', [other.id]);
    expect((await f.call(foreignSession, 'GET', '/v1/bootstrap')).json().error.code).toBe(
      'SSO_REQUIRED',
    );
    expect(
      (await f.call(source, 'GET', `/v1/organizations/${other.id}/members`)).json().error.code,
    ).toBe('SSO_REQUIRED');
    expect(
      (
        await f.call(source, 'POST', '/v1/workspaces/switch', {
          membershipId: workspace.membershipId,
        })
      ).json().error.code,
    ).toBe('SSO_REQUIRED');
    expect((await f.call(source, 'GET', '/v1/bootstrap')).statusCode).toBe(200);
  });
  it('allows directory-created accounts to establish a first federated session only with matching external ID, domain proof, and a workspace grant', async () => {
    idp = await oidcFixture();
    let records: string[][] = [];
    f = await messagingFixture(undefined, undefined, {
      federation: { allowedHosts: ['127.0.0.1'], allowLoopback: true },
      organization: { resolveDomain: async () => records },
    });
    const org = (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0],
      email = 'managed-user@managed.test';
    const domain = (
      await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/domains`, {
        domain: 'managed.test',
      })
    ).json();
    records = [[domain.value]];
    expect(
      (await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/domains/${domain.id}/verify`, {}))
        .statusCode,
    ).toBe(200);
    const credential = (
      await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/scim/tokens`, {
        label: 'Managed directory',
      })
    ).json();
    const scim = (path: string, payload: unknown) =>
      f!.app.inject({
        method: 'POST',
        url: `/scim/v2/${org.id}` + path,
        headers: {
          authorization: 'Bearer ' + credential.token,
          'content-type': 'application/json',
        },
        payload: JSON.stringify(payload),
      });
    const grantedWorkspace = (
      await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/workspaces`, {
        name: 'Directory-only workspace',
        region: 'global',
      })
    ).json();
    const user = await scim('/Users', {
      userName: email,
      externalId: 'subject-' + email,
      displayName: 'Managed user',
    });
    expect(user.statusCode).toBe(201);
    expect(
      (
        await scim('/Groups', {
          displayName: 'Managed workspace',
          members: [{ value: user.json().id }],
          'urn:orbit:params:scim:schemas:extension:workspace:2.0:Group': {
            workspaceId: grantedWorkspace.id,
          },
        })
      ).statusCode,
    ).toBe(201);
    const provider = (
      await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/providers`, {
        protocol: 'oidc',
        name: 'Managed IdP',
        issuer: idp.origin,
        clientId: 'orbit-client',
        clientSecret: 'test-client-secret',
        workspaceId: f.ownerBoot.workspace.id,
      })
    ).json();
    const begin = await f.call('', 'GET', `/v1/auth/federation/${provider.id}/start`),
      proof = idp.code(begin.headers.location as string, email),
      result = await f.app.inject({
        url: `/v1/auth/federation/${provider.id}/callback?` + new URLSearchParams(proof),
        headers: { cookie: `ao_federation=${begin.cookies[0]!.value}` },
      });
    expect(result.statusCode, result.body).toBe(302);
    const session = result.cookies.find((c) => c.name === 'ao_session')!.value;
    expect((await f.call(session, 'GET', '/v1/account')).json().email).toBe(email);
    expect((await f.boot(session)).workspace.id).toBe(grantedWorkspace.id);
  });
  it('completes signed OIDC with PKCE and explicit linking, rejects nonce mismatch and replay, and enforces SSO', async () => {
    idp = await oidcFixture();
    f = await messagingFixture(undefined, undefined, {
      federation: { allowedHosts: ['127.0.0.1'], allowLoopback: true },
    });
    const org = (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0],
      account = (await f.call(f.owner, 'GET', '/v1/account')).json();
    const created = await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/providers`, {
      protocol: 'oidc',
      name: 'Test OIDC',
      issuer: idp.origin,
      clientId: 'orbit-client',
      clientSecret: 'test-client-secret',
      workspaceId: f.ownerBoot.workspace.id,
    });
    expect(created.statusCode).toBe(201);
    const provider = created.json();
    expect(
      (await f.call(f.owner, 'GET', `/v1/organizations/${org.id}/providers`)).body,
    ).not.toContain('test-client-secret');
    const start = () =>
      f!.call(f!.owner, 'GET', `/v1/auth/federation/${provider.id}/start?link=true`);
    const begin = await start();
    expect(begin.statusCode).toBe(302);
    const proof = idp.code(begin.headers.location as string, account.email),
      cookie = begin.cookies.find((c) => c.name === 'ao_federation')!.value;
    const callback = (proof: { code: string; state: string }, cookieValue = cookie) =>
      f!.app.inject({
        url: `/v1/auth/federation/${provider.id}/callback?` + new URLSearchParams(proof),
        headers: { cookie: `ao_federation=${cookieValue}; ao_session=${f!.owner}` },
      });
    expect((await callback(proof, 'wrong-browser')).statusCode).toBe(401);
    const completed = await callback(proof);
    expect(completed.statusCode).toBe(302);
    const session = completed.cookies.find((c) => c.name === 'ao_session')!.value;
    expect((await f.boot(session)).me.id).toBe(f.ownerBoot.me.id);
    expect((await callback(proof)).statusCode).toBe(401);
    const bad = await start(),
      badCode = idp.code(bad.headers.location as string, account.email, { nonce: 'wrong-nonce' });
    expect(
      (await callback(badCode, bad.cookies.find((c) => c.name === 'ao_federation')!.value))
        .statusCode,
    ).toBe(401);
    const policy = {
      name: org.name,
      allowedDomains: [],
      allowedRegions: ['global'],
      requireMfa: false,
      requireSso: true,
      sessionHours: 168,
      version: org.version,
    };
    const unsigned = await start(),
      unsignedCode = idp.code(unsigned.headers.location as string, account.email, {
        invalidSignature: true,
      });
    expect(
      (
        await callback(
          unsignedCode,
          unsigned.cookies.find((c) => c.name === 'ao_federation')!.value,
        )
      ).statusCode,
    ).toBe(401);
    expect((await f.call(f.owner, 'PATCH', `/v1/organizations/${org.id}`, policy)).statusCode).toBe(
      409,
    );
    expect((await f.call(session, 'PATCH', `/v1/organizations/${org.id}`, policy)).statusCode).toBe(
      200,
    );
    expect((await f.call(f.owner, 'GET', '/v1/bootstrap')).json().error.code).toBe('SSO_REQUIRED');
    expect((await f.call(session, 'GET', '/v1/bootstrap')).statusCode).toBe(200);
    const invitedEmail = 'invited-sso@members.test';
    const invitation = await f.call(session, 'POST', '/v1/invitations', { email: invitedEmail });
    expect(invitation.statusCode).toBe(201);
    const accepted = await f.call('', 'POST', '/v1/invitations/accept', {
      token: invitation.json().token,
      name: 'Invited SSO user',
      password: 'invited-sso-test-password',
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    await verifyFixtureAccount(f.db, invitedEmail);
    const accountOnly = accepted.cookies.find((c) => c.name === 'ao_session')!.value;
    expect((await f.call(accountOnly, 'GET', '/v1/bootstrap')).json().error.code).toBe(
      'WORKSPACE_REQUIRED',
    );
    const link = await f.call(
        accountOnly,
        'GET',
        `/v1/auth/federation/${provider.id}/start?link=true`,
      ),
      invitedProof = idp.code(link.headers.location as string, invitedEmail);
    const invitedLogin = await f.app.inject({
      url: `/v1/auth/federation/${provider.id}/callback?` + new URLSearchParams(invitedProof),
      headers: { cookie: `ao_federation=${link.cookies[0]!.value}` },
    });
    expect(invitedLogin.statusCode, invitedLogin.body).toBe(302);
    expect(
      (await f.boot(invitedLogin.cookies.find((c) => c.name === 'ao_session')!.value)).me.name,
    ).toBe('Invited SSO user');
    expect(
      (await f.call(session, 'DELETE', `/v1/organizations/${org.id}/providers/${provider.id}`))
        .statusCode,
    ).toBe(409);
  });
  it('does not auto-link existing accounts by email and rejects provider hosts outside the operator allowlist', async () => {
    idp = await oidcFixture();
    f = await messagingFixture(undefined, undefined, {
      federation: { allowedHosts: ['127.0.0.1'], allowLoopback: true },
    });
    const org = (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0],
      account = (await f.call(f.owner, 'GET', '/v1/account')).json();
    const input = {
      protocol: 'oidc',
      name: 'Company IdP',
      issuer: idp.origin,
      clientId: 'orbit-client',
      clientSecret: 'test-client-secret',
      workspaceId: f.ownerBoot.workspace.id,
    };
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/providers`, {
          ...input,
          issuer: 'https://untrusted.example',
        })
      ).json().error.code,
    ).toBe('PROVIDER_HOST_NOT_ALLOWED');
    const provider = (
        await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/providers`, input)
      ).json(),
      begin = await f.call('', 'GET', `/v1/auth/federation/${provider.id}/start`),
      proof = idp.code(begin.headers.location as string, account.email);
    const response = await f.app.inject({
      url: `/v1/auth/federation/${provider.id}/callback?` + new URLSearchParams(proof),
      headers: { cookie: `ao_federation=${begin.cookies[0]!.value}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('IDENTITY_LINK_REQUIRED');
    const outsider = (await f.call(f.other, 'GET', '/v1/account')).json();
    const outsideStart = await f.call(
        f.other,
        'GET',
        `/v1/auth/federation/${provider.id}/start?link=true`,
      ),
      outsideProof = idp.code(outsideStart.headers.location as string, outsider.email);
    const outsideCallback = await f.app.inject({
      url: `/v1/auth/federation/${provider.id}/callback?` + new URLSearchParams(outsideProof),
      headers: { cookie: `ao_federation=${outsideStart.cookies[0]!.value}` },
    });
    expect(outsideCallback.statusCode).toBe(403);
    expect(outsideCallback.json().error.code).toBe('ORGANIZATION_INVITATION_REQUIRED');
    expect(
      await f.db.query(
        'SELECT * FROM organization_members WHERE organization_id=$1 AND account_id=$2',
        [org.id, outsider.id],
      ),
    ).toEqual([]);
    expect((await f.db.query('SELECT * FROM federated_identities')).length).toBe(0);
  });
  it('validates real signed SAML assertions and responses, binds InResponseTo, and rejects audience mismatch and tampering', async () => {
    const saml = await samlFixture();
    f = await messagingFixture(undefined, undefined, {
      federation: { allowedHosts: ['idp.test'] },
    });
    const org = (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0],
      account = (await f.call(f.owner, 'GET', '/v1/account')).json();
    const created = await f.call(f.owner, 'POST', `/v1/organizations/${org.id}/providers`, {
      protocol: 'saml',
      name: 'Test SAML',
      entryPoint: 'https://idp.test/sso',
      issuer: 'https://idp.test',
      idpCert: saml.certificate,
      workspaceId: f.ownerBoot.workspace.id,
    });
    expect(created.statusCode).toBe(201);
    const provider = created.json();
    const start = () =>
      f!.call(f!.owner, 'GET', `/v1/auth/federation/${provider.id}/start?link=true`);
    async function complete(
      options: { audience?: string; requestId?: string; tamper?: boolean } = {},
    ) {
      const begin = await start();
      expect(begin.statusCode).toBe(302);
      const body = saml.response(
        begin.headers.location as string,
        provider.callbackUrl,
        account.email,
        options,
      );
      if (options.tamper)
        body.SAMLResponse = Buffer.from(
          Buffer.from(body.SAMLResponse, 'base64')
            .toString()
            .replace(account.email, 'attacker@example.test'),
        ).toString('base64');
      const invoke = () =>
        f!.app.inject({
          method: 'POST',
          url: `/v1/auth/federation/${provider.id}/callback`,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://idp.test',
            cookie: `ao_federation=${begin.cookies[0]!.value}`,
          },
          payload: new URLSearchParams(body).toString(),
        });
      return { response: await invoke(), invoke };
    }
    expect((await complete({ audience: 'https://wrong-audience.test' })).response.statusCode).toBe(
      401,
    );
    expect((await complete({ requestId: '_unknown' })).response.statusCode).toBe(401);
    expect((await complete({ tamper: true })).response.statusCode).toBe(401);
    const first = await start(),
      second = await start();
    const differentRequest = saml.response(
      first.headers.location as string,
      provider.callbackUrl,
      account.email,
    );
    const differentState = new URL(second.headers.location as string).searchParams.get(
      'RelayState',
    )!;
    const swapped = await f.app.inject({
      method: 'POST',
      url: `/v1/auth/federation/${provider.id}/callback`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `ao_federation=${second.cookies[0]!.value}`,
      },
      payload: new URLSearchParams({ ...differentRequest, RelayState: differentState }).toString(),
    });
    expect(swapped.statusCode).toBe(401);
    const valid = await complete();
    expect(valid.response.statusCode, valid.response.body).toBe(302);
    expect((await valid.invoke()).statusCode).toBe(401);
    expect(
      (await f.boot(valid.response.cookies.find((c) => c.name === 'ao_session')!.value)).me.id,
    ).toBe(f.ownerBoot.me.id);
    const metadata = await f.call(
      '',
      'GET',
      `/v1/auth/federation/${provider.id}/callback/metadata`,
    );
    expect(metadata.statusCode).toBe(200);
    expect(metadata.body).toContain('EntityDescriptor');
  });
});
