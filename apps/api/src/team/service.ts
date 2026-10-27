import type { EmailService } from '../email/service.js';
import { randomUUID } from 'node:crypto';
import { identityScope, type Database } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { requireAdmin, lockAdministrator } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest, token } from '../lib/security.js';
import { recordChange } from '../lib/events.js';
import type { memberUpdate, invitationInput } from '@ao/contracts';
import type { z } from 'zod';
import { assertInvitationPolicy } from '../identity/organizations.js';
import { revokeMemberMachines } from '../identity/machine-credentials.js';
export class TeamService {
  constructor(
    private readonly db: Database,
    private readonly email: EmailService,
  ) {}
  async invite(actor: Identity, input: z.infer<typeof invitationInput>) {
    requireAdmin(actor);
    this.email.requireConfigured();
    await assertInvitationPolicy(this.db, actor.workspaceId, input.email, input.accessType);
    if (input.accessType === 'guest' && (input.role !== 'member' || !input.conversationIds.length))
      throw new AppError(
        400,
        'GUEST_SCOPE_REQUIRED',
        'Guests require a member role and at least one shared conversation.',
      );
    const [existing] = await identityScope(() =>
      this.db.query(
        'SELECT m.id FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.workspace_id=$1 AND a.email=$2',
        [actor.workspaceId, input.email],
      ),
    );
    if (existing)
      throw new AppError(
        409,
        'ALREADY_MEMBER',
        'This account is already a workspace member. Manage its access instead.',
      );
    const value = token(),
      invitationId = randomUUID();
    await this.db.transaction(async (tx) => {
      const role = await lockAdministrator(tx, actor);
      if (input.role === 'admin' && role !== 'owner')
        throw new AppError(403, 'OWNER_REQUIRED', 'Only an owner can invite administrators.');
      await tx.query(
        "UPDATE invitations SET status='revoked' WHERE workspace_id=$1 AND email=$2 AND status='pending' AND expires_at<=now()",
        [actor.workspaceId, input.email],
      );
      await tx.query(
        'INSERT INTO invitations(id,workspace_id,email,role,token_hash,inviter_id,access_type,conversation_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          invitationId,
          actor.workspaceId,
          input.email,
          input.role,
          digest(value),
          actor.membershipId,
          input.accessType,
          input.conversationIds,
        ],
      );
      for (const conversation of input.conversationIds) {
        const [row] = await tx.query(
          "SELECT id,kind,next_sequence,conversation_has_history(workspace_id,id) has_history FROM conversations WHERE id=$1 AND workspace_id=$2 AND kind<>'direct' FOR SHARE",
          [conversation, actor.workspaceId],
        );
        if (!row) throw notFound();
        if (row.kind === 'group' && row.has_history)
          throw new AppError(
            409,
            'GROUP_MANAGEMENT_REQUIRED',
            'Invite this guest to a channel, then ask a group owner to add them with the appropriate history access.',
          );
      }
      const [workspace] = await tx.query('SELECT name FROM workspaces WHERE id=$1', [
        actor.workspaceId,
      ]);
      await this.email.enqueue(tx, {
        kind: 'invitation',
        to: input.email,
        token: value,
        invitationId,
        workspaceId: actor.workspaceId,
        workspace: String(workspace!.name),
      });
      await recordChange(tx, actor, 'invitation.created', invitationId);
    });
    return { id: invitationId, token: value };
  }
  async resend(actor: Identity, id: string) {
    this.email.requireConfigured();
    return this.db.transaction(async (tx) => {
      const role = await lockAdministrator(tx, actor);
      const [invite] = await tx.query(
        "SELECT email,role FROM invitations WHERE workspace_id=$1 AND id=$2 AND status='pending' FOR UPDATE",
        [actor.workspaceId, id],
      );
      if (!invite) throw notFound();
      if (invite.role === 'admin' && role !== 'owner')
        throw new AppError(
          403,
          'OWNER_REQUIRED',
          'Only an owner can resend administrator invitations.',
        );
      const [recent] = await tx.query(
        "SELECT id FROM email_jobs WHERE invitation_id=$1 AND created_at>now()-interval '1 minute' LIMIT 1",
        [id],
      );
      if (recent)
        throw new AppError(
          429,
          'EMAIL_COOLDOWN',
          'Wait a minute before resending this invitation.',
        );
      const value = token();
      await tx.query(
        "UPDATE invitations SET token_hash=$1,expires_at=now()+interval '7 days',inviter_id=$2 WHERE id=$3",
        [digest(value), actor.membershipId, id],
      );
      await tx.query(
        "UPDATE email_jobs SET status='cancelled',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE invitation_id=$1 AND status IN ('queued','sending')",
        [id],
      );
      const [workspace] = await tx.query('SELECT name FROM workspaces WHERE id=$1', [
        actor.workspaceId,
      ]);
      await this.email.enqueue(tx, {
        kind: 'invitation',
        to: String(invite.email),
        token: value,
        invitationId: id,
        workspaceId: actor.workspaceId,
        workspace: String(workspace!.name),
      });
      await recordChange(tx, actor, 'invitation.resent', id);
      return { ok: true };
    });
  }
  async revoke(actor: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      const role = await lockAdministrator(tx, actor);
      const [invite] = await tx.query(
        "SELECT role FROM invitations WHERE workspace_id=$1 AND id=$2 AND status='pending' FOR UPDATE",
        [actor.workspaceId, id],
      );
      if (!invite) throw notFound();
      if (invite.role === 'admin' && role !== 'owner')
        throw new AppError(
          403,
          'OWNER_REQUIRED',
          'Only an owner can revoke administrator invitations.',
        );
      await tx.query("UPDATE invitations SET status='revoked' WHERE workspace_id=$1 AND id=$2", [
        actor.workspaceId,
        id,
      ]);
      await tx.query(
        "UPDATE email_jobs SET status='cancelled',ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL WHERE invitation_id=$1 AND status IN ('queued','sending')",
        [id],
      );
      await recordChange(tx, actor, 'invitation.revoked', id);
      return { ok: true };
    });
  }
  async update(actor: Identity, targetId: string, input: z.infer<typeof memberUpdate>) {
    return this.db.transaction(async (tx) => {
      const actorRole = await lockAdministrator(tx, actor);
      const [target] = await tx.query('SELECT * FROM memberships WHERE workspace_id=$1 AND id=$2', [
        actor.workspaceId,
        targetId,
      ]);
      if (!target) throw notFound();
      if (target.kind !== 'human')
        throw new AppError(
          400,
          'HUMAN_MEMBER_REQUIRED',
          'Manage agent availability from the Agents screen.',
        );
      if (target.version !== input.version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'This member changed. Refresh before updating it.',
        );
      const role = input.role ?? String(target.role),
        status = input.status ?? String(target.status);
      if (target.access_type !== 'member' && role !== 'member')
        throw new AppError(
          400,
          'RESTRICTED_ROLE',
          'Guests and service accounts must keep the member role.',
        );
      if (actorRole !== 'owner' && (target.role !== 'member' || role !== 'member'))
        throw new AppError(
          403,
          'OWNER_REQUIRED',
          'Only an owner can manage owners and administrators.',
        );
      if (
        target.role === 'owner' &&
        target.status === 'active' &&
        (role !== 'owner' || status !== 'active')
      ) {
        const [count] = await tx.query(
          "SELECT count(*)::int count FROM memberships WHERE workspace_id=$1 AND kind='human' AND role='owner' AND status='active'",
          [actor.workspaceId],
        );
        if (Number(count?.count) <= 1)
          throw new AppError(
            409,
            'LAST_OWNER',
            'The workspace must retain an active owner. Promote another person first.',
          );
      }
      if (status === 'suspended' || role !== target.role) {
        const runs = await tx.query(
          "SELECT id FROM agent_runs WHERE workspace_id=$1 AND requester_id=$2 AND status IN ('queued','running','awaiting_approval','outcome_unknown') ORDER BY id FOR UPDATE",
          [actor.workspaceId, targetId],
        );
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
      if (
        status === 'suspended' ||
        (['owner', 'admin'].includes(String(target.role)) && role === 'member')
      )
        await revokeMemberMachines(tx, actor.workspaceId, targetId);
      await tx.query(
        'UPDATE memberships SET role=$1,status=$2,version=version+1 WHERE workspace_id=$3 AND id=$4',
        [role, status, actor.workspaceId, targetId],
      );
      if (status === 'suspended')
        await tx.query('DELETE FROM sessions WHERE workspace_id=$1 AND membership_id=$2', [
          actor.workspaceId,
          targetId,
        ]);
      await recordChange(tx, actor, 'member.updated', targetId);
      return { ok: true };
    });
  }
}
