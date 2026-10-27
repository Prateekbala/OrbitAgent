import type { Sql } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { containsMention } from '@ao/contracts';
import { fromMarkdown } from 'mdast-util-from-markdown';
function mentionLinks(body: string) {
  const ids = new Set<string>();
  const visit = (node: { type: string; url?: string; children?: unknown[] }) => {
    if (
      node.type === 'link' &&
      node.url &&
      /^mention:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        node.url,
      )
    )
      ids.add(node.url.slice(8).toLowerCase());
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  };
  visit(fromMarkdown(body));
  return [...ids].sort();
}
export async function storeMentions(
  tx: Sql,
  p: Identity,
  conversation: string,
  message: string,
  body: string,
  explicit: string[],
  format: 'plain' | 'markdown' = 'plain',
) {
  if (!body.includes('@') && !body.includes('mention:') && !explicit.length) return;
  const structured = format === 'markdown' ? mentionLinks(body) : [];
  const eligible = await tx.query<{ id: string; name: string; kind: string }>(
    `SELECT m.id,m.name,m.kind FROM memberships m JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=$2
    WHERE m.workspace_id=$1 AND m.status='active' AND ((c.visibility='public' AND m.access_type='member') OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=m.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=m.id))`,
    [p.workspaceId, conversation],
  );
  const byId = new Map(eligible.map((member) => [member.id, member]));
  for (const target of explicit) {
    const member = byId.get(target);
    if (
      !member ||
      (!structured.includes(target) &&
        (!containsMention(body, member.name) || member.kind === 'agent'))
    )
      throw new AppError(400, 'INVALID_MENTION', 'Mention an active participant by name.');
  }
  const counts = new Map<string, number>();
  for (const member of eligible)
    counts.set(member.name.toLowerCase(), (counts.get(member.name.toLowerCase()) ?? 0) + 1);
  for (const target of structured)
    if (!byId.has(target))
      throw new AppError(
        400,
        'INVALID_MENTION',
        'Choose an active participant in this conversation.',
      );
  const selected = new Set([...explicit, ...structured]);
  for (const member of eligible)
    if (
      format === 'plain' &&
      member.kind === 'human' &&
      counts.get(member.name.toLowerCase()) === 1 &&
      containsMention(body, member.name)
    )
      selected.add(member.id);
  if (selected.size > 50)
    throw new AppError(400, 'MENTION_LIMIT', 'Mention up to 50 people per message.');
  if (selected.size)
    await tx.query(
      'INSERT INTO message_mentions(workspace_id,conversation_id,message_id,membership_id) SELECT $1,$2,$3,unnest($4::uuid[]) ON CONFLICT DO NOTHING',
      [p.workspaceId, conversation, message, [...selected]],
    );
}
