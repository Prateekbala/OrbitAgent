import type { Database } from '@ao/database';
import {
  workerScope,
  identifyPrincipal,
  identifyAgentCredential,
  identifyPlatformCredential,
} from '@ao/database';
import type { RealtimeBatch } from '@ao/contracts';
import { AppError } from '../lib/errors.js';
import type { Identity } from '../lib/policy.js';

export class EventFeed {
  private readonly publications = new Map<string, Promise<string>>();
  constructor(private readonly db: Database) {}
  private publish(workspaceId: string) {
    const pending = this.publications.get(workspaceId);
    if (pending) return pending;
    const work = workerScope(workspaceId, () =>
      this.db.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO realtime_heads(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',
          [workspaceId],
        );
        const [head] = await tx.query(
          'SELECT next_sequence::text FROM realtime_heads WHERE workspace_id=$1 FOR UPDATE',
          [workspaceId],
        );
        const changed = await tx.query(
          `WITH pending AS (
        SELECT id,row_number() OVER(ORDER BY id) ordinal FROM outbox_events WHERE workspace_id=$1 AND stream_sequence IS NULL ORDER BY id LIMIT 200
      ) UPDATE outbox_events e SET stream_sequence=$2::bigint+p.ordinal FROM pending p WHERE e.id=p.id RETURNING e.id`,
          [workspaceId, head!.next_sequence],
        );
        const [updated] = await tx.query(
          'UPDATE realtime_heads SET next_sequence=next_sequence+$2 WHERE workspace_id=$1 RETURNING next_sequence::text',
          [workspaceId, changed.length],
        );
        return String(updated!.next_sequence);
      }),
    );
    this.publications.set(workspaceId, work);
    void work
      .finally(() => {
        const timer = setTimeout(() => {
          if (this.publications.get(workspaceId) === work) this.publications.delete(workspaceId);
        }, 250);
        timer.unref();
      })
      .catch(() => {});
    return work;
  }
  async page(p: Identity, after: string): Promise<RealtimeBatch> {
    identifyPrincipal(p.membershipId, p.accessType ?? 'member');
    if (p.credentialId) identifyAgentCredential(p.credentialId);
    if (p.platformCredentialId) identifyPlatformCredential(p.platformCredentialId);
    let head = await this.publish(p.workspaceId);
    if (BigInt(after) > BigInt(head)) {
      const [current] = await this.db.query(
        'SELECT next_sequence::text FROM realtime_heads WHERE workspace_id=$1',
        [p.workspaceId],
      );
      head = String(current?.next_sequence ?? head);
    }
    if (BigInt(after) > BigInt(head))
      throw new AppError(
        409,
        'INVALID_CURSOR',
        'The event cursor is ahead of this workspace. Reconnect from the beginning.',
      );
    const rows = await this.db.query<{
      id: string;
      event_type: string;
      resource_id: string;
      conversation_id: string | null;
      visible: boolean;
    }>(
      `SELECT e.stream_sequence::text id,e.event_type,e.resource_id,e.conversation_id,
       ((e.audience_membership_id IS NULL OR e.audience_membership_id=$3) AND (e.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=e.workspace_id AND c.id=e.conversation_id AND
         (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$3))))) visible
       FROM outbox_events e WHERE e.workspace_id=$1 AND e.stream_sequence>$2 ORDER BY e.stream_sequence LIMIT 100`,
      [p.workspaceId, after, p.membershipId],
    );
    const last = rows.at(-1)?.id ?? after;
    return {
      events: rows.filter((row) => row.visible).map(({ visible: _visible, ...event }) => event),
      cursor: rows.length < 100 && BigInt(head) > BigInt(last) ? head : last,
      hasMore: rows.length === 100,
    };
  }
}
