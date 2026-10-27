import { revokeMessageComposition } from '../messaging/revocation.js';
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import type { z } from 'zod';
import type { groupInput, groupUpdate } from '@ao/contracts';
import { AppError, notFound } from '../lib/errors.js';
import { requireActiveMember, requireConversation, type Identity } from '../lib/policy.js';
import { recordChange } from '../lib/events.js';

async function actor(tx: Sql, p: Identity) {
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
  await requireActiveMember(tx, p, p.membershipId);
  if (p.kind !== 'human')
    throw new AppError(403, 'HUMAN_REQUIRED', 'A person must manage conversations.');
}
export class ConversationService {
  constructor(private readonly db: Database) {}
  async direct(p: Identity, target: string) {
    if (target === p.membershipId)
      throw new AppError(400, 'INVALID_PARTICIPANT', 'Choose another teammate.');
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      await requireActiveMember(tx, p, target);
      const [low, high] = [p.membershipId, target].sort();
      const created = await tx.query(
        `INSERT INTO conversations(id,workspace_id,name,visibility,kind,direct_low,direct_high) VALUES($1,$2,$3,'private','direct',$4,$5)
        ON CONFLICT(workspace_id,direct_low,direct_high) WHERE kind='direct' DO NOTHING RETURNING id`,
        [randomUUID(), p.workspaceId, 'dm-' + randomUUID(), low, high],
      );
      const [conversation] = created.length
        ? created
        : await tx.query(
            "SELECT id FROM conversations WHERE workspace_id=$1 AND direct_low=$2 AND direct_high=$3 AND kind='direct'",
            [p.workspaceId, low, high],
          );
      const id = String(conversation!.id);
      if (created.length) {
        for (const member of [low, high])
          await tx.query(
            'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id) VALUES($1,$2,$3)',
            [p.workspaceId, id, member],
          );
        await recordChange(tx, p, 'conversation.created', id, id);
      }
      return { id, replayed: !created.length };
    });
  }
  async group(p: Identity, input: z.infer<typeof groupInput>) {
    const members = [...new Set([p.membershipId, ...input.membershipIds])];
    if (members.length < 2 || members.length > 50)
      throw new AppError(400, 'INVALID_PARTICIPANTS', 'Choose between 2 and 50 participants.');
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      for (const member of members.sort()) await requireActiveMember(tx, p, member);
      const id = randomUUID();
      await tx.query(
        "INSERT INTO conversations(id,workspace_id,name,visibility,kind,title,history_policy) VALUES($1,$2,$3,'private','group',$4,$5)",
        [id, p.workspaceId, 'group-' + id, input.title, input.historyPolicy],
      );
      for (const member of members)
        await tx.query(
          'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id,role) VALUES($1,$2,$3,$4)',
          [p.workspaceId, id, member, member === p.membershipId ? 'owner' : 'member'],
        );
      await recordChange(tx, p, 'conversation.created', id, id);
      return { id };
    });
  }
  async details(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      await requireConversation(tx, p, id, true);
      const [row] = await tx.query(
        'SELECT id,kind,title,version,history_policy,archived_at FROM conversations WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id],
      );
      const participants = await tx.query(
        `SELECT m.id,m.name,m.kind,m.status,cm.role FROM conversation_members cm JOIN memberships m ON m.workspace_id=cm.workspace_id AND m.id=cm.membership_id WHERE cm.workspace_id=$1 AND cm.conversation_id=$2 ORDER BY cm.role,m.name,m.id`,
        [p.workspaceId, id],
      );
      return { ...row, participants };
    });
  }
  async update(p: Identity, id: string, input: z.infer<typeof groupUpdate>) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const runs = await tx.query(
        "SELECT id FROM agent_runs WHERE workspace_id=$1 AND conversation_id=$2 AND status IN ('queued','running','awaiting_approval','outcome_unknown') ORDER BY id FOR UPDATE",
        [p.workspaceId, id],
      );
      const [conversation] = await tx.query(
        'SELECT kind,version,history_policy,next_sequence,conversation_has_history(workspace_id,id) has_history FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [p.workspaceId, id],
      );
      if (!conversation) throw notFound();
      await requireConversation(tx, p, id);
      if (conversation.kind !== 'group')
        throw new AppError(400, 'GROUP_REQUIRED', 'Direct message participants cannot be changed.');
      if (conversation.version !== input.version)
        throw new AppError(409, 'VERSION_CONFLICT', 'This group changed. Reload its details.');
      const members = await tx.query(
        'SELECT cm.membership_id,cm.role,m.kind,m.status FROM conversation_members cm JOIN memberships m ON m.workspace_id=cm.workspace_id AND m.id=cm.membership_id WHERE cm.workspace_id=$1 AND cm.conversation_id=$2',
        [p.workspaceId, id],
      );
      const own = members.find((m) => m.membership_id === p.membershipId);
      const change = input.member;
      const leaving = change?.action === 'remove' && change.membershipId === p.membershipId;
      if (own?.role !== 'owner' && !leaving)
        throw new AppError(403, 'GROUP_OWNER_REQUIRED', 'A group owner must make this change.');
      if (input.historyPolicy)
        await tx.query(
          'UPDATE conversations SET history_policy=$3 WHERE workspace_id=$1 AND id=$2',
          [p.workspaceId, id, input.historyPolicy],
        );
      if (input.title)
        await tx.query('UPDATE conversations SET title=$3 WHERE workspace_id=$1 AND id=$2', [
          p.workspaceId,
          id,
          input.title,
        ]);
      if (change) {
        const target = members.find((m) => m.membership_id === change.membershipId);
        if (change.action === 'add') {
          if (target)
            throw new AppError(
              409,
              'ALREADY_PARTICIPANT',
              'This teammate is already in the group.',
            );
          if (members.length >= 50)
            throw new AppError(409, 'GROUP_FULL', 'Groups support up to 50 participants.');
          await requireActiveMember(tx, p, change.membershipId);
          const history = change.historyAccess ?? String(conversation.history_policy);
          if (history === 'retained' && conversation.has_history)
            throw new AppError(
              409,
              'HISTORY_CONSENT_REQUIRED',
              'Request existing participants’ consent before sharing earlier group history.',
            );
          await tx.query("SELECT set_config('ao.group_membership_mutation',$1,true)", [id]);
          await tx.query(
            'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id,history_from_sequence) VALUES($1,$2,$3,$4)',
            [
              p.workspaceId,
              id,
              change.membershipId,
              history === 'retained' ? 0 : Number(conversation.next_sequence) + 1,
            ],
          );
          await recordChange(tx, p, 'conversation.member_added', change.membershipId, id);
        } else {
          if (!target) throw notFound();
          if (
            change.action === 'promote' &&
            (target.kind !== 'human' || target.status !== 'active')
          )
            throw new AppError(400, 'HUMAN_REQUIRED', 'Choose an active person as group owner.');
          if (
            target.role === 'owner' &&
            change.action !== 'promote' &&
            (change.action !== 'remove' || members.length > 1) &&
            !members.some(
              (m) =>
                m.membership_id !== target.membership_id &&
                m.role === 'owner' &&
                m.status === 'active' &&
                m.kind === 'human',
            )
          )
            throw new AppError(
              409,
              'LAST_GROUP_OWNER',
              'Promote another active person before removing the last group owner.',
            );
          if (change.action === 'remove') {
            await revokeMessageComposition(tx, p.workspaceId, change.membershipId, id);
            await tx.query(
              'DELETE FROM conversation_members WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3',
              [p.workspaceId, id, change.membershipId],
            );
            await tx.query(
              "UPDATE files SET status='deleting',cleanup_after=now()+interval '5 minutes' WHERE workspace_id=$1 AND conversation_id=$2 AND uploader_id=$3 AND status IN ('pending','uploading','ready','rejected')",
              [p.workspaceId, id, change.membershipId],
            );
            await recordChange(tx, p, 'conversation.access_revoked', id, null, change.membershipId);
          } else
            await tx.query(
              'UPDATE conversation_members SET role=$4 WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3',
              [
                p.workspaceId,
                id,
                change.membershipId,
                change.action === 'promote' ? 'owner' : 'member',
              ],
            );
        }
        for (const run of runs) {
          await tx.query(
            "UPDATE agent_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
            [run.id],
          );
          await tx.query(
            "UPDATE tool_invocations SET status='cancelled' WHERE run_id=$1 AND status IN ('pending','approved')",
            [run.id],
          );
        }
      }
      const [updated] = await tx.query(
        'UPDATE conversations SET version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING version',
        [p.workspaceId, id],
      );
      await recordChange(tx, p, 'conversation.updated', id, id);
      return { ok: true, version: updated!.version };
    });
  }
}
