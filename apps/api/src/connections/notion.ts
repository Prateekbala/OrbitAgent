import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { ConnectorRequest, ProviderDocument, ProviderTransport } from './provider.js';
import { ProviderFailure } from './provider-errors.js';
const richText = z.array(
  z
    .object({
      plain_text: z.string().optional(),
      text: z.object({ content: z.string() }).optional(),
    })
    .passthrough(),
);
function text(value: unknown) {
  const parsed = richText.safeParse(value);
  return parsed.success
    ? parsed.data.map((v) => v.plain_text ?? v.text?.content ?? '').join('')
    : '';
}
export async function readNotion(
  input: ConnectorRequest,
  transport: ProviderTransport,
  pace: () => Promise<unknown> = () => setTimeout(350, undefined, { signal: input.signal }),
): Promise<ProviderDocument> {
  const root = z.uuid().parse(input.resource),
    queue = [{ id: root, depth: 0 }],
    seen = new Set<string>(),
    children = new Map<string, string[]>(),
    contentById = new Map<string, string>();
  let requests = 0,
    blocks = 0,
    bytes = 0;
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i]!;
    if (entry.depth > 7 || seen.has(entry.id)) throw new ProviderFailure('PROVIDER_TREE_LIMIT');
    seen.add(entry.id);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      if (++requests > 20) throw new ProviderFailure('PROVIDER_TREE_LIMIT');
      if (requests > 1) await pace();
      await input.guard?.();
      const url = new URL(`https://api.notion.com/v1/blocks/${entry.id}/children`);
      url.searchParams.set('page_size', '100');
      if (cursor) url.searchParams.set('start_cursor', cursor);
      const response = await transport(
        {
          url,
          method: 'GET',
          headers: {
            authorization: 'Bearer ' + input.credential.accessToken,
            accept: 'application/json',
            'notion-version': '2022-06-28',
          },
        },
        input.signal,
      );
      if (response.status !== 200)
        throw new ProviderFailure(
          response.status === 404
            ? 'PROVIDER_RESOURCE_NOT_FOUND'
            : response.status === 401 || response.status === 403
              ? 'PROVIDER_AUTH_REQUIRED'
              : response.status === 429
                ? 'PROVIDER_RATE_LIMITED'
                : 'PROVIDER_READ_FAILED',
          response.retryAfter,
        );
      const value = z
        .object({
          results: z
            .array(
              z
                .object({
                  id: z.uuid(),
                  type: z.string(),
                  has_children: z.boolean().default(false),
                })
                .passthrough(),
            )
            .max(100),
          has_more: z.boolean(),
          next_cursor: z.string().min(1).max(200).nullable(),
        })
        .parse(JSON.parse(response.body));
      for (const block of value.results) {
        if (++blocks > 1000) throw new ProviderFailure('PROVIDER_TREE_LIMIT');
        const content = block[block.type] as Record<string, unknown> | undefined;
        const line =
          block.type === 'table_row' && Array.isArray(content?.cells)
            ? content.cells.map(text).join(' | ')
            : text(content?.rich_text) ||
              text(content?.caption) ||
              (typeof content?.title === 'string' ? content.title : '');
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > 1000000) throw new ProviderFailure('PROVIDER_RESPONSE_LIMIT');
        if (contentById.has(block.id)) throw new ProviderFailure('PROVIDER_PAGINATION_INVALID');
        contentById.set(block.id, line);
        children.set(entry.id, [...(children.get(entry.id) ?? []), block.id]);
        if (block.has_children || block.type === 'child_page')
          queue.push({ id: block.id, depth: entry.depth + 1 });
      }
      if (value.has_more) {
        if (!value.next_cursor || cursors.has(value.next_cursor))
          throw new ProviderFailure('PROVIDER_PAGINATION_INVALID');
        cursors.add(value.next_cursor);
        cursor = value.next_cursor;
      } else cursor = undefined;
    } while (cursor);
  }
  const lines: string[] = [];
  const render = (parent: string) => {
    for (const id of children.get(parent) ?? []) {
      const line = contentById.get(id);
      if (line) lines.push(line);
      render(id);
    }
  };
  render(root);
  return {
    title: 'Notion page ' + root,
    body: lines.join('\n'),
    sourceUrl: 'https://www.notion.so/' + root.replaceAll('-', ''),
  };
}
