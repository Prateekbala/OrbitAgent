import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scopedDatabase, tenantScope } from '@ao/database';
import type { MessageHistory, SearchPage, Page, KnowledgeHistory } from '@ao/contracts';
import { messagingFixture } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
beforeAll(async () => {
  f = await messagingFixture();
});
afterAll(async () => {
  await f?.close();
});
async function search(session: string, query: Record<string, string>) {
  return f.call(session, 'GET', '/v1/search/advanced?' + new URLSearchParams(query));
}
async function createPage(conversation?: string) {
  const result = await f.call(f.owner, 'POST', '/v1/knowledge', {
    title: 'Deployment guide',
    body: 'Original deployment guide',
    ...(conversation ? { conversationId: conversation } : {}),
  });
  expect(result.statusCode, result.body).toBe(201);
  return result.json<{ id: string }>().id;
}
async function seed(channel: string, count: number, thread: string | null = null) {
  await f.db.transaction(async (tx) => {
    const [row] = await tx.query(
      'UPDATE conversations SET next_sequence=next_sequence+$3 WHERE workspace_id=$1 AND id=$2 RETURNING next_sequence',
      [f.ownerBoot.workspace.id, channel, count],
    );
    const high = Number(row!.next_sequence);
    await tx.query(
      `INSERT INTO messages(id,workspace_id,conversation_id,author_id,body,client_id,thread_id,sequence) SELECT gen_random_uuid(),$1,$2,$3,'History item ' || n,gen_random_uuid(),$4,n FROM generate_series($5::integer,$6::integer) n`,
      [f.ownerBoot.workspace.id, channel, f.ownerBoot.me.id, thread, high - count + 1, high],
    );
  });
}
describe('advanced search', () => {
  it('supports phrases, exclusions, author/conversation/date/thread filters and private audiences', async () => {
    const channel = await f.channel(),
      secret = await f.channel('private');
    const root = (await f.send(f.owner, channel, 'launch checklist approved')).json<{
      id: string;
    }>().id;
    const reply = (await f.send(f.mate, channel, 'launch checklist blocked', root)).json<{
      id: string;
    }>().id;
    await f.send(f.owner, secret, 'launch checklist hidden');
    await f.send(f.other, f.otherBoot.channels[0]!.id, 'launch checklist cross tenant');
    const response = await search(f.mate, {
      q: '"launch checklist" -blocked',
      conversationId: channel,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SearchPage>().items.map((r) => r.id)).toEqual([root]);
    const replies = await search(f.mate, {
      q: 'launch OR missing',
      conversationId: channel,
      threads: 'replies',
      authorId: f.mateBoot.me.id,
    });
    expect(replies.json<SearchPage>().items.map((r) => r.id)).toEqual([reply]);
    const visible = await search(f.mate, { q: 'launch' });
    expect(visible.json<SearchPage>().items).toHaveLength(2);
    expect(
      (await search(f.other, { q: 'launch', conversationId: channel })).json<SearchPage>().items,
    ).toEqual([]);
    expect(
      (
        await search(f.owner, { q: 'launch', conversationId: channel, attachments: 'true' })
      ).json<SearchPage>().items,
    ).toEqual([]);
    expect(
      (
        await search(f.owner, {
          q: 'launch',
          conversationId: channel,
          from: '2099-01-01T00:00:00Z',
        })
      ).json<SearchPage>().items,
    ).toEqual([]);
    expect(
      (await search(f.owner, { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }))
        .statusCode,
    ).toBe(400);
  });
  it('uses deterministic keysets for tied ranks/timestamps and binds opaque cursors to filters and viewers', async () => {
    const channel = await f.channel();
    await seed(channel, 9);
    const all = new Set<string>();
    let cursor: string | null = null;
    for (let n = 0; n < 5; n++) {
      const result = await search(f.owner, {
        q: 'history',
        conversationId: channel,
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      expect(result.statusCode, result.body).toBe(200);
      const page = result.json<SearchPage>();
      for (const item of page.items) {
        expect(all.has(item.id)).toBe(false);
        all.add(item.id);
      }
      cursor = page.next_cursor;
      if (n === 0) {
        expect(cursor).toBeTruthy();
        expect(
          (
            await search(f.mate, {
              q: 'history',
              conversationId: channel,
              limit: '2',
              cursor: cursor!,
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await search(f.owner, {
              q: 'different',
              conversationId: channel,
              limit: '2',
              cursor: cursor!,
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await search(f.owner, {
              q: 'history',
              conversationId: channel,
              limit: '2',
              cursor: cursor!.slice(0, -3) + 'bad',
            })
          ).statusCode,
        ).toBe(400);
      }
    }
    expect(all.size).toBe(9);
    expect(cursor).toBeNull();
    for (const sort of ['newest', 'oldest']) {
      const a = (
        await search(f.owner, { q: 'history', conversationId: channel, sort, limit: '5' })
      ).json<SearchPage>();
      const b = (
        await search(f.owner, {
          q: 'history',
          conversationId: channel,
          sort,
          limit: '5',
          cursor: a.next_cursor!,
        })
      ).json<SearchPage>();
      expect(new Set([...a.items, ...b.items].map((r) => r.id)).size).toBe(9);
    }
  });
  it('indexes current knowledge and excludes inaccessible pages and superseded text', async () => {
    const privateChannel = await f.channel('private'),
      privatePage = await createPage(privateChannel),
      page = await createPage();
    expect(
      (await search(f.mate, { q: 'deployment', scope: 'knowledge' }))
        .json<SearchPage>()
        .items.map((r) => r.id),
    ).toContain(page);
    expect(
      (await search(f.mate, { q: 'deployment', scope: 'knowledge' }))
        .json<SearchPage>()
        .items.map((r) => r.id),
    ).not.toContain(privatePage);
    await f.call(f.owner, 'PATCH', `/v1/knowledge/${page}`, {
      version: 1,
      title: 'Fresh handbook',
      body: 'Unique revised handbook',
      clientId: randomUUID(),
    });
    expect(
      (await search(f.mate, { q: 'deployment', scope: 'knowledge' }))
        .json<SearchPage>()
        .items.map((r) => r.id),
    ).not.toContain(page);
    expect(
      (await search(f.mate, { q: 'handbook', scope: 'knowledge' }))
        .json<SearchPage>()
        .items.map((r) => r.id),
    ).toContain(page);
    expect((await search(f.mate, { scope: 'knowledge', threads: 'replies' })).statusCode).toBe(400);
  });
});
describe('message history', () => {
  it('pages both ways without gaps across new arrivals and tombstones, including thread timelines', async () => {
    const channel = await f.channel();
    await seed(channel, 235);
    const latestResponse = await f.call(
      f.owner,
      'GET',
      `/v1/conversations/${channel}/messages/history?limit=100`,
    );
    expect(latestResponse.statusCode, latestResponse.body).toBe(200);
    const latest = latestResponse.json<MessageHistory>();
    expect(latest.items.map((m) => m.sequence)).toEqual(
      Array.from({ length: 100 }, (_, i) => 136 + i),
    );
    expect(latest.older).toBe(136);
    expect(latest.newer).toBeNull();
    const older = (
      await f.call(
        f.owner,
        'GET',
        `/v1/conversations/${channel}/messages/history?before=${latest.older}&limit=100`,
      )
    ).json<MessageHistory>();
    const oldest = (
      await f.call(
        f.owner,
        'GET',
        `/v1/conversations/${channel}/messages/history?before=${older.older}&limit=100`,
      )
    ).json<MessageHistory>();
    expect(oldest.items).toHaveLength(35);
    expect(oldest.older).toBeNull();
    expect(new Set([...latest.items, ...older.items, ...oldest.items].map((m) => m.id)).size).toBe(
      235,
    );
    const target = older.items[20]!;
    await f.call(f.owner, 'DELETE', `/v1/messages/${target.id}`, { version: 1 });
    await f.send(f.mate, channel, 'New arrival');
    const anchor = (
      await f.call(
        f.owner,
        'GET',
        `/v1/conversations/${channel}/messages/history?around=${target.id}&limit=10`,
      )
    ).json<MessageHistory>();
    expect(anchor.items).toHaveLength(10);
    expect(anchor.items.find((m) => m.id === target.id)?.deleted_at).toBeTruthy();
    expect(anchor.older).not.toBeNull();
    expect(anchor.newer).not.toBeNull();
    const newer = (
      await f.call(f.owner, 'GET', `/v1/conversations/${channel}/messages/history?after=235`)
    ).json<MessageHistory>();
    expect(newer.items.map((m) => m.sequence)).toEqual([236]);
    const root = oldest.items[0]!.id;
    await seed(channel, 125, root);
    const replies = (
      await f.call(
        f.owner,
        'GET',
        `/v1/conversations/${channel}/messages/history?threadId=${root}&limit=100`,
      )
    ).json<MessageHistory>();
    expect(replies.items).toHaveLength(100);
    expect(replies.items.every((m) => m.thread_id === root)).toBe(true);
    const firstReplies = (
      await f.call(
        f.owner,
        'GET',
        `/v1/conversations/${channel}/messages/history?threadId=${root}&before=${replies.older}`,
      )
    ).json<MessageHistory>();
    expect(firstReplies.items).toHaveLength(25);
    expect(firstReplies.older).toBeNull();
  });
  it('rejects invalid positions and unauthorized conversation/thread references', async () => {
    const channel = await f.channel('private');
    const root = (await f.send(f.owner, channel, 'Private root')).json<{ id: string }>().id;
    expect(
      (await f.call(f.mate, 'GET', `/v1/conversations/${channel}/messages/history`)).statusCode,
    ).toBe(404);
    expect(
      (await f.call(f.other, 'GET', `/v1/conversations/${channel}/messages/history`)).statusCode,
    ).toBe(404);
    for (const q of [
      'before=-1',
      'limit=101',
      'after=1&before=2',
      'around=' + root + '&before=3',
      'threadId=' + randomUUID(),
    ])
      expect(
        (await f.call(f.owner, 'GET', `/v1/conversations/${channel}/messages/history?${q}`))
          .statusCode,
      ).toBe(q.startsWith('threadId') ? 404 : 400);
    const otherChannel = await f.channel();
    expect(
      (
        await f.call(
          f.owner,
          'GET',
          `/v1/conversations/${otherChannel}/messages/history?around=${root}`,
        )
      ).statusCode,
    ).toBe(404);
  });
});
describe('knowledge revisions', () => {
  it('attributes edits, rejects stale saves, replays retries and restores as a new immutable revision', async () => {
    const page = await createPage();
    const change = {
      version: 1,
      title: 'Revised guide',
      body: 'Updated deployment instructions',
      summary: 'Correct commands',
      clientId: randomUUID(),
    };
    const saved = await f.call(f.mate, 'PATCH', `/v1/knowledge/${page}`, change);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<{ page: Page }>().page.version).toBe(2);
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/knowledge/${page}`, {
          ...change,
          clientId: randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
    expect((await f.call(f.mate, 'PATCH', `/v1/knowledge/${page}`, change)).json().replayed).toBe(
      true,
    );
    expect(
      (await f.call(f.mate, 'PATCH', `/v1/knowledge/${page}`, { ...change, body: 'Changed retry' }))
        .statusCode,
    ).toBe(409);
    const versions = (
      await f.call(f.owner, 'GET', `/v1/knowledge/${page}/versions?limit=1`)
    ).json<KnowledgeHistory>();
    expect(versions.items[0]).toMatchObject({
      version: 2,
      author_name: 'Teammate',
      summary: 'Correct commands',
    });
    expect(versions.next_before).toBe(2);
    const older = (
      await f.call(f.owner, 'GET', `/v1/knowledge/${page}/versions?before=2`)
    ).json<KnowledgeHistory>();
    expect(older.items.map((v) => v.version)).toEqual([1]);
    expect(older.next_before).toBeNull();
    const restore = { version: 2, targetVersion: 1, clientId: randomUUID() };
    const result = await f.call(f.owner, 'POST', `/v1/knowledge/${page}/restore`, restore);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().page).toMatchObject({
      version: 3,
      title: 'Deployment guide',
      body: 'Original deployment guide',
    });
    expect(
      (await f.call(f.owner, 'POST', `/v1/knowledge/${page}/restore`, restore)).json().replayed,
    ).toBe(true);
    expect((await f.call(f.owner, 'GET', `/v1/knowledge/${page}/versions/3`)).json()).toMatchObject(
      { version: 3, restored_from: 1, author_name: 'Owner' },
    );
    expect((await f.call(f.owner, 'GET', `/v1/knowledge/${page}/versions/2`)).json()).toMatchObject(
      { body: change.body, title: change.title },
    );
    const scoped = scopedDatabase(f.db);
    await expect(
      tenantScope(f.ownerBoot.workspace.id, () =>
        scoped.query('UPDATE knowledge_versions SET body=$1 WHERE page_id=$2', ['tampered', page]),
      ),
    ).rejects.toThrow();
    await expect(
      tenantScope(f.ownerBoot.workspace.id, () =>
        scoped.query('DELETE FROM knowledge_versions WHERE page_id=$1', [page]),
      ),
    ).rejects.toThrow();
    expect(
      await tenantScope(f.otherBoot.workspace.id, () =>
        scoped.query('SELECT id FROM knowledge_versions WHERE page_id=$1', [page]),
      ),
    ).toEqual([]);
  });
  it('serializes competing saves so exactly one writer advances the version', async () => {
    const page = await createPage();
    const responses = await Promise.all(
      [f.owner, f.mate].map((session, i) =>
        f.call(session, 'PATCH', `/v1/knowledge/${page}`, {
          version: 1,
          title: 'Concurrent revision ' + i,
          body: 'Concurrent text ' + i,
          clientId: randomUUID(),
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(
      (await f.call(f.owner, 'GET', `/v1/knowledge/${page}/versions`)).json<KnowledgeHistory>()
        .items,
    ).toHaveLength(2);
  });
  it('protects every detail, snapshot, mutation and history route by current audience', async () => {
    const channel = await f.channel('private'),
      page = await createPage(channel);
    for (const session of [f.mate, f.other]) {
      for (const suffix of ['', '/versions', '/versions/1'])
        expect((await f.call(session, 'GET', `/v1/knowledge/${page}${suffix}`)).statusCode).toBe(
          404,
        );
      expect(
        (
          await f.call(session, 'PATCH', `/v1/knowledge/${page}`, {
            version: 1,
            title: 'Unauthorized edit',
            body: 'Hidden content',
            clientId: randomUUID(),
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await f.call(session, 'POST', `/v1/knowledge/${page}/restore`, {
            version: 1,
            targetVersion: 1,
            clientId: randomUUID(),
          })
        ).statusCode,
      ).toBe(404);
    }
    expect((await f.call(f.owner, 'GET', `/v1/knowledge/${page}/versions/99`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await f.call(f.owner, 'PATCH', `/v1/knowledge/${page}`, {
          version: 1,
          title: 'x',
          body: '',
          clientId: randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('content integrity after authority changes', () => {
  it('rechecks access after group removal even with a previously issued search cursor', async () => {
    const group = await f.call(f.owner, 'POST', '/v1/conversations/groups', {
      title: 'Private revision source',
      membershipIds: [f.mateBoot.me.id],
    });
    expect(group.statusCode, group.body).toBe(201);
    const channel = group.json<{ id: string }>().id;
    await f.send(f.owner, channel, 'Revocable context one');
    await f.send(f.owner, channel, 'Revocable context two');
    const page = await createPage(channel);
    const first = (
      await search(f.mate, { q: 'revocable', conversationId: channel, limit: '1' })
    ).json<SearchPage>();
    expect(first.next_cursor).toBeTruthy();
    expect((await f.call(f.mate, 'GET', `/v1/knowledge/${page}/versions`)).statusCode).toBe(200);
    const removed = await f.call(f.owner, 'PATCH', `/v1/conversations/${channel}`, {
      version: 1,
      member: { membershipId: f.mateBoot.me.id, action: 'remove' },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const continued = await search(f.mate, {
      q: 'revocable',
      conversationId: channel,
      limit: '1',
      cursor: first.next_cursor!,
    });
    expect(continued.statusCode, continued.body).toBe(200);
    expect(continued.json<SearchPage>().items).toEqual([]);
    expect(
      (await f.call(f.mate, 'GET', `/v1/conversations/${channel}/messages/history`)).statusCode,
    ).toBe(404);
    for (const suffix of ['', '/versions', '/versions/1'])
      expect((await f.call(f.mate, 'GET', `/v1/knowledge/${page}${suffix}`)).statusCode).toBe(404);
  });
  it('accepts the documented Unicode body limit and rejects page/history divergence at commit', async () => {
    const page = await createPage();
    const text = '語'.repeat(50000);
    const saved = await f.call(f.owner, 'PATCH', `/v1/knowledge/${page}`, {
      version: 1,
      title: 'Unicode handbook',
      body: text,
      clientId: randomUUID(),
    });
    expect(saved.statusCode, saved.body.slice(0, 300)).toBe(200);
    expect(saved.json().page.body).toBe(text);
    await expect(
      f.db.query('UPDATE knowledge_pages SET body=$2,version=version+1 WHERE id=$1', [
        page,
        'Missing history',
      ]),
    ).rejects.toThrow();
    await expect(
      f.db.query('UPDATE knowledge_pages SET conversation_id=$2,version=version+1 WHERE id=$1', [
        page,
        f.ownerBoot.channels[0]!.id,
      ]),
    ).rejects.toThrow();
    await expect(
      f.db.query(
        'INSERT INTO knowledge_versions(id,workspace_id,page_id,title,body,version,author_id) VALUES($1,$2,$3,$4,$5,3,$6)',
        [
          randomUUID(),
          f.ownerBoot.workspace.id,
          page,
          'Fake future revision',
          'Divergent revision',
          f.ownerBoot.me.id,
        ],
      ),
    ).rejects.toThrow();
    expect((await f.call(f.owner, 'GET', `/v1/knowledge/${page}`)).json().version).toBe(2);
  });
});
