import { randomUUID } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { identityScope, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  id,
  organizationInput,
  organizationPolicyInput,
  workspaceCreateInput,
  organizationMemberInput,
} from '@ao/contracts';
import { currentSession } from '../identity/security.js';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import { offboardWorkspace } from '../identity/offboarding.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest, token } from '../lib/security.js';
export interface OrganizationOptions {
  region?: string;
  resolveDomain?: (name: string) => Promise<string[][]>;
}
export function organizationRoutes(
  app: FastifyInstance,
  db: Database,
  options: OrganizationOptions = {},
) {
  const params = (value: unknown) => z.object({ org: id }).passthrough().parse(value).org;
  const region = options.region ?? 'global';
  app.get('/v1/organizations', async (req) => {
    const session = await currentSession(db, req);
    return identityScope(() =>
      db.query(
        "SELECT o.*,m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.account_id=$1 AND m.status='active' ORDER BY o.name,o.id",
        [session.account_id],
      ),
    );
  });
  app.post('/v1/organizations', async (req, reply) => {
    const session = await currentSession(db, req),
      input = organizationInput.parse(req.body),
      org = randomUUID();
    await identityScope(() =>
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO organizations(id,name,allowed_regions) VALUES($1,$2,$3)', [
          org,
          input.name,
          [region],
        ]);
        await tx.query(
          "INSERT INTO organization_members(organization_id,account_id,role) VALUES($1,$2,'owner')",
          [org, session.account_id],
        );
        await organizationAudit(tx, org, session.account_id, 'organization.created', org);
      }),
    );
    return reply.code(201).send({ id: org });
  });
  app.patch('/v1/organizations/:org', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params),
      input = organizationPolicyInput.parse(req.body);
    await identityScope(() =>
      db.transaction(async (tx) => {
        const current = await organizationActor(tx, org, session.account_id, true, true);
        if (current.role !== 'owner')
          throw new AppError(
            403,
            'OWNER_REQUIRED',
            'Only an organization owner can change security policies.',
          );
        if (current.version !== input.version)
          throw new AppError(
            409,
            'VERSION_CONFLICT',
            'Organization settings changed. Refresh and try again.',
          );
        const verified = await tx.query(
          'SELECT domain FROM organization_domains WHERE organization_id=$1 AND verified_at IS NOT NULL',
          [org],
        );
        if (input.allowedDomains.some((d) => !verified.some((v) => v.domain === d)))
          throw new AppError(
            409,
            'DOMAIN_NOT_VERIFIED',
            'Verify every allowed domain through DNS first.',
          );
        const [used] = await tx.query(
          'SELECT id FROM workspaces WHERE organization_id=$1 AND NOT(region=ANY($2::text[])) LIMIT 1',
          [org, input.allowedRegions],
        );
        if (used)
          throw new AppError(
            409,
            'REGION_IN_USE',
            'An existing workspace uses a region outside this policy.',
          );
        if (input.requireMfa) {
          const [account] = await tx.query('SELECT mfa_enabled FROM accounts WHERE id=$1', [
            session.account_id,
          ]);
          if (!account?.mfa_enabled || !session.mfa_verified_at)
            throw new AppError(
              409,
              'MFA_SETUP_REQUIRED',
              'Enable MFA on your current account before requiring it for the organization.',
            );
        }
        if (input.requireSso) {
          const [provider] = await tx.query(
            'SELECT p.id FROM identity_providers p JOIN federated_identities f ON f.provider_id=p.id WHERE p.organization_id=$1 AND p.enabled AND f.account_id=$2 AND p.id=$3',
            [org, session.account_id, session.provider_id],
          );
          if (!provider)
            throw new AppError(
              409,
              'SSO_TEST_REQUIRED',
              'Sign in through a configured provider before enforcing SSO.',
            );
        }
        if (input.allowedDomains.length) {
          const [account] = await tx.query('SELECT email FROM accounts WHERE id=$1', [
            session.account_id,
          ]);
          if (!input.allowedDomains.includes(String(account?.email).split('@')[1]!))
            throw new AppError(
              409,
              'OWNER_DOMAIN_REQUIRED',
              'Your account must satisfy the proposed domain policy.',
            );
        }
        await tx.query(
          'UPDATE organizations SET name=$2,allowed_domains=$3,allowed_regions=$4,require_mfa=$5,require_sso=$6,session_hours=$7,version=version+1 WHERE id=$1',
          [
            org,
            input.name,
            [...new Set(input.allowedDomains)],
            [...new Set(input.allowedRegions)],
            input.requireMfa,
            input.requireSso,
            input.sessionHours,
          ],
        );
        await organizationAudit(tx, org, session.account_id, 'organization.policy_updated', org);
      }),
    );
    return { ok: true };
  });
  app.get('/v1/organizations/:org/workspaces', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params);
    return identityScope(async () => {
      const actor = await organizationActor(db, org, session.account_id);
      return db.query(
        `SELECT w.id,w.name,w.region,m.id membership_id FROM workspaces w LEFT JOIN memberships m ON m.workspace_id=w.id AND m.account_id=$2 AND m.status='active' WHERE w.organization_id=$1 AND ($3::boolean OR m.id IS NOT NULL) ORDER BY w.name,w.id`,
        [org, session.account_id, ['owner', 'admin'].includes(String(actor.role))],
      );
    });
  });
  app.post('/v1/organizations/:org/workspaces', async (req, reply) => {
    const session = await currentSession(db, req),
      org = params(req.params),
      input = workspaceCreateInput.parse(req.body),
      workspace = randomUUID(),
      member = randomUUID();
    await identityScope(() =>
      db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, session.account_id, true, true);
        if (!(actor.allowed_regions as string[]).includes(input.region))
          throw new AppError(
            403,
            'REGION_RESTRICTED',
            'This region is not allowed by organization policy.',
          );
        if (input.region !== region)
          throw new AppError(
            409,
            'REGION_DEPLOYMENT_REQUIRED',
            'Create this workspace through a deployment and storage configured for the requested region.',
          );
        await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [workspace]);
        await tx.query(
          'INSERT INTO workspaces(id,name,organization_id,region) VALUES($1,$2,$3,$4)',
          [workspace, input.name, org, input.region],
        );
        const [account] = await tx.query('SELECT name FROM accounts WHERE id=$1', [
          session.account_id,
        ]);
        await tx.query(
          "INSERT INTO memberships(id,workspace_id,account_id,name,kind,role) VALUES($1,$2,$3,$4,'human','owner')",
          [member, workspace, session.account_id, account!.name],
        );
        await tx.query(
          "INSERT INTO conversations(id,workspace_id,name,visibility) VALUES($1,$2,'general','public')",
          [randomUUID(), workspace],
        );
        await organizationAudit(tx, org, session.account_id, 'workspace.created', workspace);
      }),
    );
    return reply.code(201).send({ id: workspace, membershipId: member });
  });
  app.get('/v1/organizations/:org/members', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params);
    return identityScope(async () => {
      await organizationActor(db, org, session.account_id, true);
      return db.query(
        'SELECT m.account_id,a.name,a.email,m.role,m.status,m.version FROM organization_members m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=$1 ORDER BY a.name,a.id',
        [org],
      );
    });
  });
  app.post('/v1/organizations/:org/members/:account/reactivate', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params),
      account = id.parse((req.params as { account: string }).account),
      input = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    await identityScope(() =>
      db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, session.account_id, true, true);
        const [member] = await tx.query(
          'SELECT role,status,version FROM organization_members WHERE organization_id=$1 AND account_id=$2 FOR UPDATE',
          [org, account],
        );
        if (!member) throw notFound();
        if (actor.role !== 'owner' && member.role !== 'member')
          throw new AppError(403, 'OWNER_REQUIRED', 'Only an owner can restore administrators.');
        if (member.version !== input.version)
          throw new AppError(409, 'VERSION_CONFLICT', 'Refresh organization members.');
        if (member.status !== 'suspended')
          throw new AppError(409, 'MEMBER_ACTIVE', 'This member is already active.');
        const [person] = await tx.query('SELECT email,disabled_at FROM accounts WHERE id=$1', [
          account,
        ]);
        if (!person || person.disabled_at)
          throw new AppError(409, 'ACCOUNT_UNAVAILABLE', 'The account is unavailable.');
        if (
          (actor.allowed_domains as string[]).length &&
          !(actor.allowed_domains as string[]).includes(String(person.email).split('@')[1]!)
        )
          throw new AppError(
            409,
            'DOMAIN_RESTRICTED',
            'The account must satisfy organization domain policy.',
          );
        await tx.query(
          "UPDATE organization_members SET status='active',scim_deleted_at=NULL,version=version+1 WHERE organization_id=$1 AND account_id=$2",
          [org, account],
        );
        await organizationAudit(tx, org, session.account_id, 'member.reactivated', account);
      }),
    );
    return { ok: true };
  });
  app.post('/v1/organizations/:org/members', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params),
      input = organizationMemberInput.parse(req.body);
    await identityScope(() =>
      db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, session.account_id, true, true);
        if (actor.role !== 'owner' && input.role === 'admin')
          throw new AppError(
            403,
            'OWNER_REQUIRED',
            'Only an owner can grant organization administrator access.',
          );
        const [existing] = await tx.query(
          "SELECT a.* FROM accounts a JOIN organization_members m ON m.account_id=a.id WHERE a.id=$1 AND m.organization_id=$2 AND m.status='active'",
          [input.accountId, org],
        );
        if (!existing)
          throw new AppError(
            400,
            'INVITATION_REQUIRED',
            'Invite this person to an organization workspace before assigning access.',
          );
        if (
          (actor.allowed_domains as string[]).length &&
          !(actor.allowed_domains as string[]).includes(String(existing.email).split('@')[1]!)
        )
          throw new AppError(
            403,
            'DOMAIN_RESTRICTED',
            'This member does not satisfy organization domain policy.',
          );
        const [target] = await tx.query(
          'SELECT role FROM organization_members WHERE organization_id=$1 AND account_id=$2',
          [org, input.accountId],
        );
        if (target?.role === 'owner' && input.role !== undefined)
          throw new AppError(
            409,
            'OWNERSHIP_TRANSFER_REQUIRED',
            'Use ownership transfer to change an owner.',
          );
        if (actor.role !== 'owner' && ['admin', 'owner'].includes(String(target?.role)))
          throw new AppError(
            403,
            'OWNER_REQUIRED',
            'Only an owner can manage organization administrators.',
          );
        await tx.query(
          'UPDATE organization_members SET role=$3,version=version+1 WHERE organization_id=$1 AND account_id=$2',
          [org, input.accountId, input.role ?? String(target!.role)],
        );
        for (const workspace of [...new Set(input.workspaceIds)].sort()) {
          const [valid] = await tx.query(
            'SELECT id FROM workspaces WHERE id=$1 AND organization_id=$2',
            [workspace, org],
          );
          if (!valid) throw notFound();
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [workspace]);
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace]);
          const [previous] = await tx.query(
            'SELECT id,status,access_type FROM memberships WHERE workspace_id=$1 AND account_id=$2',
            [workspace, input.accountId],
          );
          const [granted] = await tx.query(
            "INSERT INTO memberships(id,workspace_id,account_id,name,kind,role) VALUES($1,$2,$3,$4,'human','member') ON CONFLICT(workspace_id,account_id) DO UPDATE SET status='active',access_type='member',offboarded_at=NULL,provisioned=false,version=memberships.version+1 RETURNING id",
            [randomUUID(), workspace, input.accountId, existing.name],
          );
          if (previous && (previous.status !== 'active' || previous.access_type !== 'member'))
            await tx.query('DELETE FROM sessions WHERE workspace_id=$1 AND membership_id=$2', [
              workspace,
              previous.id,
            ]);
          await tx.query('SET LOCAL ROLE ao_runtime');
          await tx.query(
            "INSERT INTO outbox_events(workspace_id,event_type,resource_id) VALUES($1,'member.updated',$2)",
            [workspace, granted!.id],
          );
          await tx.query('SET LOCAL ROLE ao_identity');
        }
        await organizationAudit(
          tx,
          org,
          session.account_id,
          'member.access_updated',
          input.accountId,
        );
      }),
    );
    return { ok: true };
  });
  app.post('/v1/organizations/:org/transfer-ownership', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params),
      input = z
        .object({ accountId: id, version: z.number().int().positive() })
        .strict()
        .parse(req.body);
    await identityScope(() =>
      db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, session.account_id, true, true);
        if (actor.role !== 'owner')
          throw new AppError(403, 'OWNER_REQUIRED', 'Only an owner can transfer ownership.');
        if (actor.version !== input.version)
          throw new AppError(409, 'VERSION_CONFLICT', 'Refresh organization settings.');
        if (input.accountId === session.account_id)
          throw new AppError(400, 'INVALID_SUCCESSOR', 'Choose another member.');
        const [target] = await tx.query(
          "SELECT a.mfa_enabled,a.email FROM organization_members m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=$1 AND m.account_id=$2 AND m.status='active' AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL FOR SHARE OF a",
          [org, input.accountId],
        );
        if (!target) throw notFound();
        if (
          (actor.allowed_domains as string[]).length &&
          !(actor.allowed_domains as string[]).includes(String(target.email).split('@')[1]!)
        )
          throw new AppError(
            409,
            'OWNER_DOMAIN_REQUIRED',
            'The successor must satisfy organization domain policy.',
          );
        if (actor.require_mfa && !target.mfa_enabled)
          throw new AppError(409, 'MFA_SETUP_REQUIRED', 'The successor must enable MFA first.');
        if (actor.require_sso) {
          const [linked] = await tx.query(
            'SELECT f.account_id FROM federated_identities f JOIN identity_providers p ON p.id=f.provider_id WHERE p.organization_id=$1 AND f.account_id=$2 AND p.enabled',
            [org, input.accountId],
          );
          if (!linked)
            throw new AppError(
              409,
              'SSO_SETUP_REQUIRED',
              'The successor must link their SSO identity first.',
            );
        }
        await tx.query(
          "UPDATE organization_members SET role=CASE WHEN account_id=$2 THEN 'owner' ELSE 'admin' END,version=version+1 WHERE organization_id=$1 AND account_id IN ($2,$3)",
          [org, input.accountId, session.account_id],
        );
        await tx.query('UPDATE organizations SET version=version+1 WHERE id=$1', [org]);
        await organizationAudit(
          tx,
          org,
          session.account_id,
          'organization.ownership_transferred',
          input.accountId,
        );
      }),
    );
    return { ok: true };
  });
  app.post('/v1/organizations/:org/members/:account/offboard', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params),
      account = id.parse((req.params as { account: string }).account),
      input = z
        .object({ successorAccountId: id.optional(), version: z.number().int().positive() })
        .strict()
        .parse(req.body);
    await identityScope(() =>
      db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, session.account_id, true, true);
        const [target] = await tx.query(
          'SELECT * FROM organization_members WHERE organization_id=$1 AND account_id=$2 FOR UPDATE',
          [org, account],
        );
        if (!target) throw notFound();
        if (target.version !== input.version)
          throw new AppError(409, 'VERSION_CONFLICT', 'Refresh organization members.');
        if (target.role === 'owner')
          throw new AppError(
            409,
            'OWNERSHIP_TRANSFER_REQUIRED',
            'Transfer organization ownership before offboarding an owner.',
          );
        if (actor.role !== 'owner' && target.role === 'admin')
          throw new AppError(403, 'OWNER_REQUIRED', 'Only an owner can offboard an administrator.');
        if (input.successorAccountId === account)
          throw new AppError(400, 'INVALID_SUCCESSOR', 'Choose another successor.');
        const members = await tx.query(
          'SELECT m.id,m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE w.organization_id=$1 AND m.account_id=$2 ORDER BY m.workspace_id',
          [org, account],
        );
        for (const member of members) {
          const [successor] = input.successorAccountId
            ? await tx.query(
                "SELECT m.id FROM memberships m JOIN organization_members om ON om.account_id=m.account_id AND om.organization_id=$3 WHERE m.workspace_id=$1 AND m.account_id=$2 AND m.status='active' AND om.status='active'",
                [member.workspace_id, input.successorAccountId, org],
              )
            : [];
          await tx.query('SET LOCAL ROLE ao_runtime');
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [member.workspace_id]);
          await offboardWorkspace(
            tx,
            String(member.workspace_id),
            String(member.id),
            successor ? String(successor.id) : undefined,
          );
          await tx.query('SET LOCAL ROLE ao_identity');
          await tx.query(
            'UPDATE service_credentials SET revoked_at=now() WHERE workspace_id=$1 AND membership_id=$2',
            [member.workspace_id, member.id],
          );
        }
        await tx.query(
          "UPDATE organization_members SET status='suspended',version=version+1 WHERE organization_id=$1 AND account_id=$2",
          [org, account],
        );
        await tx.query(
          'DELETE FROM scim_group_members WHERE organization_id=$1 AND account_id=$2',
          [org, account],
        );
        await tx.query('DELETE FROM authentication_challenges WHERE account_id=$1', [account]);
        await tx.query('DELETE FROM federation_transactions WHERE account_id=$1', [account]);
        await tx.query(
          'DELETE FROM federated_identities WHERE account_id=$1 AND provider_id IN (SELECT id FROM identity_providers WHERE organization_id=$2)',
          [account, org],
        );
        await organizationAudit(tx, org, session.account_id, 'member.offboarded', account);
      }),
    );
    return { ok: true };
  });
  app.get('/v1/organizations/:org/domains', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params);
    return identityScope(async () => {
      await organizationActor(db, org, session.account_id, true);
      return db.query(
        'SELECT id,domain,verified_at,created_at FROM organization_domains WHERE organization_id=$1 ORDER BY domain',
        [org],
      );
    });
  });
  app.post('/v1/organizations/:org/domains', async (req, reply) => {
    const session = await currentSession(db, req),
      org = params(req.params),
      domain = organizationPolicyInput.shape.allowedDomains.element.parse(
        z.object({ domain: z.string() }).strict().parse(req.body).domain,
      ),
      value = 'orbit-domain-verification=' + token(),
      domainId = randomUUID();
    await identityScope(() =>
      db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, session.account_id, true, true);
        if (actor.role !== 'owner')
          throw new AppError(403, 'OWNER_REQUIRED', 'Only an owner can claim domains.');
        await tx.query(
          "DELETE FROM organization_domains WHERE verified_at IS NULL AND created_at<now()-interval '7 days'",
        );
        const [count] = await tx.query(
          'SELECT count(*)::int count FROM organization_domains WHERE organization_id=$1',
          [org],
        );
        if (Number(count?.count) >= 50)
          throw new AppError(
            409,
            'DOMAIN_LIMIT',
            'This organization has reached its domain limit.',
          );
        await tx.query(
          'INSERT INTO organization_domains(id,organization_id,domain,verification_hash) VALUES($1,$2,$3,$4)',
          [domainId, org, domain, digest(value)],
        );
        await organizationAudit(tx, org, session.account_id, 'domain.claimed', domain);
      }),
    );
    return reply
      .code(201)
      .send({ id: domainId, name: '_orbit-verification.' + domain, type: 'TXT', value });
  });
  app.post(
    '/v1/organizations/:org/domains/:domain/verify',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const session = await currentSession(db, req),
        org = params(req.params),
        domainId = id.parse((req.params as { domain: string }).domain);
      const domain = await identityScope(async () => {
        await organizationActor(db, org, session.account_id, true);
        const [row] = await db.query(
          'SELECT domain FROM organization_domains WHERE organization_id=$1 AND id=$2',
          [org, domainId],
        );
        if (!row) throw notFound();
        return String(row.domain);
      });
      let records: string[][] = [];
      try {
        records = await (options.resolveDomain ?? resolveTxt)('_orbit-verification.' + domain);
      } catch {
        throw new AppError(
          409,
          'DNS_PROOF_MISSING',
          'The verification TXT record is not available yet.',
        );
      }
      await identityScope(() =>
        db.transaction(async (tx) => {
          await organizationActor(tx, org, session.account_id, true, true);
          const [row] = await tx.query(
            'SELECT verification_hash FROM organization_domains WHERE organization_id=$1 AND id=$2 FOR UPDATE',
            [org, domainId],
          );
          if (!row || !records.some((r) => digest(r.join('')) === row.verification_hash))
            throw new AppError(
              409,
              'DNS_PROOF_MISSING',
              'The verification TXT record does not match.',
            );
          await tx.query('UPDATE organization_domains SET verified_at=now() WHERE id=$1', [
            domainId,
          ]);
          await organizationAudit(tx, org, session.account_id, 'domain.verified', domain);
        }),
      );
      return { ok: true };
    },
  );
  app.delete('/v1/organizations/:org/domains/:domain', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params),
      domainId = id.parse((req.params as { domain: string }).domain);
    await identityScope(() =>
      db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, session.account_id, true, true);
        if (actor.role !== 'owner')
          throw new AppError(403, 'OWNER_REQUIRED', 'Only an owner can remove domains.');
        const [domain] = await tx.query(
          'SELECT domain FROM organization_domains WHERE id=$1 AND organization_id=$2',
          [domainId, org],
        );
        if (!domain) throw notFound();
        if ((actor.allowed_domains as string[]).includes(String(domain.domain)))
          throw new AppError(
            409,
            'DOMAIN_IN_USE',
            'Remove this domain from the allowed domain policy first.',
          );
        await tx.query('DELETE FROM organization_domains WHERE id=$1', [domainId]);
        await organizationAudit(
          tx,
          org,
          session.account_id,
          'domain.removed',
          String(domain.domain),
        );
      }),
    );
    return { ok: true };
  });
  app.get('/v1/organizations/:org/audit', async (req) => {
    const session = await currentSession(db, req),
      org = params(req.params);
    return identityScope(async () => {
      await organizationActor(db, org, session.account_id, true);
      return db.query(
        'SELECT e.id,e.action,e.resource_id,e.created_at,e.credential_id,a.name actor_name FROM organization_audit e LEFT JOIN accounts a ON a.id=e.actor_id WHERE e.organization_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 200',
        [org],
      );
    });
  });
}
