import { afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { identityScope, tenantScope, identifyPrincipal, scopedDatabase } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { testEmail, verifyFixtureAccount } from './email.js';
import { digest } from '../src/lib/security.js';
type Fixture = Awaited<ReturnType<typeof messagingFixture>>;
let f: Fixture;
afterEach(async () => {
  if (f) await f.close();
});
async function org() {
  return (await f.call(f.owner, 'GET', '/v1/organizations')).json()[0] as {
    id: string;
    version: number;
    name: string;
  };
}
async function profile(session = f.owner) {
  return (await f.call(session, 'GET', '/v1/account')).json();
}
async function signin(session = f.owner) {
  const account = await profile(session);
  return f.call('', 'POST', '/v1/auth/signin', {
    email: account.email,
    password: 'messaging-test-password',
  });
}
describe('account and organization management', () => {
  it('enforces the destination organization session lifetime while another workspace session remains valid', async () => {
    f = await messagingFixture();
    const created = await f.call(f.owner, 'POST', '/v1/organizations', {
      name: 'Short-session organization',
    });
    expect(created.statusCode).toBe(201);
    const organization = created.json();
    const targetWorkspace = (
      await f.call(f.owner, 'POST', `/v1/organizations/${organization.id}/workspaces`, {
        name: 'Short-session workspace',
        region: 'global',
      })
    ).json();
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/organizations/${organization.id}`, {
          name: 'Short-session organization',
          allowedDomains: [],
          allowedRegions: ['global'],
          requireMfa: false,
          requireSso: false,
          sessionHours: 1,
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    await identityScope(() =>
      f.db.query("UPDATE sessions SET created_at=now()-interval '2 hours' WHERE token_hash=$1", [
        digest(f.owner),
      ]),
    );
    expect((await f.call(f.owner, 'GET', '/v1/bootstrap')).statusCode).toBe(200);
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/workspaces/switch', {
          membershipId: targetWorkspace.membershipId,
        })
      ).json().error.code,
    ).toBe('SESSION_REAUTHENTICATION_REQUIRED');
    expect(
      (await f.call(f.owner, 'GET', `/v1/organizations/${organization.id}/members`)).statusCode,
    ).toBe(401);
    const fresh = await signin();
    expect(
      (await f.call(fresh.cookies[0]!.value, 'GET', `/v1/organizations/${organization.id}/members`))
        .statusCode,
    ).toBe(200);
  });
  it('lets a successor organization owner grant workspace access without changing their owner role', async () => {
    f = await messagingFixture();
    const organization = await org(),
      mate = await profile(f.mate);
    const workspace = (
      await f.call(f.owner, 'POST', `/v1/organizations/${organization.id}/workspaces`, {
        name: 'Inherited workspace',
        region: 'global',
      })
    ).json();
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/organizations/${organization.id}/transfer-ownership`, {
          accountId: mate.id,
          version: organization.version,
        })
      ).statusCode,
    ).toBe(200);
    const grant = await f.call(f.mate, 'POST', `/v1/organizations/${organization.id}/members`, {
      accountId: mate.id,
      workspaceIds: [workspace.id],
    });
    expect(grant.statusCode, grant.body).toBe(200);
    expect((await f.call(f.mate, 'GET', '/v1/organizations')).json()[0].role).toBe('owner');
    const spaces = (
      await f.call(f.mate, 'GET', `/v1/organizations/${organization.id}/workspaces`)
    ).json();
    expect(spaces.find((s: { id: string }) => s.id === workspace.id).membership_id).toBeTruthy();
  });
  it('allows an offboarded account to accept a new invitation without recovering old workspace access', async () => {
    f = await messagingFixture();
    const organization = await org(),
      account = await profile(f.mate),
      members = (
        await f.call(f.owner, 'GET', `/v1/organizations/${organization.id}/members`)
      ).json(),
      member = members.find((m: { account_id: string }) => m.account_id === account.id);
    expect(
      (
        await f.call(
          f.owner,
          'POST',
          `/v1/organizations/${organization.id}/members/${account.id}/offboard`,
          { version: member.version },
        )
      ).statusCode,
    ).toBe(200);
    const login = await f.call('', 'POST', '/v1/auth/signin', {
      email: account.email,
      password: 'messaging-test-password',
    });
    expect(login.statusCode).toBe(200);
    const session = login.cookies[0]!.value;
    expect((await f.call(session, 'GET', '/v1/account')).statusCode).toBe(200);
    expect((await f.call(session, 'GET', '/v1/bootstrap')).json().error.code).toBe(
      'WORKSPACE_REQUIRED',
    );
    expect((await f.call(session, 'GET', '/v1/organizations')).json()).toEqual([]);
    const invitation = await f.call(f.other, 'POST', '/v1/invitations', { email: account.email });
    expect(invitation.statusCode).toBe(201);
    const accepted = await f.call(session, 'POST', '/v1/invitations/accept', {
      token: invitation.json().token,
    });
    expect(accepted.statusCode).toBe(201);
    const next = accepted.cookies[0]!.value;
    expect((await f.boot(next)).workspace.id).toBe(f.otherBoot.workspace.id);
    expect(
      (await f.call(next, 'GET', `/v1/organizations/${organization.id}/workspaces`)).statusCode,
    ).toBe(404);
  });
  it('revokes service credentials issued by an offboarded owner and preserves a successor', async () => {
    f = await messagingFixture();
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/workspaces/transfer-ownership', {
          membershipId: f.mateBoot.me.id,
        })
      ).statusCode,
    ).toBe(200);
    const created = await f.call(f.mate, 'POST', '/v1/service-accounts', {
      name: 'Departing owner service',
      permissions: ['messages.read'],
      conversationIds: [f.ownerBoot.channels[0]!.id],
    });
    expect(created.statusCode).toBe(201);
    const agent = (
      await f.call(f.mate, 'POST', '/v1/agents', {
        name: 'Departing owner agent',
        role: 'Summarize decisions',
        runtime: 'external',
      })
    ).json();
    const hosted = (
      await f.call(f.mate, 'POST', '/v1/agents', {
        name: 'Departing hosted agent',
        role: 'Summarize decisions',
        runtime: 'managed',
      })
    ).json();
    const inbox = (key: string) =>
      f.app.inject({ url: '/v1/agent/inbox', headers: { authorization: 'Bearer ' + key } });
    expect((await inbox(agent.key)).statusCode).toBe(200);
    const member = (await f.call(f.mate, 'GET', '/v1/members'))
      .json()
      .find((m: { id: string }) => m.id === f.mateBoot.me.id);
    expect(
      (
        await f.call(f.mate, 'POST', `/v1/members/${member.id}/offboard`, {
          successorId: f.ownerBoot.me.id,
          version: member.version,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          url: `/v1/conversations/${f.ownerBoot.channels[0]!.id}/messages`,
          headers: { authorization: 'Bearer ' + created.json().token },
        })
      ).statusCode,
    ).toBe(401);
    expect((await f.boot(f.owner)).me.role).toBe('owner');
    const agents = (await f.call(f.owner, 'GET', '/v1/agents')).json();
    for (const id of [agent.id, hosted.id])
      expect(agents.find((a: { id: string }) => a.id === id)).toMatchObject({
        status: 'paused',
        owner_id: f.ownerBoot.me.id,
      });
    await f.call(f.owner, 'PATCH', `/v1/agents/${agent.id}`, { status: 'active' });
    expect((await inbox(agent.key)).statusCode).toBe(401);
    const rotated = await f.call(f.owner, 'POST', `/v1/agents/${agent.id}/credentials/rotate`, {});
    expect(rotated.statusCode).toBe(200);
    expect((await inbox(rotated.json().key)).statusCode).toBe(401);
    await f.call(f.owner, 'PATCH', `/v1/agents/${agent.id}`, { status: 'active' });
    expect((await inbox(rotated.json().key)).statusCode).toBe(200);
    expect((await inbox(agent.key)).statusCode).toBe(401);
  });
  it('creates multiple isolated workspaces under an organization and switches without exposing another organization', async () => {
    f = await messagingFixture();
    const organization = await org();
    const created = await f.call(
      f.owner,
      'POST',
      `/v1/organizations/${organization.id}/workspaces`,
      { name: 'Second workspace', region: 'global' },
    );
    expect(created.statusCode).toBe(201);
    const spaces = await f.call(f.owner, 'GET', `/v1/organizations/${organization.id}/workspaces`);
    expect(spaces.json()).toHaveLength(2);
    expect(
      (await f.call(f.other, 'GET', `/v1/organizations/${organization.id}/workspaces`)).statusCode,
    ).toBe(404);
    expect(
      (
        await f.call(f.mate, 'POST', `/v1/organizations/${organization.id}/workspaces`, {
          name: 'Forbidden workspace',
          region: 'global',
        })
      ).statusCode,
    ).toBe(403);
    await identityScope(() =>
      f.db.query("UPDATE sessions SET created_at=now()-interval '2 hours' WHERE token_hash=$1", [
        digest(f.owner),
      ]),
    );
    const switched = await f.call(f.owner, 'POST', '/v1/workspaces/switch', {
      membershipId: created.json().membershipId,
    });
    expect(switched.statusCode).toBe(200);
    const boot = await f.boot(switched.cookies[0]!.value);
    expect(boot.workspace.name).toBe('Second workspace');
    expect(boot.channels).toHaveLength(1);
    const [rotated] = await identityScope(() =>
      f.db.query(
        "SELECT created_at<now()-interval '1 hour' old_authentication FROM sessions WHERE token_hash=$1",
        [digest(switched.cookies[0]!.value)],
      ),
    );
    expect(rotated?.old_authentication).toBe(true);
    expect((await f.call(f.owner, 'GET', '/v1/bootstrap')).statusCode).toBe(401);
  });
  it('requires real domain proof, enforces member domains and deployment regions, and protects policy versions', async () => {
    let records: string[][] = [];
    f = await messagingFixture(undefined, undefined, {
      organization: { resolveDomain: async () => records },
    });
    const organization = await org(),
      account = await profile(),
      domain = String(account.email).split('@')[1];
    const claim = await f.call(f.owner, 'POST', `/v1/organizations/${organization.id}/domains`, {
      domain,
    });
    expect(claim.statusCode).toBe(201);
    const verify = `/v1/organizations/${organization.id}/domains/${claim.json().id}/verify`;
    expect((await f.call(f.owner, 'POST', verify, {})).statusCode).toBe(409);
    records = [[claim.json().value.slice(0, 20), claim.json().value.slice(20)]];
    expect((await f.call(f.owner, 'POST', verify, {})).statusCode).toBe(200);
    const policy = {
      name: organization.name,
      allowedDomains: [domain],
      allowedRegions: ['global', 'eu'],
      requireMfa: false,
      requireSso: false,
      sessionHours: 24,
      version: organization.version,
    };
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/organizations/${organization.id}`, policy)).statusCode,
    ).toBe(200);
    expect(
      (await f.call(f.owner, 'PATCH', `/v1/organizations/${organization.id}`, policy)).statusCode,
    ).toBe(409);
    expect(
      (await f.call(f.owner, 'POST', '/v1/invitations', { email: 'outside@another.test' })).json()
        .error.code,
    ).toBe('DOMAIN_RESTRICTED');
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/organizations/${organization.id}/workspaces`, {
          name: 'Wrong deployment',
          region: 'eu',
        })
      ).json().error.code,
    ).toBe('REGION_DEPLOYMENT_REQUIRED');
    expect(
      (
        await f.call(
          f.owner,
          'DELETE',
          `/v1/organizations/${organization.id}/domains/${claim.json().id}`,
        )
      ).json().error.code,
    ).toBe('DOMAIN_IN_USE');
    expect(
      (
        await f.call(f.other, 'POST', `/v1/organizations/${organization.id}/domains`, {
          domain: 'other.test',
        })
      ).statusCode,
    ).toBe(404);
  });
  it('updates the global profile, protects session ownership, and changes passwords with complete session invalidation', async () => {
    f = await messagingFixture();
    const second = await signin(),
      session = second.cookies[0]!.value;
    const changed = await f.call(f.owner, 'PATCH', '/v1/account', {
      name: 'Updated Owner',
      timeZone: 'Asia/Kolkata',
      locale: 'en-GB',
    });
    expect(changed.statusCode).toBe(200);
    expect((await f.boot(f.owner)).me.name).toBe('Updated Owner');
    const devices = (await f.call(f.owner, 'GET', '/v1/account/sessions')).json();
    expect(devices).toHaveLength(2);
    expect(devices.some((s: { current: boolean }) => s.current)).toBe(true);
    expect(JSON.stringify(devices)).not.toContain(digest(f.owner));
    expect(
      (await f.call(f.other, 'DELETE', '/v1/account/sessions/' + devices[0].id)).statusCode,
    ).toBe(404);
    const change = '/v1/account/password';
    expect(
      (
        await f.call(f.owner, 'POST', change, {
          password: 'incorrect',
          newPassword: 'a-new-account-password',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.call(f.owner, 'POST', change, {
          password: 'messaging-test-password',
          newPassword: 'a-new-account-password',
        })
      ).statusCode,
    ).toBe(200);
    for (const old of [f.owner, session])
      expect((await f.call(old, 'GET', '/v1/bootstrap')).statusCode).toBe(401);
    const email = (
      await f.db.query('SELECT email FROM accounts WHERE name=$1', ['Updated Owner'])
    )[0]!.email;
    expect(
      (await f.call('', 'POST', '/v1/auth/signin', { email, password: 'a-new-account-password' }))
        .statusCode,
    ).toBe(200);
  });
  it('keeps the original email until the new address is verified, consumes the proof once, and revokes sessions', async () => {
    f = await messagingFixture();
    const before = await profile(),
      email = randomUUID() + '@new.test';
    expect(
      (
        await f.call(f.owner, 'POST', '/v1/account/email', {
          password: 'messaging-test-password',
          email,
        })
      ).statusCode,
    ).toBe(200);
    expect((await profile()).email).toBe(before.email);
    expect((await profile()).pending_email).toBe(email);
    const [job] = await f.db.query(
      "SELECT j.id,j.ciphertext FROM email_jobs j JOIN account_tokens t ON t.id=j.account_token_id WHERE t.account_id=$1 AND t.purpose='change_email' AND t.consumed_at IS NULL",
      [before.id],
    );
    const message = testEmail().decrypt(String(job!.id), String(job!.ciphertext));
    expect(message.to).toEqual([email]);
    const token = message.text.match(/\/change-email#([\w-]{43})/)![1];
    expect((await f.call('', 'POST', '/v1/auth/email/confirm', { token })).statusCode).toBe(200);
    expect((await f.call(f.owner, 'GET', '/v1/bootstrap')).statusCode).toBe(401);
    expect((await f.call('', 'POST', '/v1/auth/email/confirm', { token })).statusCode).toBe(410);
    expect(
      (await f.call('', 'POST', '/v1/auth/signin', { email, password: 'messaging-test-password' }))
        .statusCode,
    ).toBe(200);
  });
  it('encrypts authenticator seeds, requires MFA on sign-in, rejects replay, and consumes recovery codes atomically', async () => {
    f = await messagingFixture();
    const account = await profile();
    const enrolled = await f.call(f.owner, 'POST', '/v1/account/mfa/enroll', {
      password: 'messaging-test-password',
    });
    expect(enrolled.statusCode).toBe(200);
    const secret = enrolled.json().secret;
    expect(
      (await f.db.query('SELECT secret FROM account_mfa WHERE account_id=$1', [account.id]))[0]!
        .secret,
    ).not.toContain(secret);
    const code = await generate({ secret });
    const confirmed = await f.call(f.owner, 'POST', '/v1/account/mfa/confirm', { code });
    expect(confirmed.statusCode).toBe(200);
    f.owner = confirmed.cookies.find((c) => c.name === 'ao_session')!.value;
    expect(confirmed.json().recoveryCodes).toHaveLength(10);
    const login = await signin();
    expect(login.json().mfaRequired).toBe(true);
    expect(login.cookies.find((c) => c.name === 'ao_session')?.value).toBe('');
    const challenge = login.cookies.find((c) => c.name === 'ao_mfa')!.value;
    const verify = (value: string) =>
      f.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa',
        headers: { cookie: `ao_mfa=${challenge}` },
        payload: { code: value },
      });
    expect((await verify(code)).statusCode).toBe(401);
    const recovery = confirmed.json().recoveryCodes[0];
    const accepted = await verify(recovery);
    expect(accepted.statusCode).toBe(200);
    expect((await verify(recovery)).statusCode).toBe(401);
    expect(
      (await f.boot(accepted.cookies.find((c) => c.name === 'ao_session')!.value)).workspace.id,
    ).toBe(f.ownerBoot.workspace.id);
    const stored = (
      await f.db.query('SELECT recovery_hashes FROM account_mfa WHERE account_id=$1', [account.id])
    )[0]!.recovery_hashes as string[];
    expect(stored).toHaveLength(9);
    expect(stored).not.toContain(recovery);
  });
  it('persists MFA attempt limits across new requests and gates members when the organization requires MFA', async () => {
    f = await messagingFixture();
    const enrolled = await f.call(f.owner, 'POST', '/v1/account/mfa/enroll', {
      password: 'messaging-test-password',
    });
    const confirmed = await f.call(f.owner, 'POST', '/v1/account/mfa/confirm', {
      code: await generate({ secret: enrolled.json().secret }),
    });
    f.owner = confirmed.cookies.find((c) => c.name === 'ao_session')!.value;
    const organization = await org();
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/organizations/${organization.id}`, {
          name: organization.name,
          allowedDomains: [],
          allowedRegions: ['global'],
          requireMfa: true,
          requireSso: false,
          sessionHours: 168,
          version: organization.version,
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.call(f.mate, 'GET', '/v1/bootstrap')).json().error.code).toBe(
      'MFA_ENROLLMENT_REQUIRED',
    );
    expect((await f.call(f.mate, 'GET', '/v1/account')).statusCode).toBe(200);
    const login = await signin();
    const challenge = login.cookies.find((c) => c.name === 'ao_mfa')!.value;
    for (let i = 0; i < 6; i++)
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/v1/auth/mfa',
            headers: { cookie: `ao_mfa=${challenge}` },
            remoteAddress: `127.10.1.${i + 1}`,
            payload: { code: 'bad-code' },
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await f.db.query('SELECT attempts FROM authentication_challenges WHERE token_hash=$1', [
          digest(challenge),
        ])
      )[0]!.attempts,
    ).toBe(5);
  });
  it('restricts guest content in PostgreSQL even when the query omits audience filters', async () => {
    f = await messagingFixture();
    const shared = f.ownerBoot.channels[0]!.id,
      hidden = f.ownerBoot.channels[1]!.id;
    await f.send(f.owner, shared, 'Shared guest conversation');
    await f.send(f.owner, hidden, 'Confidential internal conversation');
    await f.call(f.owner, 'POST', '/v1/tasks', {
      title: 'Shared guest task',
      description: 'Shared details',
      conversationId: shared,
    });
    await f.call(f.owner, 'POST', '/v1/tasks', {
      title: 'Internal task',
      description: 'Confidential',
    });
    const address = randomUUID() + '@guest.test';
    const invitation = await f.call(f.owner, 'POST', '/v1/invitations', {
      email: address,
      accessType: 'guest',
      conversationIds: [shared],
    });
    expect(invitation.statusCode).toBe(201);
    const accepted = await f.call('', 'POST', '/v1/invitations/accept', {
      token: invitation.json().token,
      name: 'Guest',
      password: 'a-guest-test-password',
    });
    expect(accepted.statusCode).toBe(201);
    await verifyFixtureAccount(f.db, address);
    const guest = accepted.cookies[0]!.value,
      boot = await f.boot(guest);
    expect(boot.channels.map((c) => c.id)).toEqual([shared]);
    expect((await f.call(guest, 'GET', `/v1/conversations/${hidden}/messages`)).statusCode).toBe(
      404,
    );
    expect((await f.send(guest, shared, 'Guest can collaborate')).statusCode).toBe(201);
    expect(
      (await f.call(guest, 'POST', '/v1/tasks', { title: 'Unscoped task', description: '' }))
        .statusCode,
    ).toBe(403);
    const rows = await tenantScope(boot.workspace.id, () => {
      identifyPrincipal(boot.me.id, 'guest');
      return scopedDatabase(f.db).query('SELECT title FROM tasks');
    });
    expect(rows.map((r) => r.title)).toEqual(['Shared guest task']);
    const other = await tenantScope(f.otherBoot.workspace.id, () => {
      identifyPrincipal(boot.me.id, 'guest');
      return scopedDatabase(f.db).query('SELECT body FROM messages');
    });
    expect(other).toEqual([]);
    expect((await f.call(guest, 'GET', '/v1/events')).statusCode).toBe(200);
  });
  it('enforces granular capabilities and immediately revokes changed access', async () => {
    f = await messagingFixture();
    const member = (await f.call(f.owner, 'GET', '/v1/members'))
      .json()
      .find((m: { id: string }) => m.id === f.mateBoot.me.id);
    const changed = await f.call(f.owner, 'PUT', `/v1/members/${member.id}/access`, {
      accessType: 'member',
      permissions: { 'tasks.read': false, 'messages.write': false },
      conversationIds: [],
      version: member.version,
    });
    expect(changed.statusCode).toBe(200);
    expect((await f.call(f.mate, 'GET', '/v1/bootstrap')).statusCode).toBe(401);
    const address = (
      await f.db.query(
        'SELECT a.email FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.id=$1',
        [member.id],
      )
    )[0]!.email;
    const login = await f.call('', 'POST', '/v1/auth/signin', {
        email: address,
        password: 'messaging-test-password',
      }),
      session = login.cookies[0]!.value;
    expect((await f.call(session, 'GET', '/v1/tasks')).statusCode).toBe(403);
    expect((await f.send(session, f.ownerBoot.channels[0]!.id, 'Forbidden')).statusCode).toBe(403);
    expect((await f.call(session, 'GET', '/v1/knowledge')).statusCode).toBe(200);
  });
  it('issues expiring scoped service credentials and enforces both capability and conversation boundaries', async () => {
    f = await messagingFixture();
    const shared = f.ownerBoot.channels[0]!.id,
      hidden = f.ownerBoot.channels[1]!.id;
    await f.send(f.owner, shared, 'Allowed message');
    const created = await f.call(f.owner, 'POST', '/v1/service-accounts', {
      name: 'Reporting service',
      permissions: ['messages.read'],
      conversationIds: [shared],
      expiresInDays: 30,
    });
    expect(created.statusCode).toBe(201);
    const credential = created.json();
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      f.app.inject({
        method,
        url,
        headers: { authorization: 'Bearer ' + credential.token },
        ...(payload ? { payload } : {}),
      });
    expect((await call('GET', `/v1/conversations/${shared}/messages`)).statusCode).toBe(200);
    expect((await call('GET', `/v1/conversations/${hidden}/messages`)).statusCode).toBe(404);
    expect(
      (
        await call('POST', `/v1/conversations/${shared}/messages`, {
          body: 'Forbidden',
          clientId: randomUUID(),
        })
      ).statusCode,
    ).toBe(403);
    expect((await call('GET', '/v1/account')).statusCode).toBe(401);
    expect((await f.call(f.owner, 'GET', '/v1/service-accounts')).body).not.toContain(
      credential.token,
    );
    await f.call(f.owner, 'DELETE', '/v1/service-accounts/' + credential.id);
    expect((await call('GET', `/v1/conversations/${shared}/messages`)).statusCode).toBe(401);
  });
  it('transfers ownership and fully offboards without deleting attribution or changing private audiences', async () => {
    f = await messagingFixture();
    const task = await f.call(f.mate, 'POST', '/v1/tasks', {
      title: 'Handoff task',
      description: 'Keep the history',
      assigneeId: f.mateBoot.me.id,
    });
    expect(task.statusCode).toBe(201);
    const project = await f.call(f.mate, 'POST', '/v1/projects', {
      name: 'Handoff project',
      description: '',
      ownerId: f.mateBoot.me.id,
      clientId: randomUUID(),
    });
    expect(project.statusCode).toBe(201);
    await f.send(f.mate, f.ownerBoot.channels[0]!.id, 'Attribution remains');
    const member = (await f.call(f.owner, 'GET', '/v1/members'))
      .json()
      .find((m: { id: string }) => m.id === f.mateBoot.me.id);
    const offboard = await f.call(f.owner, 'POST', `/v1/members/${member.id}/offboard`, {
      successorId: f.ownerBoot.me.id,
      version: member.version,
    });
    expect(offboard.statusCode).toBe(200);
    expect((await f.call(f.mate, 'GET', '/v1/bootstrap')).statusCode).toBe(401);
    expect(
      (
        await f.db.query('SELECT assignee_id,created_by FROM tasks WHERE id=$1', [task.json().id])
      )[0],
    ).toMatchObject({ assignee_id: f.ownerBoot.me.id, created_by: f.mateBoot.me.id });
    expect(
      (await f.db.query('SELECT owner_id FROM projects WHERE id=$1', [project.json().id]))[0]!
        .owner_id,
    ).toBe(f.ownerBoot.me.id);
    expect(
      (await f.messages(f.owner, f.ownerBoot.channels[0]!.id)).some(
        (m) => m.author_id === f.mateBoot.me.id,
      ),
    ).toBe(true);
  });
  it('retains an organization owner and revokes organization access across all workspaces atomically', async () => {
    f = await messagingFixture();
    const organization = await org(),
      owner = await profile(),
      mate = await profile(f.mate);
    const second = await f.call(
      f.owner,
      'POST',
      `/v1/organizations/${organization.id}/workspaces`,
      { name: 'Second workspace', region: 'global' },
    );
    await f.call(f.owner, 'POST', `/v1/organizations/${organization.id}/members`, {
      accountId: mate.id,
      workspaceIds: [second.json().id],
    });
    const members = (
      await f.call(f.owner, 'GET', `/v1/organizations/${organization.id}/members`)
    ).json();
    const target = members.find((m: { account_id: string }) => m.account_id === mate.id),
      self = members.find((m: { account_id: string }) => m.account_id === owner.id);
    expect(
      (
        await f.call(
          f.owner,
          'POST',
          `/v1/organizations/${organization.id}/members/${owner.id}/offboard`,
          { version: self.version },
        )
      ).statusCode,
    ).toBe(409);
    const response = await f.call(
      f.owner,
      'POST',
      `/v1/organizations/${organization.id}/members/${mate.id}/offboard`,
      { version: target.version },
    );
    expect(response.statusCode).toBe(200);
    expect((await f.call(f.mate, 'GET', '/v1/bootstrap')).statusCode).toBe(401);
    const statuses = await f.db.query('SELECT status FROM memberships WHERE account_id=$1', [
      mate.id,
    ]);
    expect(statuses).toHaveLength(2);
    expect(statuses.every((s) => s.status === 'suspended')).toBe(true);
    const audit = await identityScope(() =>
      scopedDatabase(f.db).query('SELECT action FROM organization_audit WHERE organization_id=$1', [
        organization.id,
      ]),
    );
    expect(audit.some((e) => e.action === 'member.offboarded')).toBe(true);
  });
});
