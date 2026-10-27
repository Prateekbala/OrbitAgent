import { identityScope, tenantScope, identifyPrincipal, type Database } from '@ao/database';
import type { FileDependencies } from '../files/config.js';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import { WorkspaceExport } from '../interoperability/exports.js';
import { textEntry, type ArchiveEntry } from '../interoperability/archive.js';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
export class OrganizationExport {
  constructor(
    private db: Database,
    private files?: FileDependencies,
  ) {}
  async authorize(org: string, account: string) {
    return identityScope(async () => {
      const organization = await organizationActor(this.db, org, account, true);
      const [policy] = await this.db.query(
        'SELECT policy FROM governance_policies WHERE organization_id=$1',
        [org],
      );
      if ((policy?.policy as { exports?: boolean } | undefined)?.exports === false)
        throw new AppError(403, 'EXPORT_DISABLED', 'Organization policy disables content exports.');
      return organization;
    });
  }
  async *entries(org: string, account: string): AsyncGenerator<ArchiveEntry> {
    const check = () => this.authorize(org, account);
    const organization = await check();
    const workspaces = await identityScope(() =>
      this.db.query(
        "SELECT w.id,w.name,m.id membership_id,m.name member_name,m.role,m.permissions,m.access_type,a.auth_version,o.version policy_version FROM workspaces w JOIN organizations o ON o.id=w.organization_id LEFT JOIN memberships m ON m.workspace_id=w.id AND m.account_id=$2 AND m.status='active' LEFT JOIN accounts a ON a.id=m.account_id WHERE w.organization_id=$1 ORDER BY w.id",
        [org, account],
      ),
    );
    await identityScope(() =>
      organizationAudit(this.db, org, account, 'governance.organization_export_started', org),
    );
    yield textEntry(
      'organization.json',
      JSON.stringify(
        { id: org, name: organization.name, exportedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    const included: string[] = [],
      omissions: { workspaceId: string; reason: string }[] = [];
    const exporter = new WorkspaceExport(this.db, this.files);
    for (const row of workspaces) {
      await check();
      if (
        !row.membership_id ||
        !['owner', 'admin'].includes(String(row.role)) ||
        row.access_type !== 'member'
      ) {
        omissions.push({
          workspaceId: String(row.id),
          reason: 'No current full workspace administrator membership.',
        });
        continue;
      }
      const p: Identity = {
        workspaceId: String(row.id),
        membershipId: String(row.membership_id),
        name: String(row.member_name),
        role: row.role as Identity['role'],
        kind: 'human',
        accessType: 'member',
        authVersion: Number(row.auth_version),
        policyVersion: Number(row.policy_version),
        permissions: row.permissions as NonNullable<Identity['permissions']>,
      };
      await tenantScope(p.workspaceId, async () => {
        identifyPrincipal(p.membershipId, 'member');
        await exporter.authorize(p);
      });
      for await (const entry of exporter.entries(p)) {
        await check();
        const body = entry.body;
        yield {
          ...entry,
          name: 'workspaces/' + p.workspaceId + '/' + entry.name,
          body: Buffer.isBuffer(body)
            ? body
            : (async function* () {
                for await (const chunk of body) {
                  await check();
                  yield chunk;
                }
              })(),
        };
      }
      included.push(p.workspaceId);
    }
    await check();
    yield textEntry(
      'manifest.json',
      JSON.stringify(
        {
          complete: true,
          included,
          omissions,
          excluded: [
            'credentials',
            'sessions',
            'private drafts and memories',
            'inaccessible conversations',
            'unapproved or historical knowledge',
            'provider copies',
            'billing invoices',
            'call recordings',
            'older file versions',
          ],
          consistency:
            'Live, access-checked export; workspace manifests report additional omissions.',
        },
        null,
        2,
      ),
    );
  }
}
