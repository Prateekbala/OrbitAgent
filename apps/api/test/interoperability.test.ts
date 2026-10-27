import { SharedRetentionWorker } from '../src/interoperability/retention.js';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { canonicalJson } from '../src/lib/canonical-json.js';
import { scopedDatabase, tenantScope, identifyPrincipal } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { normalizePage } from '../src/interoperability/adapters.js';
import { tar, textEntry } from '../src/interoperability/archive.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
});
afterAll(async () => f.close());
async function ok(
  session: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  status = 200,
) {
  const r = await f.call(session, method, url, payload);
  expect(r.statusCode, r.body).toBe(status);
  return r.json();
}
describe('migration platform', () => {
  it('preflights, resumes, attributes, threads, deduplicates and reports omissions', async () => {
    const channel = await f.channel('private');
    const source = await ok(
      f.owner,
      'POST',
      '/v1/migrations',
      {
        clientId: randomUUID(),
        name: 'Slack archive',
        provider: 'slack',
        sourceWorkspaceId: randomUUID(),
        conflictOwner: 'manual',
      },
      201,
    );
    const base = '/v1/migrations/' + source.id;
    await ok(f.owner, 'PUT', base + '/mappings', {
      version: 1,
      channels: [
        {
          sourceId: 'C1',
          conversationId: channel,
          visibility: 'private',
          authorized: true,
          acknowledgeAudienceExpansion: true,
        },
      ],
      identities: [],
    });
    const records = normalizePage('slack', 'C1', [
      {
        ts: '1710000001.000001',
        user: 'U1',
        text: 'Original author root',
        reactions: [{ name: 'eyes', count: 2, users: ['U2'] }],
        files: [{ id: 'F1', name: 'missing.txt' }],
      },
      {
        ts: '1710000002.000001',
        thread_ts: '1710000001.000001',
        user: 'U2',
        text: 'Original reply',
      },
    ]);
    const batch = { clientId: randomUUID(), cursor: 'page-1', complete: true, records };
    await ok(f.owner, 'POST', base + '/batches', batch);
    expect((await ok(f.owner, 'POST', base + '/batches', batch)).replayed).toBe(true);
    expect((await ok(f.owner, 'GET', base)).counts).toEqual([{ state: 'pending', count: 2 }]);
    expect(await f.messages(f.owner, channel)).toHaveLength(0);
    await ok(f.owner, 'POST', base + '/control', { version: 2, action: 'start' });
    await ok(f.owner, 'POST', base + '/process', {});
    await ok(f.owner, 'POST', base + '/process', {});
    const report = await ok(f.owner, 'GET', base);
    expect(report.complete).toBe(true);
    expect(report.hasOmissions).toBe(true);
    expect(report.source.cursor).toBe('page-1');
    const messages = await f.messages(f.owner, channel);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.author_name).toBe('U1');
    expect(messages[0]!.source_attribution?.reactions[0]?.count).toBe(2);
    expect(messages[0]!.reply_count).toBe(1);
    expect((await f.call(f.other, 'GET', base)).statusCode).toBe(404);
    const root = messages[0]!;
    const edit = await f.call(f.owner, 'PATCH', '/v1/messages/' + root.id, {
      body: 'Local correction',
      version: 1,
    });
    expect(edit.statusCode, edit.body).toBe(200);
    await ok(f.owner, 'POST', base + '/batches', {
      clientId: randomUUID(),
      complete: true,
      records: [{ ...records[0], body: 'Source correction', revision: '1710000003.000001' }],
    });
    await ok(f.owner, 'POST', base + '/process', {});
    const conflict = (await ok(f.owner, 'GET', base)).issues.find(
      (r: { state: string }) => r.state === 'conflict',
    );
    expect(conflict.reason).toBe('LOCAL_EDIT_CONFLICT');
    await ok(f.owner, 'POST', base + '/records/' + conflict.id + '/resolve', {
      version: conflict.version,
      action: 'local',
    });
    expect((await f.messages(f.owner, channel))[0]!.body).toBe('Local correction');
    const archive = await f.call(f.owner, 'GET', '/v1/workspace-export');
    expect(archive.statusCode, archive.body.slice(0, 300)).toBe(200);
    expect(archive.headers['content-type']).toBe('application/x-tar');
    expect(archive.rawPayload.includes(Buffer.from('manifest.json'))).toBe(true);
    expect(archive.rawPayload.includes(Buffer.from('Local correction'))).toBe(true);
  });
});
describe('organization shared channels', () => {
  it('requires consent and explicit participants, attributes external identities and fences revocation', async () => {
    const channel = await f.channel('private');
    await f.send(f.owner, channel, 'Before external admission');
    const [organization] = await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
      f.otherBoot.workspace.id,
    ]);
    const policy = {
      history: 'join_time',
      retentionDays: 3650,
      export: false,
      recording: false,
      agents: false,
    };
    const invite = await ok(
      f.owner,
      'POST',
      '/v1/shared-channels/invitations',
      { conversationId: channel, organizationId: organization!.organization_id, policy },
      201,
    );
    expect(
      (
        await f.call(f.mate, 'POST', '/v1/shared-channels/accept', {
          token: invite.token,
          policy,
          membershipIds: [f.mateBoot.me.id],
        })
      ).statusCode,
    ).toBe(404);
    await ok(f.other, 'POST', '/v1/shared-channels/accept', {
      token: invite.token,
      policy,
      membershipIds: [f.otherBoot.me.id],
    });
    const base = '/v1/shared-channels/' + invite.id;
    expect(await ok(f.other, 'GET', base + '/messages')).toHaveLength(0);
    await f.send(f.owner, channel, 'After admission');
    expect(await ok(f.other, 'GET', base + '/messages')).toHaveLength(1);
    await ok(
      f.other,
      'POST',
      base + '/messages',
      { clientId: randomUUID(), body: 'Hello from external organization' },
      201,
    );
    const message = (await f.messages(f.owner, channel))[0]!;
    expect(message.external_organization?.organizationId).toBe(organization!.organization_id);
    expect((await f.call(f.other, 'GET', `/v1/conversations/${channel}/messages`)).statusCode).toBe(
      404,
    );
    expect((await f.call(f.other, 'GET', base + '/export')).statusCode).toBe(403);
    const hostOrg = await f.db.query(
      'SELECT om.account_id FROM organization_members om JOIN workspaces w ON w.organization_id=om.organization_id WHERE w.id=$1 AND om.account_id=(SELECT account_id FROM memberships WHERE id=$2)',
      [f.ownerBoot.workspace.id, f.otherBoot.me.id],
    );
    expect(hostOrg).toHaveLength(0);
    await ok(f.owner, 'POST', base + '/revoke', { version: 2 });
    expect((await f.call(f.other, 'GET', base + '/messages')).statusCode).toBe(404);
    expect(
      (
        await f.call(f.other, 'POST', base + '/messages', {
          clientId: randomUUID(),
          body: 'Should not publish',
        })
      ).statusCode,
    ).toBe(404);
  });
});
describe('provider contracts and archive integrity', () => {
  it('normalizes Teams inert text and attributed reactions independently', () => {
    const records = normalizePage('teams', 'T1', [
      {
        id: '1',
        createdDateTime: '2026-01-01T00:00:00Z',
        lastModifiedDateTime: '2026-01-01T01:00:00Z',
        from: { user: { id: 'A', displayName: 'Ava' } },
        body: { contentType: 'html', content: '<b>Decision</b><br>Approved' },
        reactions: [{ reactionType: 'like', user: { user: { id: 'B' } } }],
      },
    ]);
    expect(records[0]!.body).toBe('Decision\nApproved');
    expect(records[0]!.reactions[0]!.authorIds).toEqual(['B']);
    expect(records[0]!.unsupported).not.toHaveLength(0);
  });
  it('does not mistake Discord replies for threads or fabricate reaction authors', () => {
    const records = normalizePage('discord', 'D1', [
      {
        id: '1',
        author: { id: 'A', username: 'Ava' },
        content: 'Hello',
        timestamp: '2026-01-01T00:00:00Z',
        message_reference: { message_id: 'other' },
        reactions: [{ emoji: { name: '👍' }, count: 3 }],
      },
    ]);
    expect(records[0]!.threadId).toBeUndefined();
    expect(records[0]!.reactions[0]!.authorIds).toEqual([]);
    expect(records[0]!.unsupported[0]).toContain('not a thread');
  });
  it('writes bounded tar entries and rejects unsafe paths', async () => {
    async function* entries() {
      yield textEntry('README.md', 'Hello');
    }
    const chunks = [];
    for await (const c of tar(entries())) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    expect(bytes.length % 512).toBe(0);
    expect(bytes.subarray(512, 517).toString()).toBe('Hello');
    async function* unsafe() {
      yield textEntry('../secret', 'bad');
    }
    await expect(async () => {
      for await (const _ of tar(unsafe())) {
      }
    }).rejects.toThrow('Invalid archive entry');
  });
});

describe('synchronization and current authority', () => {
  it('queues ordinary member changes, signs idempotent batches, fences leases and suppresses echoes', async () => {
    const channel = await f.channel('private');
    await ok(f.owner, 'POST', '/v1/conversations/' + channel + '/members', {
      membershipId: f.mateBoot.me.id,
    });
    const created = await ok(
      f.owner,
      'POST',
      '/v1/migrations',
      {
        clientId: randomUUID(),
        name: 'Slack live relay',
        provider: 'slack',
        sourceWorkspaceId: randomUUID(),
        mode: 'bidirectional',
      },
      201,
    );
    const base = '/v1/migrations/' + created.id;
    await ok(f.owner, 'PUT', base + '/mappings', {
      version: 1,
      channels: [
        {
          sourceId: 'SYNC',
          conversationId: channel,
          visibility: 'public',
          authorized: true,
          acknowledgeAudienceExpansion: true,
        },
      ],
    });
    const rotated = await ok(f.owner, 'POST', base + '/relay-secret', {});
    await ok(f.owner, 'POST', base + '/control', { version: 3, action: 'start' });
    async function signed(path: string, body: unknown, secret = rotated.secret) {
      const timestamp = Date.now().toString(),
        url = '/v1/migration-relay/' + created.id + '/' + path,
        signature = createHmac('sha256', secret)
          .update(timestamp + '\nPOST\n' + url + '\n' + canonicalJson(body))
          .digest('hex');
      return f.app.inject({
        method: 'POST',
        url,
        headers: {
          'x-orbit-workspace': f.ownerBoot.workspace.id,
          'x-orbit-timestamp': timestamp,
          'x-orbit-signature': 'v1=' + signature,
        },
        payload: body as object,
      });
    }
    const sent = await f.send(f.mate, channel, 'Member-authored sync');
    expect(sent.statusCode, sent.body).toBe(201);
    const claimId = randomUUID(),
      claimed = await signed('claim', { clientId: claimId });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const delivery = claimed.json().delivery;
    expect(delivery.message.body).toBe('Member-authored sync');
    expect((await signed('claim', { clientId: claimId })).json()).toEqual({
      delivery: null,
      replayed: true,
    });
    expect((await signed('claim', { clientId: randomUUID() }, 'invalid-secret')).statusCode).toBe(
      401,
    );
    const echo = {
      clientId: randomUUID(),
      complete: true,
      records: [
        {
          id: 'echo-1',
          channelId: 'SYNC',
          authorId: 'remote',
          authorName: 'Remote',
          timestamp: '2026-10-25T00:00:00Z',
          revision: '2026-10-25T00:00:00Z',
          body: 'Member-authored sync',
          echoActionId: delivery.id,
        },
      ],
    };
    expect((await signed('batches', echo)).statusCode).toBe(200);
    expect((await signed('batches', echo)).json().replayed).toBe(true);
    await ok(f.owner, 'POST', base + '/process', {});
    expect(await f.messages(f.owner, channel)).toHaveLength(1);
    const [organization] = await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
      f.otherBoot.workspace.id,
    ]);
    const policy = {
      history: 'join_time',
      retentionDays: 3650,
      export: false,
      recording: false,
      agents: false,
    };
    const invitation = await ok(
      f.owner,
      'POST',
      '/v1/shared-channels/invitations',
      { conversationId: channel, organizationId: organization!.organization_id, policy },
      201,
    );
    await ok(f.other, 'POST', '/v1/shared-channels/accept', {
      token: invitation.token,
      policy,
      membershipIds: [f.otherBoot.me.id],
    });
    const external = await ok(
      f.other,
      'POST',
      '/v1/shared-channels/' + invitation.id + '/messages',
      { clientId: randomUUID(), body: 'External organization data must not be forwarded' },
      201,
    );
    await f.send(f.owner, channel, 'Host content governed by no-export agreement');
    const [queued] = await f.db.query(
      'SELECT count(*)::int count FROM migration_deliveries WHERE source_id=$1',
      [created.id],
    );
    expect(queued!.count).toBe(1);
    const stale = randomUUID();
    await f.db.query(
      'INSERT INTO migration_deliveries(id,workspace_id,source_id,conversation_id,message_id,message_version) VALUES($1,$2,$3,$4,$5,1)',
      [stale, f.ownerBoot.workspace.id, created.id, channel, external.id],
    );
    expect((await signed('claim', { clientId: randomUUID() })).json().delivery).toBeNull();
    const [cancelled] = await f.db.query('SELECT state FROM migration_deliveries WHERE id=$1', [
      stale,
    ]);
    expect(cancelled!.state).toBe('cancelled');
    await f.db.query(
      "UPDATE migration_deliveries SET lease_until=now()-interval '1 second' WHERE id=$1",
      [delivery.id],
    );
    await signed('claim', { clientId: randomUUID() });
    const completion = await signed('complete', {
      deliveryId: delivery.id,
      leaseToken: delivery.leaseToken,
      externalId: 'slack-ts',
      outcome: 'completed',
    });
    expect(completion.statusCode).toBe(409);
    const [state] = await f.db.query('SELECT state FROM migration_deliveries WHERE id=$1', [
      delivery.id,
    ]);
    expect(state!.state).toBe('uncertain');
    await ok(f.owner, 'POST', base + '/control', { version: 4, action: 'pause' });
    await f.db.query('UPDATE migration_sources SET owner_auth_version=0 WHERE id=$1', [created.id]);
    await ok(f.owner, 'POST', base + '/control', { version: 5, action: 'start' });
    expect((await signed('claim', { clientId: randomUUID() })).statusCode).toBe(401);
    const renewed = await ok(f.owner, 'POST', base + '/relay-secret', {});
    expect((await signed('claim', { clientId: randomUUID() }, renewed.secret)).statusCode).toBe(
      200,
    );
    await ok(f.owner, 'POST', base + '/control', { version: 7, action: 'disconnect' });
    expect((await signed('claim', { clientId: randomUUID() })).statusCode).toBe(401);
  });
  it('rejects mismatched agreements and invalidates external reads directly in PostgreSQL after source offboarding', async () => {
    const channel = await f.channel('private'),
      [org] = await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
        f.otherBoot.workspace.id,
      ]);
    const policy = {
      history: 'retained',
      retentionDays: 30,
      export: true,
      recording: false,
      agents: false,
    };
    const invite = await ok(
      f.owner,
      'POST',
      '/v1/shared-channels/invitations',
      { conversationId: channel, organizationId: org!.organization_id, policy },
      201,
    );
    const mismatch = await f.call(f.other, 'POST', '/v1/shared-channels/accept', {
      token: invite.token,
      policy: { ...policy, agents: true },
      membershipIds: [f.otherBoot.me.id],
    });
    expect(mismatch.statusCode).toBe(409);
    await ok(f.other, 'POST', '/v1/shared-channels/accept', {
      token: invite.token,
      policy,
      membershipIds: [f.otherBoot.me.id],
    });
    await f.send(f.owner, channel, 'Current private source');
    const [participant] = await f.db.query(
      'SELECT membership_id FROM shared_channel_participants WHERE grant_id=$1',
      [invite.id],
    );
    async function direct() {
      return tenantScope(f.ownerBoot.workspace.id, async () => {
        identifyPrincipal(String(participant!.membership_id), 'guest');
        return scopedDatabase(f.db).query('SELECT id FROM messages WHERE conversation_id=$1', [
          channel,
        ]);
      });
    }
    expect(await direct()).toHaveLength(1);
    await f.db.query(
      "UPDATE organization_members SET status='suspended' WHERE organization_id=$1 AND account_id=(SELECT account_id FROM memberships WHERE id=$2)",
      [org!.organization_id, f.otherBoot.me.id],
    );
    expect(await direct()).toHaveLength(0);
    expect(
      (await f.call(f.other, 'GET', '/v1/shared-channels/' + invite.id + '/messages')).statusCode,
    ).toBe(401);
    await f.db.query(
      "UPDATE organization_members SET status='active' WHERE organization_id=$1 AND account_id=(SELECT account_id FROM memberships WHERE id=$2)",
      [org!.organization_id, f.otherBoot.me.id],
    );
  });
});

describe('durable sharing policy', () => {
  it('enforces retention and no-agent policies after revocation and sweeps expired bodies', async () => {
    const channel = await f.channel('private'),
      [org] = await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
        f.otherBoot.workspace.id,
      ]);
    const policy = {
      history: 'retained',
      retentionDays: 1,
      export: false,
      recording: false,
      agents: false,
    };
    const invite = await ok(
      f.owner,
      'POST',
      '/v1/shared-channels/invitations',
      { conversationId: channel, organizationId: org!.organization_id, policy },
      201,
    );
    await ok(f.other, 'POST', '/v1/shared-channels/accept', {
      token: invite.token,
      policy,
      membershipIds: [f.otherBoot.me.id],
    });
    const [counter] = await f.db.query(
      'UPDATE conversations SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence',
      [channel],
    );
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO messages(id,workspace_id,conversation_id,author_id,body,client_id,sequence,created_at) VALUES($1,$2,$3,$4,'Expired history',$5,$6,now()-interval '2 days')",
      [
        id,
        f.ownerBoot.workspace.id,
        channel,
        f.ownerBoot.me.id,
        randomUUID(),
        counter!.next_sequence,
      ],
    );
    expect(await f.messages(f.owner, channel)).toHaveLength(0);
    await ok(f.owner, 'POST', '/v1/shared-channels/' + invite.id + '/revoke', { version: 2 });
    expect(await f.messages(f.owner, channel)).toHaveLength(0);
    const errors: string[] = [];
    await new SharedRetentionWorker(f.db, (e) => errors.push(e)).tick();
    expect(errors).toEqual([]);
    const [row] = await f.db.query('SELECT body,deleted_at FROM messages WHERE id=$1', [id]);
    expect(row!.body).toBe('');
    expect(row!.deleted_at).not.toBeNull();
    const [allowed] = await tenantScope(f.ownerBoot.workspace.id, () =>
      scopedDatabase(f.db).query('SELECT shared_agent_allowed($1,$2) allowed', [
        f.ownerBoot.workspace.id,
        channel,
      ]),
    );
    expect(allowed!.allowed).toBe(false);
  });
});
