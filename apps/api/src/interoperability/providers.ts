import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { normalizePage } from './adapters.js';
import type { MigrationRecord } from '@ao/contracts/interoperability';
export type ProviderFetch = (url: URL, init: RequestInit) => Promise<Response>;
export interface ProviderPage {
  records: MigrationRecord[];
  next: string | null;
  replyRoots: string[];
}
export class HistoryProviders {
  constructor(private readonly request: ProviderFetch = (url, init) => fetch(url, init)) {}
  private async json(url: URL, token: string, authPrefix = 'Bearer '): Promise<unknown> {
    const response = await this.request(url, {
      headers: { authorization: authPrefix + token },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 429)
      throw new AppError(
        429,
        'PROVIDER_RATE_LIMIT',
        'Pause collection for Retry-After ' +
          String(response.headers.get('retry-after') ?? '60').replace(/[^0-9.]/g, '') +
          ' seconds.',
      );
    if (!response.ok)
      throw new AppError(
        502,
        'PROVIDER_READ_FAILED',
        'Provider read failed with HTTP ' + response.status + '. Check resource authorization.',
      );
    if (Number(response.headers.get('content-length') ?? 0) > 2 * 1024 * 1024)
      throw new AppError(502, 'PROVIDER_PAGE_TOO_LARGE', 'Reduce the provider page size.');
    const reader = response.body?.getReader();
    if (!reader)
      throw new AppError(
        502,
        'PROVIDER_EMPTY_RESPONSE',
        'The provider returned an empty response.',
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.byteLength;
        if (size > 2 * 1024 * 1024)
          throw new AppError(502, 'PROVIDER_PAGE_TOO_LARGE', 'Reduce the provider page size.');
        chunks.push(value.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async slack(
    token: string,
    channel: string,
    cursor?: string,
    thread?: string,
    oldest?: string,
  ): Promise<ProviderPage> {
    const url = new URL(
      'https://slack.com/api/' + (thread ? 'conversations.replies' : 'conversations.history'),
    );
    url.searchParams.set('channel', channel);
    url.searchParams.set('limit', '15');
    if (cursor) url.searchParams.set('cursor', cursor);
    if (thread) url.searchParams.set('ts', thread);
    if (oldest) url.searchParams.set('oldest', oldest);
    const data = z
      .object({
        ok: z.boolean(),
        messages: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
        response_metadata: z.object({ next_cursor: z.string().max(2000).optional() }).optional(),
      })
      .parse(await this.json(url, token));
    if (!data.ok || !data.messages)
      throw new AppError(502, 'SLACK_READ_FAILED', 'Slack denied this resource or scope.');
    const messages = thread ? data.messages.filter((m) => m.ts !== thread) : data.messages;
    return {
      records: normalizePage('slack', channel, messages),
      next: data.response_metadata?.next_cursor || null,
      replyRoots: thread
        ? []
        : data.messages
            .filter((m) => Number(m.reply_count) > 0 && typeof m.ts === 'string')
            .map((m) => String(m.ts)),
    };
  }
  async teams(
    token: string,
    team: string,
    channel: string,
    next?: string,
    thread?: string,
  ): Promise<ProviderPage> {
    const prefix =
        '/v1.0/teams/' +
        encodeURIComponent(team) +
        '/channels/' +
        encodeURIComponent(channel) +
        '/messages',
      path = prefix + (thread ? '/' + encodeURIComponent(thread) + '/replies' : '');
    const url = next ? new URL(next) : new URL('https://graph.microsoft.com' + path + '?$top=50');
    if (
      url.origin !== 'https://graph.microsoft.com' ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== path
    )
      throw new AppError(
        400,
        'INVALID_PROVIDER_CURSOR',
        'The Teams page cursor does not match this resource.',
      );
    const data = z
      .object({
        value: z.array(z.record(z.string(), z.unknown())).max(100),
        '@odata.nextLink': z.string().max(4000).optional(),
      })
      .parse(await this.json(url, token));
    return {
      records: normalizePage(
        'teams',
        channel,
        data.value.map((m) => (thread ? { ...m, replyToId: thread } : m)),
      ),
      next: data['@odata.nextLink'] ?? null,
      replyRoots: thread ? [] : data.value.flatMap((m) => (typeof m.id === 'string' ? [m.id] : [])),
    };
  }
  async discord(
    token: string,
    channel: string,
    before?: string,
    threadRoot?: string,
  ): Promise<ProviderPage> {
    if (!/^\d{1,24}$/.test(channel) || (before && !/^\d{1,24}$/.test(before)))
      throw new AppError(
        400,
        'INVALID_DISCORD_RESOURCE',
        'Use Discord channel and message snowflake IDs.',
      );
    const url = new URL('https://discord.com/api/v10/channels/' + channel + '/messages?limit=100');
    if (before) url.searchParams.set('before', before);
    const data = z
      .array(z.record(z.string(), z.unknown()))
      .max(100)
      .parse(await this.json(url, token, 'Bot '));
    const records = normalizePage('discord', channel, data).map((r) =>
      threadRoot ? { ...r, threadId: threadRoot } : r,
    );
    return { records, next: data.length === 100 ? String(data.at(-1)!.id) : null, replyRoots: [] };
  }
}
