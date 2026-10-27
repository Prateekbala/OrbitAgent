import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scopedDatabase, tenantScope } from '@ao/database';
import { realtimeBatch, type RealtimeBatch } from '@ao/contracts';
import { buildApp } from '../src/app.js';
import { EventFeed } from '../src/messaging/events.js';
import { digest } from '../src/lib/security.js';
import { messagingFixture } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>, origin: string;
const clients = new Set<{ close: () => Promise<void> }>();
beforeAll(async () => {
  f = await messagingFixture();
  origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
}, 30000);
afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
});
afterAll(async () => f?.close());
async function tail(session: string) {
  let cursor = '0';
  for (let i = 0; i < 20; i++) {
    const response = await f.call(session, 'GET', '/v1/events?after=' + cursor);
    expect(response.statusCode).toBe(200);
    const page = realtimeBatch.parse(response.json());
    cursor = page.cursor;
    if (!page.hasMore) return cursor;
  }
  throw new Error('Event tail exceeded its bound');
}
async function connect(session: string, after: string, host = origin, lastEventId?: string) {
  const controller = new AbortController();
  const response = await fetch(host + '/v1/events/stream?after=' + after, {
    headers: {
      cookie: `ao_session=${session}`,
      ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  const client = {
    async next(type: string) {
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        while (true) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = frame.match(/^event: (.+)$/m)?.[1];
            if (event === type)
              return {
                id: frame.match(/^id: (.+)$/m)?.[1],
                data: JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? '{}') as unknown,
              };
            continue;
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Event stream ended before expected frame');
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 262144) throw new Error('Event frame exceeded bound');
        }
      } finally {
        clearTimeout(timer);
      }
    },
    async change(resource: string): Promise<RealtimeBatch> {
      for (let i = 0; i < 30; i++) {
        const page = realtimeBatch.parse((await this.next('changes')).data);
        if (page.events.some((event) => event.resource_id === resource)) return page;
      }
      throw new Error('Change was not delivered');
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      clients.delete(client);
    },
  };
  clients.add(client);
  await client.next('ready');
  return client;
}
describe('durable live event stream', () => {
  it('streams changes across API instances and resumes using Last-Event-ID', async () => {
    const second = await buildApp(f.db),
      secondOrigin = await second.listen({ host: '127.0.0.1', port: 0 });
    try {
      const channel = await f.channel(),
        cursor = await tail(f.owner),
        client = await connect(f.owner, cursor, secondOrigin);
      const first = (await f.send(f.owner, channel, 'First streamed message')).json().id;
      const delivered = await client.change(first);
      await client.close();
      const next = (await f.send(f.owner, channel, 'While disconnected')).json().id;
      const resumed = await connect(f.owner, '0', secondOrigin, delivered.cursor);
      const replay = await resumed.change(next);
      expect(replay.events.some((event) => event.resource_id === first)).toBe(false);
      expect(replay.cursor).not.toBe(delivered.cursor);
      expect(JSON.stringify(replay)).not.toContain('While disconnected');
      await resumed.close();
    } finally {
      await second.close();
    }
  });
  it('advances through private events without exposing their identifiers or content', async () => {
    const channel = await f.channel('private'),
      publicChannel = await f.channel(),
      cursor = await tail(f.mate),
      client = await connect(f.mate, cursor);
    const message = (await f.send(f.owner, channel, 'Private secret')).json().id;
    const visible = (await f.send(f.owner, publicChannel, 'Visible after private change')).json()
      .id;
    const page = await client.change(visible);
    expect(
      page.events.some(
        (event) => event.conversation_id === channel || event.resource_id === message,
      ),
    ).toBe(false);
    expect(page.cursor).toMatch(/^v1\./);
    await client.close();
    const replay = await f.call(f.other, 'GET', '/v1/events');
    expect(JSON.stringify(replay.json())).not.toContain(message);
  });
  it('rejects invalid cursors and unauthenticated or cross-origin stream requests', async () => {
    expect((await f.app.inject('/v1/events/stream')).statusCode).toBe(401);
    for (const after of ['-1', '1e9', '9223372036854775808'])
      expect((await f.call(f.owner, 'GET', '/v1/events?after=' + after)).statusCode).toBe(400);
    expect((await f.call(f.owner, 'GET', '/v1/events?after=9223372036854775807')).statusCode).toBe(
      400,
    );
    expect(
      (
        await f.app.inject({
          url: '/v1/events/stream',
          headers: { cookie: `ao_session=${f.owner}`, origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('bounds concurrent subscriptions and releases slots on disconnect', async () => {
    const cursor = await tail(f.owner),
      subscribers = [];
    for (let i = 0; i < 4; i++) subscribers.push(await connect(f.owner, cursor));
    const rejected = await fetch(origin + '/v1/events/stream', {
      headers: { cookie: `ao_session=${f.owner}` },
    });
    expect(rejected.status).toBe(429);
    await rejected.body?.cancel();
    await subscribers[0]!.close();
    await expect
      .poll(async () => {
        const response = await fetch(origin + '/v1/events/stream', {
          headers: { cookie: `ao_session=${f.owner}` },
        });
        const status = response.status;
        await response.body?.cancel();
        return status;
      })
      .toBe(200);
  });
  it('closes a connected stream when its session is revoked', async () => {
    const client = await connect(f.mate, await tail(f.mate));
    await f.db.query('DELETE FROM sessions WHERE token_hash=$1', [digest(f.mate)]);
    await client.next('auth-required');
    expect((await f.call(f.mate, 'GET', '/v1/bootstrap')).statusCode).toBe(401);
  });
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'publishes a late-committing low outbox ID after a higher committed ID',
    async () => {
      await tail(f.owner);
      const cursor = String(
          (
            await f.db.query(
              'SELECT next_sequence::text FROM realtime_heads WHERE workspace_id=$1',
              [f.ownerBoot.workspace.id],
            )
          )[0]!.next_sequence,
        ),
        low = randomUUID(),
        high = randomUUID();
      let release!: () => void, ready!: () => void;
      const waiting = new Promise<void>((resolve) => {
          release = resolve;
        }),
        inserted = new Promise<void>((resolve) => {
          ready = resolve;
        });
      const transaction = f.db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO outbox_events(workspace_id,event_type,resource_id) VALUES($1,'test.late',$2)",
          [f.ownerBoot.workspace.id, low],
        );
        ready();
        await waiting;
      });
      try {
        await inserted;
        await f.db.query(
          "INSERT INTO outbox_events(workspace_id,event_type,resource_id) VALUES($1,'test.early',$2)",
          [f.ownerBoot.workspace.id, high],
        );
        const p = {
          workspaceId: f.ownerBoot.workspace.id,
          membershipId: f.ownerBoot.me.id,
          name: f.ownerBoot.me.name,
          kind: f.ownerBoot.me.kind,
          role: f.ownerBoot.me.role,
        };
        const page = () => new EventFeed(scopedDatabase(f.db));
        const first = await tenantScope(p.workspaceId, () => page().page(p, cursor));
        expect(first.events.some((event) => event.resource_id === high)).toBe(true);
        expect(first.events.some((event) => event.resource_id === low)).toBe(false);
        release();
        await transaction;
        const second = await tenantScope(p.workspaceId, () => page().page(p, first.cursor));
        expect(second.events.some((event) => event.resource_id === low)).toBe(true);
        expect(BigInt(second.cursor)).toBeGreaterThan(BigInt(first.cursor));
      } finally {
        release();
        await transaction;
      }
    },
  );
});
