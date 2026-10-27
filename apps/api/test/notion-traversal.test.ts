import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readNotion } from '../src/connections/notion.js';
import { nativeWriteProvider, parseNativeMutation } from '../src/connections/mutations.js';
import type { ConnectorRequest, ProviderTransport } from '../src/connections/provider.js';
const input = (id = randomUUID()): ConnectorRequest => ({
  provider: 'notion',
  operation: 'blocks.read',
  resource: id,
  credential: { accessToken: 'private-notion-token' },
  config: {},
  signal: AbortSignal.timeout(10000),
});
const paragraph = (id: string, body: string, children = false) => ({
  id,
  type: 'paragraph',
  has_children: children,
  paragraph: { rich_text: [{ type: 'text', text: { content: body }, plain_text: body }] },
});
describe('bounded Notion block-tree imports', () => {
  it('paginates and traverses nested blocks in reading order while checking authority before every request', async () => {
    const request = input(),
      parent = randomUUID(),
      child = randomUUID(),
      last = randomUUID();
    let calls = 0,
      checks = 0;
    request.guard = async () => {
      checks++;
    };
    const transport: ProviderTransport = async (plan) => {
      calls++;
      expect(plan.url.hostname).toBe('api.notion.com');
      const nested = plan.url.pathname.includes(parent),
        paged = plan.url.searchParams.has('start_cursor');
      return {
        status: 200,
        retryAfter: 2,
        body: JSON.stringify(
          nested
            ? { results: [paragraph(child, 'Nested evidence')], has_more: false, next_cursor: null }
            : paged
              ? { results: [paragraph(last, 'Last evidence')], has_more: false, next_cursor: null }
              : {
                  results: [paragraph(parent, 'Parent evidence', true)],
                  has_more: true,
                  next_cursor: 'next-page',
                },
        ),
      };
    };
    const doc = await readNotion(request, transport, async () => {});
    expect(doc.body).toBe('Parent evidence\nNested evidence\nLast evidence');
    expect(checks).toBe(3);
    expect(calls).toBe(3);
  });
  it('rejects cyclic cursors, cycles, and revoked traversal without returning partial evidence', async () => {
    const request = input(),
      id = randomUUID();
    const loop: ProviderTransport = async () => ({
      status: 200,
      retryAfter: 2,
      body: JSON.stringify({ results: [], has_more: true, next_cursor: 'same-cursor' }),
    });
    await expect(readNotion(request, loop, async () => {})).rejects.toMatchObject({
      code: 'PROVIDER_PAGINATION_INVALID',
    });
    const cycle: ProviderTransport = async () => ({
      status: 200,
      retryAfter: 2,
      body: JSON.stringify({
        results: [paragraph(request.resource, 'Cycle', true)],
        has_more: false,
        next_cursor: null,
      }),
    });
    await expect(readNotion(request, cycle, async () => {})).rejects.toMatchObject({
      code: 'PROVIDER_TREE_LIMIT',
    });
    let calls = 0;
    request.guard = async () => {
      if (++calls === 2) throw new Error('revoked');
    };
    const guarded: ProviderTransport = async () => ({
      status: 200,
      retryAfter: 2,
      body: JSON.stringify({
        results: [paragraph(id, 'First page')],
        has_more: true,
        next_cursor: 'next',
      }),
    });
    await expect(readNotion(request, guarded, async () => {})).rejects.toThrow('revoked');
    expect(calls).toBe(2);
  });
  it('updates only plain paragraphs and reconciles the exact resulting text', async () => {
    const request = input(),
      mutation = parseNativeMutation(
        'notion',
        'paragraph.replace',
        JSON.stringify({
          resource: request.resource,
          patch: { text: 'After' },
          expected: { text: 'Before' },
        }),
      );
    let calls = 0;
    const transport: ProviderTransport = async (plan) => {
      calls++;
      expect(plan.url.pathname).toBe('/v1/blocks/' + request.resource);
      if (calls === 2)
        expect(JSON.parse(plan.body!)).toEqual({
          paragraph: { rich_text: [{ type: 'text', text: { content: 'After' } }] },
        });
      return {
        status: 200,
        retryAfter: 2,
        body: JSON.stringify(paragraph(request.resource, calls >= 2 ? 'After' : 'Before')),
      };
    };
    const result = await nativeWriteProvider(transport)({
      ...request,
      operation: 'paragraph.replace',
      mutation,
      key: 'notion-action',
      reconcile: false,
      guard: async () => {},
    });
    expect(result.status).toBe('succeeded');
    expect(calls).toBe(3);
  });
});
