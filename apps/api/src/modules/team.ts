import type { EmailService } from '../email/service.js';
import type { FastifyInstance } from 'fastify';
import { identityScope, type Database } from '@ao/database';
import { z } from 'zod';
import {
  id,
  invitationInput,
  invitationToken,
  invitationAcceptance,
  memberUpdate,
} from '@ao/contracts';
import { authenticate } from './auth.js';
import { requireAdmin } from '../lib/policy.js';
import { TeamService } from '../team/service.js';
import { acceptInvitation, findInvitation, sessionAccount } from '../team/acceptance.js';
import { createSession, sessionCookie } from '../lib/sessions.js';
import { digest } from '../lib/security.js';
import { AppError, notFound } from '../lib/errors.js';
import { currentSession } from '../identity/security.js';
export function teamRoutes(
  app: FastifyInstance,
  db: Database,
  production: boolean,
  email: EmailService,
) {
  const service = new TeamService(db, email);
  app.get('/v1/members', async (req) => {
    const p = await authenticate(db, req);
    return db.query(
      'SELECT id,name,kind,role,status,version,access_type,permissions,account_id FROM memberships WHERE workspace_id=$1 ORDER BY kind,name',
      [p.workspaceId],
    );
  });
  app.patch('/v1/members/:id', async (req) =>
    service.update(
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
      memberUpdate.parse(req.body),
    ),
  );
  app.get('/v1/invitations', async (req) => {
    const p = await authenticate(db, req);
    requireAdmin(p);
    return db.query(
      `SELECT i.id,i.email,i.role,i.status,i.expires_at,i.created_at,(SELECT j.status FROM email_jobs j WHERE j.invitation_id=i.id ORDER BY j.created_at DESC LIMIT 1) delivery_status,(SELECT j.error_code FROM email_jobs j WHERE j.invitation_id=i.id ORDER BY j.created_at DESC LIMIT 1) delivery_error FROM invitations i WHERE i.workspace_id=$1 ORDER BY i.created_at DESC LIMIT 100`,
      [p.workspaceId],
    );
  });
  app.post('/v1/invitations', async (req, reply) => {
    const p = await authenticate(db, req);
    const result = await service.invite(p, invitationInput.parse(req.body));
    return reply.code(201).header('cache-control', 'no-store').send(result);
  });
  app.post('/v1/invitations/:id/resend', async (req) =>
    service.resend(await authenticate(db, req), id.parse((req.params as { id: string }).id)),
  );
  app.post('/v1/invitations/:id/revoke', async (req) =>
    service.revoke(await authenticate(db, req), id.parse((req.params as { id: string }).id)),
  );
  app.post(
    '/v1/invitations/preview',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token } = z.object({ token: invitationToken }).strict().parse(req.body);
      const invite = await findInvitation(db, token);
      return reply.header('cache-control', 'no-store').send({
        workspace: invite.workspace_name,
        role: invite.role,
        emailHint: invite.email.replace(/^(.).*(@.*)$/, '$1…$2'),
      });
    },
  );
  app.post(
    '/v1/invitations/accept',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const result = await acceptInvitation(
        db,
        invitationAcceptance.parse(req.body),
        req.cookies.ao_session,
        email,
      );
      reply.setCookie('ao_session', result.session, sessionCookie(production));
      return reply.code(201).send({ ok: true });
    },
  );
  app.get('/v1/workspaces', async (req) => {
    await currentSession(db, req);
    const account = await sessionAccount(db, req.cookies.ao_session);
    if (!account)
      throw new AppError(403, 'HUMAN_REQUIRED', 'Workspace switching requires a human session.');
    return identityScope(() =>
      db.query(
        "SELECT m.id,m.workspace_id,m.role,w.name FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.account_id=$1 AND m.status='active' ORDER BY w.name",
        [account.id],
      ),
    );
  });
  app.post('/v1/workspaces/switch', async (req, reply) => {
    await currentSession(db, req);
    const input = z.object({ membershipId: id }).strict().parse(req.body),
      account = await sessionAccount(db, req.cookies.ao_session);
    if (!account)
      throw new AppError(403, 'HUMAN_REQUIRED', 'Workspace switching requires a human session.');
    const [destination] = await identityScope(() =>
      db.query(
        "SELECT workspace_id FROM memberships WHERE id=$1 AND account_id=$2 AND status='active'",
        [input.membershipId, account.id],
      ),
    );
    if (!destination) throw notFound();
    const session = await identityScope(
      () =>
        db.transaction(async (tx) => {
          const [membership] = await tx.query(
            "SELECT id FROM memberships WHERE id=$1 AND account_id=$2 AND status='active' FOR SHARE",
            [input.membershipId, account.id],
          );
          if (!membership) throw notFound();
          const value = await createSession(
            tx,
            String(account.id),
            input.membershipId,
            Number(account.auth_version),
            {
              mfaVerifiedAt: account.mfa_verified_at as Date | null,
              method: account.authentication_method as 'password' | 'oidc' | 'saml',
              providerId: account.provider_id ? String(account.provider_id) : null,
              authenticatedAt: account.created_at,
              userAgent: account.user_agent,
              ipAddress: account.ip_address,
            },
          );
          await tx.query('DELETE FROM sessions WHERE token_hash=$1 AND account_id=$2', [
            digest(req.cookies.ao_session!),
            account.id,
          ]);
          return value;
        }),
      String(destination.workspace_id),
    );
    reply.setCookie('ao_session', session, sessionCookie(production));
    return { ok: true };
  });
}
