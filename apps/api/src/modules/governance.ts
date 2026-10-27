import { ByokService, modelKeyInput } from '../governance/byok.js';
import {
  OrganizationErasureService,
  organizationErasureInput,
} from '../governance/organization-erasure.js';
import type { FileDependencies } from '../files/config.js';
import { OrganizationExport } from '../governance/export.js';
import { archiveStream } from '../interoperability/archive.js';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import {
  governancePolicy,
  auditQuery,
  legalHoldInput,
  supportGrantInput,
} from '@ao/contracts/governance';
import { currentSession } from '../identity/security.js';
import { LifecycleService, erasureInput } from '../governance/lifecycle.js';
import { GovernanceService } from '../governance/service.js';
export function governanceRoutes(
  app: FastifyInstance,
  db: Database,
  files?: FileDependencies,
  byokPublicKey?: string,
) {
  const byok = new ByokService(db, byokPublicKey);
  app.get('/v1/organizations/:org/model-keys', async (req) =>
    byok.list(
      z.object({ org: z.uuid() }).parse(req.params).org,
      (await currentSession(db, req)).account_id,
    ),
  );
  app.put('/v1/organizations/:org/model-keys', async (req) =>
    byok.save(
      z.object({ org: z.uuid() }).parse(req.params).org,
      (await currentSession(db, req)).account_id,
      modelKeyInput.parse(req.body),
    ),
  );
  app.delete('/v1/organizations/:org/model-keys/:id', async (req) => {
    const p = z.object({ org: z.uuid(), id: z.uuid() }).parse(req.params);
    return byok.revoke(p.org, (await currentSession(db, req)).account_id, p.id);
  });
  const organizationErasure = new OrganizationErasureService(db);
  app.get('/v1/organizations/:org/erasure', async (req) =>
    organizationErasure.status(
      z.object({ org: z.uuid() }).parse(req.params).org,
      (await currentSession(db, req)).account_id,
    ),
  );
  app.post('/v1/organizations/:org/erasure', async (req) =>
    organizationErasure.request(
      z.object({ org: z.uuid() }).parse(req.params).org,
      (await currentSession(db, req)).account_id,
      organizationErasureInput.parse(req.body),
    ),
  );
  const exporter = new OrganizationExport(db, files);
  app.get('/v1/organizations/:org/export', async (req, reply) => {
    const organization = z.object({ org: z.uuid() }).parse(req.params).org;
    const account = (await currentSession(db, req)).account_id;
    await exporter.authorize(organization, account);
    return reply
      .type('application/x-tar')
      .header('content-disposition', 'attachment; filename="organization.tar"')
      .send(archiveStream(exporter.entries(organization, account)));
  });
  const lifecycle = new LifecycleService(db);
  const service = new GovernanceService(db),
    org = (v: unknown) => z.object({ org: z.uuid() }).passthrough().parse(v).org,
    params = (v: unknown) => z.object({ org: z.uuid(), id: z.uuid() }).parse(v);
  app.get('/v1/organizations/:org/governance', async (req) =>
    service.policy(org(req.params), (await currentSession(db, req)).account_id),
  );
  app.put('/v1/organizations/:org/governance', async (req) =>
    service.policy(
      org(req.params),
      (await currentSession(db, req)).account_id,
      governancePolicy.parse(req.body),
    ),
  );
  app.get('/v1/organizations/:org/governance/revisions', async (req) =>
    service.revisions(org(req.params), (await currentSession(db, req)).account_id),
  );
  app.get('/v1/organizations/:org/governance/audit', async (req) =>
    service.audit(
      org(req.params),
      (await currentSession(db, req)).account_id,
      auditQuery.parse(req.query),
    ),
  );
  app.get('/v1/organizations/:org/governance/audit/verify', async (req) =>
    service.verify(org(req.params), (await currentSession(db, req)).account_id),
  );
  app.get('/v1/organizations/:org/governance/audit/export', async (req, reply) => {
    const organization = org(req.params),
      account = (await currentSession(db, req)).account_id;
    const first = await service.audit(organization, account, { after: 0, limit: 200 });
    async function* lines() {
      yield JSON.stringify({ type: 'head', ...first.head }) + '\n';
      let page = first;
      while (true) {
        for (const row of page.items) yield JSON.stringify(row) + '\n';
        if (!page.next) break;
        page = await service.audit(
          organization,
          account,
          { after: Number(page.next), limit: 200 },
          String(first.head.sequence),
        );
      }
      yield JSON.stringify({ type: 'complete' }) + '\n';
    }
    return reply
      .header('content-disposition', 'attachment; filename="security-audit.ndjson"')
      .type('application/x-ndjson')
      .send(Readable.from(lines()));
  });
  app.get('/v1/organizations/:org/governance/holds', async (req) =>
    service.holds(org(req.params), (await currentSession(db, req)).account_id),
  );
  app.post('/v1/organizations/:org/governance/holds', async (req) =>
    service.hold(
      org(req.params),
      (await currentSession(db, req)).account_id,
      legalHoldInput.parse(req.body),
    ),
  );
  app.delete('/v1/organizations/:org/governance/holds/:id', async (req) => {
    const p = params(req.params);
    return service.releaseHold(
      p.org,
      (await currentSession(db, req)).account_id,
      p.id,
      z.object({ reason: z.string().trim().min(20).max(1000) }).parse(req.body).reason,
    );
  });
  app.get('/v1/organizations/:org/governance/support', async (req) =>
    service.grants(org(req.params), (await currentSession(db, req)).account_id),
  );
  app.post('/v1/organizations/:org/governance/support', async (req) =>
    service.grant(
      org(req.params),
      (await currentSession(db, req)).account_id,
      supportGrantInput.parse(req.body),
    ),
  );
  app.delete('/v1/organizations/:org/governance/support/:id', async (req) => {
    const p = params(req.params);
    return service.revokeGrant(p.org, (await currentSession(db, req)).account_id, p.id);
  });
  app.get('/v1/organizations/:org/governance/erasures', async (req) =>
    lifecycle.list(org(req.params), (await currentSession(db, req)).account_id),
  );
  app.post('/v1/organizations/:org/governance/erasures', async (req) =>
    lifecycle.request(
      org(req.params),
      (await currentSession(db, req)).account_id,
      erasureInput.parse(req.body),
    ),
  );
  app.get('/v1/support/:id/diagnostics', async (req) => {
    const session = await currentSession(db, req);
    return service.diagnostics(
      session.account_id,
      Boolean(session.mfa_verified_at),
      z.object({ id: z.uuid() }).parse(req.params).id,
    );
  });
}
