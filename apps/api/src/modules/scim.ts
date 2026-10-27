import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { identityScope, type Database, type Sql } from '@ao/database';
import { z, ZodError } from 'zod';
import { id, credentialInput } from '@ao/contracts';
import { AppError, notFound } from '../lib/errors.js';
import { digest, hashPassword, token } from '../lib/security.js';
import { currentSession } from '../identity/security.js';
import { requireOrganizationEntitlement } from '../billing/entitlements.js';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import {
  scimUserSchema,
  scimGroupSchema,
  workspaceExtension,
  scimUserInput,
  scimGroupInput,
  scimPatch,
  scimQuery,
  scimFilter,
  userResource,
  getScimUser,
  writeScimUser,
  groupResource,
  writeScimGroup,
  applyScimPatch,
} from '../identity/scim.js';
const errorSchema = 'urn:ietf:params:scim:api:messages:2.0:Error';
export function scimRoutes(app: FastifyInstance, db: Database, origin: string) {
  const orgParam = (value: unknown) => z.object({ org: id }).passthrough().parse(value).org;
  app.get('/v1/organizations/:org/scim/groups', async (req) => {
    const session = await currentSession(db, req),
      org = orgParam(req.params);
    return identityScope(async () => {
      await organizationActor(db, org, session.account_id, true);
      return db.query(
        'SELECT id,display_name,workspace_id,version FROM scim_groups WHERE organization_id=$1 ORDER BY display_name,id',
        [org],
      );
    });
  });
  app.put('/v1/organizations/:org/scim/groups/:group', async (req) => {
    const session = await currentSession(db, req),
      org = orgParam(req.params),
      group = id.parse((req.params as { group: string }).group),
      input = z
        .object({ workspaceId: id.nullable(), version: z.number().int().positive() })
        .strict()
        .parse(req.body);
    await identityScope(() =>
      db.transaction(async (tx) => {
        await organizationActor(tx, org, session.account_id, true, true);
        const [row] = await tx.query(
          'SELECT * FROM scim_groups WHERE organization_id=$1 AND id=$2 FOR UPDATE',
          [org, group],
        );
        if (!row) throw notFound();
        if (row.version !== input.version)
          throw new AppError(409, 'VERSION_CONFLICT', 'The provisioning group changed.');
        const existing = await groupResource(tx, row, `${origin}/api/scim/v2/${org}`);
        await writeScimGroup(
          tx,
          org,
          group,
          scimGroupInput.parse({
            ...existing,
            [workspaceExtension]: { workspaceId: input.workspaceId },
          }),
        );
        await organizationAudit(tx, org, session.account_id, 'scim.group_mapping_updated', group);
      }),
    );
    return { ok: true };
  });
  for (const method of ['GET', 'POST', 'DELETE'] as const)
    app.route({
      method,
      url: `/v1/organizations/:org/scim/tokens${method === 'DELETE' ? '/:credential' : ''}`,
      handler: async (req, reply) => {
        const session = await currentSession(db, req),
          org = orgParam(req.params);
        return identityScope(() =>
          db.transaction(async (tx) => {
            const actor = await organizationActor(tx, org, session.account_id, true, true);
            if (actor.role !== 'owner')
              throw new AppError(
                403,
                'OWNER_REQUIRED',
                'Only an owner can manage provisioning credentials.',
              );
            if (method === 'GET')
              return tx.query(
                'SELECT id,label,expires_at,revoked_at,created_at FROM scim_credentials WHERE organization_id=$1 ORDER BY created_at DESC',
                [org],
              );
            if (method === 'DELETE') {
              const credential = id.parse((req.params as { credential: string }).credential);
              const [row] = await tx.query(
                'UPDATE scim_credentials SET revoked_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id',
                [credential, org],
              );
              if (!row) throw notFound();
              await organizationAudit(
                tx,
                org,
                session.account_id,
                'scim.token_revoked',
                credential,
              );
              return { ok: true };
            }
            await requireOrganizationEntitlement(tx, org, 'scim');
            const input = credentialInput.parse(req.body),
              value = token(),
              credential = randomUUID();
            await tx.query(
              'INSERT INTO scim_credentials(id,organization_id,token_hash,label,expires_at,created_by) VALUES($1,$2,$3,$4,now()+$5::interval,$6)',
              [
                credential,
                org,
                digest(value),
                input.label,
                `${input.expiresInDays} days`,
                session.account_id,
              ],
            );
            await organizationAudit(tx, org, session.account_id, 'scim.token_created', credential);
            reply.code(201);
            return { id: credential, token: value, baseUrl: `${origin}/api/scim/v2/${org}` };
          }),
        );
      },
    });
  void app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/scim+json',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, JSON.parse(String(body)));
        } catch {
          done(new AppError(400, 'invalidSyntax', 'Invalid SCIM JSON.'));
        }
      },
    );
    scoped.setErrorHandler((error, _req, reply) => {
      const dbCode = (error as { code?: string }).code;
      const status =
        error instanceof AppError
          ? error.status
          : error instanceof ZodError
            ? 400
            : dbCode === '23505'
              ? 409
              : 500;
      const type =
        error instanceof AppError
          ? error.code
          : error instanceof ZodError
            ? 'invalidValue'
            : dbCode === '23505'
              ? 'uniqueness'
              : undefined;
      return reply
        .code(status)
        .type('application/scim+json')
        .send({
          schemas: [errorSchema],
          status: String(status),
          ...(type ? { scimType: type } : {}),
          detail:
            error instanceof AppError
              ? error.message
              : error instanceof ZodError
                ? 'Invalid SCIM resource.'
                : dbCode === '23505'
                  ? 'This SCIM resource already exists.'
                  : 'The provisioning request could not be completed.',
        });
    });
    const base = (org: string) => `${origin}/api/scim/v2/${org}`;
    async function authorized<T>(req: FastifyRequest, work: (tx: Sql, org: string) => Promise<T>) {
      const org = orgParam(req.params),
        bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!bearer) throw new AppError(401, 'invalidToken', 'A SCIM bearer token is required.');
      return identityScope(() =>
        db.transaction(async (tx) => {
          const [organization] = await tx.query(
            'SELECT id,allowed_domains FROM organizations WHERE id=$1 FOR UPDATE',
            [org],
          );
          if (!organization)
            throw new AppError(401, 'invalidToken', 'Invalid provisioning credential.');
          const [credential] = await tx.query(
            'SELECT id FROM scim_credentials WHERE organization_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',
            [org, digest(bearer)],
          );
          if (!credential)
            throw new AppError(401, 'invalidToken', 'Invalid or expired provisioning credential.');
          await tx.query("SELECT set_config('ao.scim_credential_id',$1,true)", [credential.id]);
          return work(tx, org);
        }),
      );
    }
    const send = (reply: FastifyReply, result: unknown) =>
      reply.type('application/scim+json').send(result);
    scoped.get('/scim/v2/:org/ServiceProviderConfig', async (req, reply) =>
      send(
        reply,
        await authorized(req, async () => ({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
          patch: { supported: true },
          bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
          filter: { supported: true, maxResults: 200 },
          changePassword: { supported: false },
          sort: { supported: false },
          etag: { supported: true },
          authenticationSchemes: [
            {
              type: 'oauthbearertoken',
              name: 'Organization provisioning token',
              description: 'Expiring, revocable organization bearer token',
              primary: true,
            },
          ],
        })),
      ),
    );
    const resourceTypes = [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        schema: scimUserSchema,
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        schema: scimGroupSchema,
        schemaExtensions: [{ schema: workspaceExtension, required: false }],
      },
    ];
    scoped.get('/scim/v2/:org/ResourceTypes', async (req, reply) =>
      send(
        reply,
        await authorized(req, async () => ({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
          totalResults: 2,
          startIndex: 1,
          itemsPerPage: 2,
          Resources: resourceTypes,
        })),
      ),
    );
    scoped.get('/scim/v2/:org/ResourceTypes/:type', async (req, reply) =>
      send(
        reply,
        await authorized(req, async () => {
          const result = resourceTypes.find((r) => r.id === (req.params as { type: string }).type);
          if (!result) throw notFound();
          return result;
        }),
      ),
    );
    const attribute = (name: string, type: string, required = false, multiValued = false) => ({
      name,
      type,
      required,
      multiValued,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'none',
    });
    const schemas = [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
        id: scimUserSchema,
        name: 'User',
        description: 'Organization user access',
        attributes: [
          attribute('userName', 'string', true),
          attribute('externalId', 'string'),
          attribute('displayName', 'string'),
          attribute('active', 'boolean'),
          {
            ...attribute('name', 'complex'),
            subAttributes: [
              attribute('formatted', 'string'),
              attribute('givenName', 'string'),
              attribute('familyName', 'string'),
            ],
          },
          {
            ...attribute('emails', 'complex', false, true),
            subAttributes: [
              attribute('value', 'string'),
              attribute('primary', 'boolean'),
              attribute('type', 'string'),
            ],
          },
        ],
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
        id: scimGroupSchema,
        name: 'Group',
        description: 'Provisioning groups',
        attributes: [
          attribute('displayName', 'string', true),
          attribute('externalId', 'string'),
          {
            ...attribute('members', 'complex', false, true),
            subAttributes: [attribute('value', 'string', true)],
          },
        ],
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
        id: workspaceExtension,
        name: 'Workspace',
        description: 'Map a group to one organization workspace',
        attributes: [attribute('workspaceId', 'string')],
      },
    ];
    scoped.get('/scim/v2/:org/Schemas', async (req, reply) =>
      send(
        reply,
        await authorized(req, async () => ({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
          totalResults: schemas.length,
          startIndex: 1,
          itemsPerPage: schemas.length,
          Resources: schemas,
        })),
      ),
    );
    scoped.get('/scim/v2/:org/Schemas/:schema', async (req, reply) =>
      send(
        reply,
        await authorized(req, async () => {
          const result = schemas.find((r) => r.id === (req.params as { schema: string }).schema);
          if (!result) throw notFound();
          return result;
        }),
      ),
    );
    function projectAttributes(
      resource: Record<string, unknown>,
      query: z.infer<typeof scimQuery>,
    ) {
      const fields = query.attributes?.split(',').map((v) => v.trim());
      const exclude = query.excludedAttributes?.split(',').map((v) => v.trim()) ?? [];
      return Object.fromEntries(
        Object.entries(resource).filter(
          ([key]) =>
            ['id', 'schemas', 'meta'].includes(key) ||
            ((!fields || fields.includes(key)) && !exclude.includes(key)),
        ),
      );
    }
    for (const kind of ['User', 'Group'] as const) {
      const path = `/scim/v2/:org/${kind}s`;
      scoped.get(path, async (req, reply) => {
        const query = scimQuery.parse(req.query),
          filter = scimFilter(query.filter, kind);
        return send(
          reply,
          await authorized(req, async (tx, org) => {
            const columns =
              kind === 'User'
                ? {
                    username: 'a.email',
                    id: 'm.account_id',
                    externalid: 'm.external_id',
                    displayname: 'coalesce(m.display_name,a.name)',
                  }
                : {
                    id: 'g.id',
                    externalid: 'g.external_id',
                    displayname: 'g.display_name',
                    username: 'g.display_name',
                  };
            const from =
                kind === 'User'
                  ? 'organization_members m JOIN accounts a ON a.id=m.account_id'
                  : 'scim_groups g',
              alias = kind === 'User' ? 'm' : 'g';
            const values: unknown[] = [org];
            let where = `${alias}.organization_id=$1`;
            if (kind === 'User') where += ' AND m.scim_deleted_at IS NULL';
            if (filter) {
              values.push(filter.value);
              where += ` AND lower(${columns[filter.attr as keyof typeof columns]}::text)=lower($2)`;
            }
            const [total] = await tx.query(
              `SELECT count(*)::int count FROM ${from} WHERE ${where}`,
              values,
            );
            values.push(query.count, query.startIndex - 1);
            const rows = await tx.query(
              `SELECT ${alias}.*${kind === 'User' ? ',a.email,a.name' : ''} FROM ${from} WHERE ${where} ORDER BY ${kind === 'User' ? 'm.account_id' : 'g.id'} LIMIT $${values.length - 1} OFFSET $${values.length}`,
              values,
            );
            const resources = await Promise.all(
              rows.map(async (row) =>
                projectAttributes(
                  kind === 'User'
                    ? userResource(row, base(org))
                    : await groupResource(tx, row, base(org)),
                  query,
                ),
              ),
            );
            return {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
              totalResults: Number(total?.count),
              startIndex: query.startIndex,
              itemsPerPage: resources.length,
              Resources: resources,
            };
          }),
        );
      });
      async function get(tx: Sql, org: string, resourceId: string) {
        if (kind === 'User') return getScimUser(tx, org, resourceId);
        const [group] = await tx.query(
          'SELECT * FROM scim_groups WHERE organization_id=$1 AND id=$2',
          [org, resourceId],
        );
        if (!group) throw notFound();
        return group;
      }
      const resource = (tx: Sql, org: string, row: Record<string, unknown>) =>
        kind === 'User'
          ? Promise.resolve(userResource(row, base(org)))
          : groupResource(tx, row, base(org));
      scoped.get(path + '/:resource', async (req, reply) => {
        const result = await authorized(req, async (tx, org) =>
          resource(
            tx,
            org,
            await get(tx, org, id.parse((req.params as { resource: string }).resource)),
          ),
        );
        reply.header('etag', result.meta.version);
        return send(reply, result);
      });
      scoped.post(path, async (req, reply) => {
        const password = kind === 'User' ? await hashPassword(token()) : null;
        const result = await authorized(req, async (tx, org) => {
          if (kind === 'User') {
            const input = scimUserInput.parse(req.body);
            const [organization] = await tx.query(
              'SELECT allowed_domains FROM organizations WHERE id=$1',
              [org],
            );
            if (
              (organization!.allowed_domains as string[]).length &&
              !(organization!.allowed_domains as string[]).includes(input.userName.split('@')[1]!)
            )
              throw new AppError(
                400,
                'invalidValue',
                'This userName does not satisfy organization domain policy.',
              );
            let [account] = await tx.query('SELECT id FROM accounts WHERE email=$1', [
              input.userName,
            ]);
            if (!account) {
              account = { id: randomUUID() };
              await tx.query(
                'INSERT INTO accounts(id,email,name,password_hash,managed_organization_id) VALUES($1,$2,$3,$4,$5)',
                [
                  account.id,
                  input.userName,
                  input.displayName ?? input.userName.split('@')[0],
                  password,
                  org,
                ],
              );
            }
            const [existing] = await tx.query(
              'SELECT account_id,scim_deleted_at FROM organization_members WHERE organization_id=$1 AND account_id=$2',
              [org, account.id],
            );
            if (existing && !existing.scim_deleted_at)
              throw new AppError(
                409,
                'uniqueness',
                'This user already belongs to the organization.',
              );
            await tx.query(
              "INSERT INTO organization_members(organization_id,account_id,provisioned) VALUES($1,$2,true) ON CONFLICT(organization_id,account_id) DO UPDATE SET scim_deleted_at=NULL,status='active',version=organization_members.version+1",
              [org, account.id],
            );
            await writeScimUser(
              tx,
              org,
              String(account.id),
              input,
              await getScimUser(tx, org, String(account.id)),
            );
            return resource(tx, org, await getScimUser(tx, org, String(account.id)));
          }
          const input = scimGroupInput.parse(req.body),
            group = randomUUID();
          await tx.query(
            'INSERT INTO scim_groups(id,organization_id,display_name) VALUES($1,$2,$3)',
            [group, org, input.displayName],
          );
          await writeScimGroup(tx, org, group, input);
          return resource(tx, org, await get(tx, org, group));
        });
        reply
          .code(201)
          .header('location', result.meta.location)
          .header('etag', result.meta.version);
        return send(reply, result);
      });
      for (const method of ['PUT', 'PATCH', 'DELETE'] as const)
        scoped.route({
          method,
          url: path + '/:resource',
          handler: async (req, reply) => {
            const result = await authorized(req, async (tx, org) => {
              const resourceId = id.parse((req.params as { resource: string }).resource),
                row = await get(tx, org, resourceId),
                existing = await resource(tx, org, row);
              const expected = req.headers['if-match'];
              if (expected && expected !== existing.meta.version && expected !== '*')
                throw new AppError(412, 'VERSION_CONFLICT', 'The SCIM resource changed.');
              if (method === 'DELETE') {
                if (kind === 'User') {
                  await writeScimUser(
                    tx,
                    org,
                    resourceId,
                    scimUserInput.parse({ ...existing, active: false }),
                    row,
                  );
                  await tx.query(
                    'UPDATE organization_members SET scim_deleted_at=now() WHERE organization_id=$1 AND account_id=$2',
                    [org, resourceId],
                  );
                } else {
                  await writeScimGroup(
                    tx,
                    org,
                    resourceId,
                    scimGroupInput.parse({ ...existing, members: [] }),
                  );
                  await tx.query('DELETE FROM scim_groups WHERE id=$1 AND organization_id=$2', [
                    resourceId,
                    org,
                  ]);
                }
                return null;
              }
              const input =
                method === 'PATCH'
                  ? applyScimPatch(kind, existing, scimPatch.parse(req.body))
                  : req.body;
              if (kind === 'User')
                await writeScimUser(tx, org, resourceId, scimUserInput.parse(input), row);
              else await writeScimGroup(tx, org, resourceId, scimGroupInput.parse(input));
              return resource(tx, org, await get(tx, org, resourceId));
            });
            if (!result) return reply.code(204).send();
            reply.header('etag', result.meta.version);
            return send(reply, result);
          },
        });
    }
  });
}
