import { randomBytes, randomUUID } from 'node:crypto';
import {
  identityScope,
  tenantScope,
  identifyPrincipal,
  scopedDatabase,
  type Database,
  type Sql,
} from '@ao/database';
import type { z } from 'zod';
import { sharedAccept, sharedInvite, type SharedPolicy } from '@ao/contracts/interoperability';
import { importActor } from './authority.js';
import { digest } from '../lib/security.js';
import { canonicalJson } from '../lib/canonical-json.js';
import { AppError, notFound } from '../lib/errors.js';
import { requireConversation, type Identity } from '../lib/policy.js';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
export class SharedChannelService {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = scopedDatabase(db);
  }
  async list(p: Identity) {
    return identityScope(() =>
      this.db.query(
        `SELECT g.id,g.workspace_id,g.conversation_id,c.name,h.name host_organization_name,o.name external_organization_name,g.organization_id,g.policy,g.state,g.version,g.accepted_at,g.expires_at FROM shared_channel_grants g JOIN conversations c ON c.workspace_id=g.workspace_id AND c.id=g.conversation_id JOIN organizations h ON h.id=g.host_organization_id JOIN organizations o ON o.id=g.organization_id WHERE (g.workspace_id=$1 AND EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=g.workspace_id AND cm.conversation_id=g.conversation_id AND cm.membership_id=$2)) OR EXISTS(SELECT 1 FROM shared_channel_participants p WHERE p.workspace_id=g.workspace_id AND p.grant_id=g.id AND p.source_workspace_id=$1 AND p.source_membership_id=$2) ORDER BY g.created_at DESC LIMIT 100`,
        [p.workspaceId, p.membershipId],
      ),
    );
  }
  async invite(p: Identity, input: z.infer<typeof sharedInvite>) {
    return identityScope(
      () =>
        this.db.transaction(async (tx) => {
          await importActor(tx, p);
          await requireConversation(tx, p, input.conversationId, true);
          const [channel] = await tx.query(
            'SELECT kind,visibility FROM conversations WHERE workspace_id=$1 AND id=$2',
            [p.workspaceId, input.conversationId],
          );
          if (channel?.kind !== 'channel' || channel.visibility !== 'private')
            throw new AppError(
              409,
              'PRIVATE_CHANNEL_REQUIRED',
              'Shared channels must be private channels with explicit participants.',
            );
          const [host] = await tx.query(
            'SELECT organization_id,region FROM workspaces WHERE id=$1',
            [p.workspaceId],
          );
          const [target] = await tx.query(
            'SELECT o.id,o.version,o.require_mfa,o.require_sso,o.allowed_regions,w.id workspace_id,w.region FROM organizations o JOIN workspaces w ON w.organization_id=o.id WHERE o.id=$1 ORDER BY w.id LIMIT 1',
            [input.organizationId],
          );
          if (!host || !target || target.id === host.organization_id)
            throw new AppError(
              400,
              'EXTERNAL_ORGANIZATION_REQUIRED',
              'Choose another organization.',
            );
          const hostOrg = await organizationActor(
            tx,
            String(host.organization_id),
            p.accountId!,
            true,
            true,
          );
          if (
            (hostOrg.require_mfa && !target.require_mfa) ||
            (hostOrg.require_sso && !target.require_sso) ||
            !(hostOrg.allowed_regions as string[]).includes(String(target.region)) ||
            !(target.allowed_regions as string[]).includes(String(host.region))
          )
            throw new AppError(
              409,
              'IDENTITY_POLICY_CONFLICT',
              'External organizations must meet the host authentication and region requirements.',
            );
          if (host.region !== target.region)
            throw new AppError(
              409,
              'REGIONAL_POLICY_CONFLICT',
              'Shared participants must use the same data region.',
            );
          const agreements = await tx.query(
            "SELECT policy FROM shared_channel_grants WHERE workspace_id=$1 AND conversation_id=$2 AND state<>'revoked' UNION ALL SELECT policy FROM shared_channel_policies WHERE workspace_id=$1 AND conversation_id=$2",
            [p.workspaceId, input.conversationId],
          );
          if (agreements.some((g) => canonicalJson(g.policy) !== canonicalJson(input.policy)))
            throw new AppError(
              409,
              'SHARED_POLICY_CONFLICT',
              'All participating organizations must agree to identical channel policies.',
            );
          const id = randomUUID(),
            token = randomBytes(32).toString('base64url');
          await tx.query(
            `INSERT INTO shared_channel_grants(id,workspace_id,conversation_id,host_organization_id,organization_id,source_workspace_id,invited_by,token_hash,expires_at,policy,host_policy_version,source_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9::int*interval '1 day',$10,$11,$12)`,
            [
              id,
              p.workspaceId,
              input.conversationId,
              host.organization_id,
              input.organizationId,
              target.workspace_id,
              p.membershipId,
              digest(token),
              input.expiresInDays,
              JSON.stringify(input.policy),
              hostOrg.version,
              target.version,
            ],
          );
          await organizationAudit(
            tx,
            String(host.organization_id),
            p.accountId!,
            'shared_channel.invited',
            id,
          );
          return { id, token };
        }),
      p.workspaceId,
    );
  }
  async preview(p: Identity, token: string) {
    return identityScope(
      () =>
        this.db.transaction(async (tx) => {
          const [g] = await tx.query(
            "SELECT g.id,g.organization_id,g.policy,g.expires_at,c.name,h.name host_organization_name FROM shared_channel_grants g JOIN conversations c ON c.workspace_id=g.workspace_id AND c.id=g.conversation_id JOIN organizations h ON h.id=g.host_organization_id WHERE g.token_hash=$1 AND g.state='invited' AND g.expires_at>now()",
            [digest(token)],
          );
          if (!g) throw notFound();
          await organizationActor(tx, String(g.organization_id), p.accountId!, true);
          return g;
        }),
      p.workspaceId,
    );
  }
  async accept(p: Identity, input: z.infer<typeof sharedAccept>) {
    return identityScope(
      () =>
        this.db.transaction(async (tx) => {
          const [g] = await tx.query(
            'SELECT * FROM shared_channel_grants WHERE token_hash=$1 FOR UPDATE',
            [digest(input.token)],
          );
          if (!g || g.state !== 'invited' || new Date(String(g.expires_at)) <= new Date())
            throw notFound();
          const org = await organizationActor(
            tx,
            String(g.organization_id),
            p.accountId!,
            true,
            true,
          );
          if (canonicalJson(g.policy) !== canonicalJson(input.policy))
            throw new AppError(
              409,
              'SHARED_POLICY_CONFLICT',
              'Accept the exact policy proposed by the host.',
            );
          if (org.version !== g.source_policy_version)
            throw new AppError(
              409,
              'POLICY_CHANGED',
              'Ask the host to issue a new invitation for your current organization policy.',
            );
          const [workspace] = await tx.query(
            'SELECT organization_id,region FROM workspaces WHERE id=$1',
            [p.workspaceId],
          );
          const [host] = await tx.query(
            'SELECT w.region,o.version FROM workspaces w JOIN organizations o ON o.id=w.organization_id WHERE w.id=$1',
            [g.workspace_id],
          );
          if (
            !workspace ||
            !host ||
            workspace.organization_id !== g.organization_id ||
            workspace.region !== host?.region ||
            host.version !== g.host_policy_version
          )
            throw new AppError(
              409,
              'POLICY_CHANGED',
              'Choose an authorized workspace in the agreed region and request current terms.',
            );
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [g.workspace_id]);
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [g.workspace_id]);
          await tx.query(
            'INSERT INTO shared_channel_policies(workspace_id,conversation_id,policy) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [g.workspace_id, g.conversation_id, JSON.stringify(input.policy)],
          );
          await this.replaceParticipants(tx, g, p.workspaceId, input.membershipIds);
          await tx.query(
            "UPDATE shared_channel_grants SET state='active',source_workspace_id=$3,accepted_by=$4,accepted_at=now(),version=version+1 WHERE workspace_id=$1 AND id=$2",
            [g.workspace_id, g.id, p.workspaceId, p.accountId],
          );
          await organizationAudit(
            tx,
            String(g.organization_id),
            p.accountId!,
            'shared_channel.accepted',
            String(g.id),
          );
          await this.invalidate(tx, String(g.workspace_id), String(g.conversation_id));
          return { id: g.id };
        }),
      p.workspaceId,
    );
  }
  private async replaceParticipants(
    tx: Sql,
    g: Record<string, unknown>,
    sourceWorkspace: string,
    members: string[],
  ) {
    if (new Set(members).size !== members.length)
      throw new AppError(400, 'DUPLICATE_PARTICIPANT', 'Choose each participant once.');
    const prior = await tx.query(
      'SELECT membership_id,source_membership_id FROM shared_channel_participants WHERE workspace_id=$1 AND grant_id=$2',
      [g.workspace_id, g.id],
    );
    for (const old of prior)
      if (!members.includes(String(old.source_membership_id))) {
        await tx.query(
          'DELETE FROM conversation_members WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3',
          [g.workspace_id, g.conversation_id, old.membership_id],
        );
        await tx.query(
          'DELETE FROM shared_channel_participants WHERE workspace_id=$1 AND grant_id=$2 AND membership_id=$3',
          [g.workspace_id, g.id, old.membership_id],
        );
      }
    const [channel] = await tx.query(
      'SELECT next_sequence FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [g.workspace_id, g.conversation_id],
    );
    for (const member of members) {
      const [source] = await tx.query(
        `SELECT m.*,a.auth_version FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN workspaces w ON w.id=m.workspace_id JOIN organization_members om ON om.organization_id=w.organization_id AND om.account_id=a.id WHERE m.workspace_id=$1 AND m.id=$2 AND w.organization_id=$3 AND m.status='active' AND m.access_type='member' AND m.kind='human' AND om.status='active' AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL`,
        [sourceWorkspace, member, g.organization_id],
      );
      if (!source)
        throw new AppError(
          400,
          'INVALID_PARTICIPANT',
          'Choose a verified active member of this organization workspace.',
        );
      const [existing] = await tx.query(
        'SELECT id,external_organization_id,status FROM memberships WHERE workspace_id=$1 AND account_id=$2',
        [g.workspace_id, source.account_id],
      );
      if (existing && existing.external_organization_id !== g.organization_id)
        throw new AppError(
          409,
          'LOCAL_IDENTITY_EXISTS',
          'This person already has a local host identity; manage its channel access directly.',
        );
      if (existing && existing.status !== 'active')
        throw new AppError(
          409,
          'HOST_ACCESS_REVOKED',
          'The host must restore this suspended external identity before participation can be renewed.',
        );
      const shadow = String(existing?.id ?? randomUUID());
      if (!existing)
        await tx.query(
          `INSERT INTO memberships(id,workspace_id,account_id,name,kind,role,access_type,external_organization_id,permissions) VALUES($1,$2,$3,$4,'human','member','guest',$5,'{"messages.read":true,"messages.write":true,"files.read":true,"files.write":true}')`,
          [shadow, g.workspace_id, source.account_id, source.name, g.organization_id],
        );
      else
        await tx.query(
          "UPDATE memberships SET status='active',version=version+1 WHERE workspace_id=$1 AND id=$2",
          [g.workspace_id, shadow],
        );
      await tx.query(
        'INSERT INTO shared_channel_participants(workspace_id,grant_id,membership_id,source_workspace_id,source_membership_id,source_auth_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,grant_id,membership_id) DO UPDATE SET source_auth_version=EXCLUDED.source_auth_version',
        [g.workspace_id, g.id, shadow, sourceWorkspace, member, source.auth_version],
      );
      await tx.query(
        'INSERT INTO conversation_members(workspace_id,conversation_id,membership_id,history_from_sequence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [
          g.workspace_id,
          g.conversation_id,
          shadow,
          (g.policy as SharedPolicy).history === 'retained'
            ? 0
            : Number(channel!.next_sequence) + 1,
        ],
      );
    }
  }
  async participantList(p: Identity, id: string) {
    return identityScope(
      () =>
        this.db.transaction(async (tx) => {
          const [g] = await tx.query('SELECT * FROM shared_channel_grants WHERE id=$1', [id]);
          if (!g) throw notFound();
          if (g.workspace_id === p.workspaceId)
            await requireConversation(tx, p, String(g.conversation_id));
          else await organizationActor(tx, String(g.organization_id), p.accountId!, true);
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [g.workspace_id]);
          return tx.query(
            'SELECT sp.source_membership_id,sp.source_workspace_id,m.name,external_channel_current(sp.workspace_id,sp.membership_id,g.conversation_id) current FROM shared_channel_participants sp JOIN shared_channel_grants g ON g.workspace_id=sp.workspace_id AND g.id=sp.grant_id JOIN memberships m ON m.workspace_id=sp.workspace_id AND m.id=sp.membership_id WHERE sp.workspace_id=$1 AND sp.grant_id=$2 ORDER BY m.name,sp.source_membership_id',
            [g.workspace_id, id],
          );
        }),
      p.workspaceId,
    );
  }
  async participants(p: Identity, id: string, members: string[], expected: number) {
    return identityScope(
      () =>
        this.db.transaction(async (tx) => {
          const [g] = await tx.query(
            "SELECT * FROM shared_channel_grants WHERE id=$1 AND state='active' FOR UPDATE",
            [id],
          );
          if (!g) throw notFound();
          await organizationActor(tx, String(g.organization_id), p.accountId!, true, true);
          if (g.source_workspace_id !== p.workspaceId) throw notFound();
          if (g.version !== expected)
            throw new AppError(409, 'VERSION_CONFLICT', 'Reload this shared channel.');
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [g.workspace_id]);
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [g.workspace_id]);
          await this.replaceParticipants(tx, g, p.workspaceId, members);
          await tx.query(
            'UPDATE shared_channel_grants SET version=version+1 WHERE workspace_id=$1 AND id=$2',
            [g.workspace_id, id],
          );
          await this.invalidate(tx, String(g.workspace_id), String(g.conversation_id));
          return { ok: true, version: expected + 1 };
        }),
      p.workspaceId,
    );
  }
  async revoke(p: Identity, id: string, expected: number) {
    return identityScope(
      () =>
        this.db.transaction(async (tx) => {
          const [g] = await tx.query('SELECT * FROM shared_channel_grants WHERE id=$1 FOR UPDATE', [
            id,
          ]);
          if (!g) throw notFound();
          const [w] = await tx.query('SELECT organization_id FROM workspaces WHERE id=$1', [
            p.workspaceId,
          ]);
          if (
            !w ||
            (w.organization_id !== g.host_organization_id &&
              w.organization_id !== g.organization_id)
          )
            throw notFound();
          await organizationActor(tx, String(w.organization_id), p.accountId!, true, true);
          if (g.version !== expected)
            throw new AppError(409, 'VERSION_CONFLICT', 'Reload this shared channel.');
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [g.workspace_id]);
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [g.workspace_id]);
          await tx.query(
            "UPDATE shared_channel_grants SET state='revoked',revoked_at=now(),version=version+1 WHERE workspace_id=$1 AND id=$2",
            [g.workspace_id, id],
          );
          await tx.query(
            'DELETE FROM conversation_members WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id IN (SELECT membership_id FROM shared_channel_participants WHERE workspace_id=$1 AND grant_id=$3)',
            [g.workspace_id, g.conversation_id, id],
          );
          await this.invalidate(tx, String(g.workspace_id), String(g.conversation_id));
          await organizationAudit(
            tx,
            String(w.organization_id),
            p.accountId!,
            'shared_channel.revoked',
            id,
          );
          return { ok: true };
        }),
      p.workspaceId,
    );
  }
  private async invalidate(tx: Sql, workspace: string, conversation: string) {
    await tx.query('UPDATE retrieval_authority SET epoch=epoch+1 WHERE workspace_id=$1', [
      workspace,
    ]);
    await tx.query('DELETE FROM retrieval_contexts WHERE workspace_id=$1', [workspace]);
    await tx.query(
      "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id) VALUES($1,'shared_channel.changed',$2,$2)",
      [workspace, conversation],
    );
  }
  async inChannel<T>(
    p: Identity,
    id: string,
    write: boolean,
    work: (guest: Identity, conversation: string, policy: SharedPolicy) => Promise<T>,
  ) {
    if (p.kind !== 'human' || p.accessType !== 'member' || p.platformCredentialId || p.credentialId)
      throw new AppError(
        403,
        'HUMAN_REQUIRED',
        'Shared channels require a browser account session.',
      );
    const grant = await identityScope(
      () =>
        this.db.transaction(async (tx) => {
          const [g] = await tx.query(
            `SELECT g.*,sp.membership_id,m.name FROM shared_channel_grants g JOIN shared_channel_participants sp ON sp.workspace_id=g.workspace_id AND sp.grant_id=g.id JOIN memberships m ON m.workspace_id=sp.workspace_id AND m.id=sp.membership_id WHERE g.id=$1 AND sp.source_workspace_id=$2 AND sp.source_membership_id=$3 AND g.state='active' AND m.status='active'`,
            [id, p.workspaceId, p.membershipId],
          );
          if (!g) throw notFound();
          await organizationActor(tx, String(g.organization_id), p.accountId!);
          await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [g.workspace_id]);
          const [valid] = await tx.query('SELECT external_channel_current($1,$2,$3) valid', [
            g.workspace_id,
            g.membership_id,
            g.conversation_id,
          ]);
          if (!valid?.valid) throw notFound();
          if (write && p.permissions?.['messages.write'] === false)
            throw new AppError(
              403,
              'PERMISSION_DENIED',
              'Your organization disabled message sending.',
            );
          return g;
        }),
      p.workspaceId,
    );
    const guest: Identity = {
      workspaceId: String(grant.workspace_id),
      membershipId: String(grant.membership_id),
      name: String(grant.name),
      role: 'member',
      kind: 'human',
      accountId: p.accountId!,
      accessType: 'guest',
    };
    return tenantScope(guest.workspaceId, async () => {
      identifyPrincipal(guest.membershipId, 'guest');
      return work(guest, String(grant.conversation_id), grant.policy as SharedPolicy);
    });
  }
}
