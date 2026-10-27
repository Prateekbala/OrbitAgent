import type { EmailService } from '../email/service.js';
import { AccountService } from '../identity/service.js';
import { randomUUID } from 'node:crypto';
import { identityScope, type Database } from '@ao/database';
import type { invitationAcceptance } from '@ao/contracts';
import type { z } from 'zod';
import { digest, hashPassword } from '../lib/security.js';
import { createSession } from '../lib/sessions.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { assertInvitationPolicy } from '../identity/organizations.js';
import { lookupAccountSession } from '../identity/security.js';
interface InviteRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  email: string;
  role: 'admin' | 'member';
  status: string;
  expired: boolean;
  workspace_name: string;
  inviter_id: string;
  access_type: 'member' | 'guest';
  conversation_ids: string[];
}
export async function findInvitation(db: Database, value: string) {
  const [invite] = await identityScope(() =>
    db.query<InviteRow>(
      `SELECT i.*,i.expires_at<=now() expired,w.name workspace_name FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=$1`,
      [digest(value)],
    ),
  );
  if (!invite) throw notFound();
  if (invite.expired || invite.status === 'revoked')
    throw new AppError(
      410,
      'INVITATION_UNAVAILABLE',
      'This invitation has expired or was revoked.',
    );
  if (invite.status !== 'pending')
    throw new AppError(409, 'INVITATION_USED', 'This invitation was already accepted.');
  return invite;
}
export async function sessionAccount(db: Database, sessionToken: string | undefined) {
  if (!sessionToken) return null;
  const row = await lookupAccountSession(db, sessionToken);
  if (!row || (row.mfa_enabled && !row.mfa_verified_at)) return null;
  return {
    id: row.account_id,
    email: row.email,
    auth_version: row.auth_version,
    created_at: row.created_at,
    user_agent: row.user_agent,
    ip_address: row.ip_address,
    email_verified_at: row.email_verified_at,
    mfa_verified_at: row.mfa_verified_at,
    authentication_method: row.authentication_method,
    provider_id: row.provider_id,
  };
}
export async function acceptInvitation(
  db: Database,
  input: z.infer<typeof invitationAcceptance>,
  sessionToken: string | undefined,
  email: EmailService,
) {
  const invite = await findInvitation(db, input.token),
    account = await sessionAccount(db, sessionToken);
  await assertInvitationPolicy(db, invite.workspace_id, invite.email, invite.access_type);
  if (account && account.email !== invite.email)
    throw new AppError(
      403,
      'INVITATION_ACCOUNT_MISMATCH',
      'Sign in with the account this invitation was sent to.',
    );
  if (!account) {
    const [existing] = await identityScope(() =>
      db.query('SELECT id FROM accounts WHERE email=$1', [invite.email]),
    );
    if (existing)
      throw new AppError(
        401,
        'SIGN_IN_REQUIRED',
        'Sign in with your existing account before accepting this invitation.',
      );
    if (!input.name || !input.password)
      throw new AppError(
        400,
        'ACCOUNT_DETAILS_REQUIRED',
        'Provide your name and a password to join.',
      );
  }
  if (!account) email.requireConfigured();
  const passwordHash = !account ? await hashPassword(input.password!) : null;
  return identityScope(
    () =>
      db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [invite.workspace_id]);
        const [current] = await tx.query<InviteRow>(
          'SELECT *,expires_at<=now() expired FROM invitations WHERE id=$1 AND token_hash=$2 FOR UPDATE',
          [invite.id, digest(input.token)],
        );
        if (!current || current.status !== 'pending' || current.expired)
          throw new AppError(
            409,
            'INVITATION_UNAVAILABLE',
            'This invitation can no longer be accepted.',
          );
        const [inviter] = await tx.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND kind='human'",
          [invite.workspace_id, current.inviter_id],
        );
        if (
          !inviter ||
          !['owner', 'admin'].includes(String(inviter.role)) ||
          (current.role === 'admin' && inviter.role !== 'owner')
        )
          throw new AppError(
            409,
            'INVITER_AUTHORITY_CHANGED',
            'The inviter no longer has authority to grant this access. Ask for a new invitation.',
          );
        const accountId = account ? String(account.id) : randomUUID();
        if (!account)
          await tx.query('INSERT INTO accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
            accountId,
            current.email,
            input.name,
            passwordHash,
          ]);
        if (!account)
          await new AccountService(db, email).queueProof(
            tx,
            accountId,
            current.email,
            'verify_email',
          );
        const [existing] = await tx.query(
          'SELECT id,status FROM memberships WHERE workspace_id=$1 AND account_id=$2',
          [invite.workspace_id, accountId],
        );
        if (existing)
          throw new AppError(
            409,
            'ALREADY_MEMBER',
            'This account already belongs to the workspace.',
          );
        const [person] = await tx.query('SELECT name FROM accounts WHERE id=$1', [accountId]);
        const membershipId = randomUUID();
        await tx.query(
          "INSERT INTO memberships(id,workspace_id,account_id,name,kind,role,access_type) VALUES($1,$2,$3,$4,'human',$5,$6)",
          [
            membershipId,
            invite.workspace_id,
            accountId,
            person!.name,
            current.role,
            current.access_type,
          ],
        );
        await tx.query('SET LOCAL ROLE ao_runtime');
        for (const conversation of current.conversation_ids) {
          const [row] = await tx.query(
            "SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2 AND kind<>'direct' FOR SHARE",
            [conversation, invite.workspace_id],
          );
          if (!row) throw notFound();
          await tx.query(
            'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [invite.workspace_id, conversation, membershipId],
          );
        }
        await tx.query('SET LOCAL ROLE ao_identity');
        await tx.query("UPDATE invitations SET status='accepted',accepted_by=$1 WHERE id=$2", [
          accountId,
          current.id,
        ]);
        await recordChange(
          tx,
          {
            workspaceId: invite.workspace_id,
            membershipId,
            name: String(person!.name),
            role: current.role,
            kind: 'human',
          },
          'invitation.accepted',
          current.id,
        );
        const sessionOptions = account
          ? {
              mfaVerifiedAt: account.mfa_verified_at,
              method: account.authentication_method,
              providerId: account.provider_id,
              authenticatedAt: account.created_at,
              userAgent: account.user_agent,
              ipAddress: account.ip_address,
            }
          : {};
        let value: string;
        try {
          value = await createSession(
            tx,
            accountId,
            membershipId,
            account ? Number(account.auth_version) : undefined,
            sessionOptions,
          );
        } catch (error) {
          if (
            !(error instanceof AppError) ||
            !['SSO_REQUIRED', 'SESSION_REAUTHENTICATION_REQUIRED'].includes(error.code)
          )
            throw error;
          value = await createSession(
            tx,
            accountId,
            null,
            account ? Number(account.auth_version) : undefined,
            sessionOptions,
          );
        }
        if (sessionToken)
          await tx.query('DELETE FROM sessions WHERE token_hash=$1 AND account_id=$2', [
            digest(sessionToken),
            accountId,
          ]);
        return { session: value };
      }),
    invite.workspace_id,
  );
}
