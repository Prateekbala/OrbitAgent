import { createHash } from 'node:crypto';
import { identityScope, type Database, type Sql } from '@ao/database';
import {
  governancePolicy,
  defaultGovernancePolicy,
  type auditQuery,
  type legalHoldInput,
  type supportGrantInput,
} from '@ao/contracts/governance';
import type { z } from 'zod';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import { AppError, notFound } from '../lib/errors.js';
export class GovernanceService {
  constructor(private readonly db: Database) {}
  async policy(org: string, account: string, input?: z.infer<typeof governancePolicy>) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, account, true, Boolean(input));
        const [row] = await tx.query(
          'SELECT version,policy FROM governance_policies WHERE organization_id=$1',
          [org],
        );
        const before = governancePolicy.parse(row?.policy ?? defaultGovernancePolicy);
        if (!input) return before;
        if (actor.role !== 'owner')
          throw new AppError(
            403,
            'OWNER_REQUIRED',
            'An organization owner must change governance policies.',
          );
        if (before.version !== input.version)
          throw new AppError(
            409,
            'VERSION_CONFLICT',
            'Refresh the governance policy before saving.',
          );
        await tx.query('SELECT id FROM lock_governance_workspaces($1)', [org]);
        const next = { ...input, version: before.version + 1 };
        await tx.query(
          'INSERT INTO governance_policies(organization_id,version,policy,updated_by) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(organization_id) DO UPDATE SET version=EXCLUDED.version,policy=EXCLUDED.policy,updated_by=EXCLUDED.updated_by,updated_at=now()',
          [org, next.version, JSON.stringify(next), account],
        );
        await tx.query(
          'INSERT INTO governance_revisions(organization_id,version,policy,actor_id) VALUES($1,$2,$3::jsonb,$4)',
          [org, next.version, JSON.stringify(next), account],
        );
        await tx.query('UPDATE organizations SET version=version+1 WHERE id=$1', [org]);
        await organizationAudit(
          tx,
          org,
          account,
          'governance.policy_changed',
          String(next.version),
        );
        return next;
      }),
    );
  }
  async revisions(org: string, account: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, account, true);
      return this.db.query(
        'SELECT version,policy,actor_id,created_at FROM governance_revisions WHERE organization_id=$1 ORDER BY version DESC LIMIT 100',
        [org],
      );
    });
  }
  async audit(org: string, account: string, input: z.infer<typeof auditQuery>, through?: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, account, true);
      const [head] = await this.db.query(
        'SELECT sequence::text,hash FROM security_audit_heads WHERE organization_id=$1',
        [org],
      );
      const rows = await this.db.query(
        "SELECT sequence::text,previous_hash,content_hash,hash,source,source_id,workspace_id,actor_id,action,CASE WHEN workspace_id IS NULL OR audit_resource_disclosable(workspace_id,conversation_id,audience_id,occurred_at,$5) THEN resource_id END resource_id,occurred_at FROM security_audit WHERE organization_id=$1 AND sequence>$2 AND ($3::text IS NULL OR action ILIKE '%'||$3||'%') AND ($4::uuid IS NULL OR workspace_id=$4) AND ($7::bigint IS NULL OR sequence<=$7) ORDER BY sequence LIMIT $6",
        [
          org,
          input.after,
          input.action ?? null,
          input.workspaceId ?? null,
          account,
          input.limit + 1,
          through ?? String(head?.sequence ?? '0'),
        ],
      );
      await organizationActor(this.db, org, account, true);
      return {
        head: head ?? { sequence: '0', hash: '0'.repeat(64) },
        items: rows.slice(0, input.limit),
        next: rows.length > input.limit ? rows[input.limit - 1]!.sequence : null,
      };
    });
  }
  async verify(org: string, account: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, account, true);
      const [head] = await this.db.query(
        'SELECT sequence::text,hash FROM security_audit_heads WHERE organization_id=$1',
        [org],
      );
      let sequence = 0n,
        previous = '0'.repeat(64);
      while (sequence < BigInt(String(head?.sequence ?? 0))) {
        const rows = await this.db.query(
          "SELECT sequence::text,previous_hash,content_hash,hash,content_hash=encode(sha256(convert_to(payload::text,'UTF8')),'hex') content_valid FROM security_audit WHERE organization_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence LIMIT 200",
          [org, sequence.toString(), head!.sequence],
        );
        if (!rows.length) return { valid: false, through: sequence.toString() };
        for (const row of rows) {
          sequence++;
          const hash = createHash('sha256')
            .update(previous + String(row.content_hash) + sequence.toString() + org)
            .digest('hex');
          if (
            String(row.sequence) !== sequence.toString() ||
            row.previous_hash !== previous ||
            row.hash !== hash ||
            !row.content_valid
          )
            return { valid: false, through: (sequence - 1n).toString() };
          previous = String(row.hash);
        }
        await organizationActor(this.db, org, account, true);
      }
      return {
        valid: previous === (head?.hash ?? previous),
        through: sequence.toString(),
        hash: previous,
        anchorRequired: true,
      };
    });
  }
  async holds(org: string, account: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, account, true);
      return this.db.query(
        'SELECT * FROM legal_holds WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200',
        [org],
      );
    });
  }
  async hold(org: string, account: string, input: z.infer<typeof legalHoldInput>) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        await organizationActor(tx, org, account, true, true);
        const [workspace] = await tx.query('SELECT id FROM lock_governance_workspaces($1,$2)', [
          org,
          input.workspaceId,
        ]);
        if (!workspace) throw notFound();
        const [check] = await tx.query('SELECT legal_hold_available($1,$2,$3) allowed', [
          org,
          input.workspaceId,
          input.conversationId,
        ]);
        if (!check?.allowed)
          throw new AppError(
            409,
            'PURGE_IN_PROGRESS',
            'A previously started purge must settle before this scope can be held.',
          );
        const [row] = await tx.query(
          'INSERT INTO legal_holds(organization_id,workspace_id,conversation_id,reason,reference,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [org, input.workspaceId, input.conversationId, input.reason, input.reference, account],
        );
        await organizationAudit(tx, org, account, 'governance.hold_created', String(row!.id));
        return row;
      }),
    );
  }
  async releaseHold(org: string, account: string, id: string, reason: string) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, account, true, true);
        if (actor.role !== 'owner')
          throw new AppError(403, 'OWNER_REQUIRED', 'An owner must release legal holds.');
        await tx.query('SELECT id FROM lock_governance_workspaces($1)', [org]);
        const [row] = await tx.query(
          'UPDATE legal_holds SET released_at=now(),released_by=$3,release_reason=$4 WHERE organization_id=$1 AND id=$2 AND released_at IS NULL RETURNING id',
          [org, id, account, reason],
        );
        if (!row) throw notFound();
        await organizationAudit(tx, org, account, 'governance.hold_released', id);
        return { ok: true };
      }),
    );
  }
  async grants(org: string, account: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, account, true);
      return this.db.query(
        'SELECT * FROM support_grants WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100',
        [org],
      );
    });
  }
  async grant(org: string, account: string, input: z.infer<typeof supportGrantInput>) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, account, true, true),
          policy = await this.readPolicy(tx, org);
        if (actor.role !== 'owner' || !policy.supportAccess)
          throw new AppError(
            403,
            'SUPPORT_ACCESS_DISABLED',
            'An owner must explicitly enable and approve support access.',
          );
        const [target] = await tx.query(
          'SELECT id FROM accounts WHERE id=$1 AND email_verified_at IS NOT NULL AND disabled_at IS NULL',
          [input.accountId],
        );
        if (!target || input.accountId === account)
          throw new AppError(
            400,
            'INVALID_SUPPORT_ACCOUNT',
            'Choose another verified support account.',
          );
        const workspaces = await tx.query(
          'SELECT id FROM workspaces WHERE organization_id=$1 AND id=ANY($2::uuid[])',
          [org, input.workspaceIds],
        );
        if (workspaces.length !== new Set(input.workspaceIds).size) throw notFound();
        const [row] = await tx.query(
          'INSERT INTO support_grants(organization_id,account_id,approved_by,workspace_ids,purpose,ticket,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+$7::interval) RETURNING id,expires_at',
          [
            org,
            input.accountId,
            account,
            [...new Set(input.workspaceIds)],
            input.purpose,
            input.ticket,
            input.minutes + ' minutes',
          ],
        );
        await organizationAudit(tx, org, account, 'support.granted', String(row!.id));
        return row;
      }),
    );
  }
  async revokeGrant(org: string, account: string, id: string) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        await organizationActor(tx, org, account, true, true);
        const [row] = await tx.query(
          'UPDATE support_grants SET revoked_at=now() WHERE organization_id=$1 AND id=$2 RETURNING id',
          [org, id],
        );
        if (!row) throw notFound();
        await organizationAudit(tx, org, account, 'support.revoked', id);
        return { ok: true };
      }),
    );
  }
  async diagnostics(account: string, mfa: boolean, id: string) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        if (!mfa)
          throw new AppError(
            403,
            'MFA_REQUIRED',
            'Support diagnostics require a verified MFA session.',
          );
        const [grant] = await tx.query(
          "SELECT g.* FROM support_grants g JOIN organization_members approver ON approver.organization_id=g.organization_id AND approver.account_id=g.approved_by AND approver.status='active' AND approver.role='owner' WHERE g.id=$1 AND g.account_id=$2 AND g.expires_at>now() AND g.revoked_at IS NULL FOR SHARE OF g",
          [id, account],
        );
        if (!grant || !(await this.readPolicy(tx, String(grant.organization_id))).supportAccess)
          throw notFound();
        const [row] = await tx.query('SELECT support_diagnostics($1,$2) data', [
          grant.organization_id,
          grant.workspace_ids,
        ]);
        await organizationAudit(
          tx,
          String(grant.organization_id),
          account,
          'support.diagnostics_read',
          id,
        );
        return {
          purpose: grant.purpose,
          ticket: grant.ticket,
          expiresAt: grant.expires_at,
          workspaces: row!.data,
        };
      }),
    );
  }
  private async readPolicy(tx: Sql, org: string) {
    const [row] = await tx.query(
      'SELECT policy FROM governance_policies WHERE organization_id=$1',
      [org],
    );
    return governancePolicy.parse(row?.policy ?? defaultGovernancePolicy);
  }
}
