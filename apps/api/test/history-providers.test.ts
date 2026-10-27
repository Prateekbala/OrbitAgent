import { describe, it, expect } from 'vitest';
import { HistoryProviders } from '../src/interoperability/providers.js';
describe('independent provider history transports', () => {
  it('collects Slack history and replies through their distinct endpoints without retaining tokens', async () => {
    const urls: URL[] = [];
    const p = new HistoryProviders(async (url, init) => {
      urls.push(url);
      expect(init.redirect).toBe('error');
      return Response.json({
        ok: true,
        messages: [
          { ts: '1710000000.000001', user: 'U1', text: 'Root', reply_count: 1 },
          { ts: '1710000001.000001', thread_ts: '1710000000.000001', user: 'U2', text: 'Reply' },
        ],
        response_metadata: { next_cursor: 'next' },
      });
    });
    const page = await p.slack('secret-token', 'C1');
    expect(page.replyRoots).toEqual(['1710000000.000001']);
    const replies = await p.slack('secret-token', 'C1', undefined, page.replyRoots[0]);
    expect(replies.records).toHaveLength(1);
    expect(urls[1]!.pathname).toBe('/api/conversations.replies');
    expect(JSON.stringify(page)).not.toContain('secret-token');
  });
  it('binds Teams pagination to the exact channel/reply resource and rejects SSRF cursors', async () => {
    const p = new HistoryProviders(async () =>
      Response.json({
        value: [
          {
            id: '1',
            createdDateTime: '2026-01-01T00:00:00Z',
            lastModifiedDateTime: '2026-01-01T00:00:00Z',
            from: { user: { id: 'A', displayName: 'Ava' } },
            body: { contentType: 'text', content: 'Teams message' },
          },
        ],
      }),
    );
    expect((await p.teams('token', 'team', 'channel')).records[0]!.body).toBe('Teams message');
    await expect(
      p.teams('token', 'team', 'channel', 'https://127.0.0.1/private'),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CURSOR' });
    await expect(
      p.teams('token', 'team', 'channel', 'https://graph.microsoft.com/v1.0/users'),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CURSOR' });
  });
  it('uses Discord bot authorization and explicit thread mappings and honors rate-limit backpressure', async () => {
    const p = new HistoryProviders(async (url, init) => {
      expect(url.origin).toBe('https://discord.com');
      expect((init.headers as { authorization: string }).authorization).toBe('Bot token');
      return Response.json([
        {
          id: '200',
          author: { id: '1', username: 'Ava' },
          content: 'Thread reply',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ]);
    });
    expect((await p.discord('token', '100', undefined, 'root')).records[0]!.threadId).toBe('root');
    const limited = new HistoryProviders(
      async () => new Response('', { status: 429, headers: { 'retry-after': '12' } }),
    );
    await expect(limited.discord('token', '100')).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
      message: expect.stringContaining('12 seconds'),
    });
  });
});
