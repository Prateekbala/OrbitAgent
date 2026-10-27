import { it, expect } from 'vitest';
import { tenantScope, scopedDatabase } from '@ao/database';
import { EventFeed } from '../src/messaging/events.js';
import { messagingFixture } from './messaging-fixture.js';
it('keeps publication cursors monotonic when another replica advances a coalesced head', async () => {
  const f = await messagingFixture();
  try {
    const db = scopedDatabase(f.db),
      a = new EventFeed(db),
      b = new EventFeed(db),
      p = {
        workspaceId: f.ownerBoot.workspace.id,
        membershipId: f.ownerBoot.me.id,
        name: f.ownerBoot.me.name,
        role: f.ownerBoot.me.role,
        kind: f.ownerBoot.me.kind,
      };
    await f.send(f.owner, f.ownerBoot.channels[0]!.id, 'First published event');
    const first = await tenantScope(p.workspaceId, () => a.page(p, '0'));
    await f.send(f.owner, f.ownerBoot.channels[0]!.id, 'Published by another replica');
    const other = await tenantScope(p.workspaceId, () => b.page(p, first.cursor));
    expect(BigInt(other.cursor)).toBeGreaterThan(BigInt(first.cursor));
    const coalesced = await tenantScope(p.workspaceId, () => a.page(p, first.cursor));
    expect(BigInt(coalesced.cursor)).toBeGreaterThanOrEqual(BigInt(other.cursor));
    expect(coalesced.events.some((e) => e.event_type === 'message.created')).toBe(true);
  } finally {
    await f.close();
  }
});
