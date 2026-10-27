import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database, Sql } from '@ao/database';
import {
  toolPolicyInput,
  connectionInput,
  connectionGrant,
  formFields,
  toolEffects,
  toolRule,
} from '@ao/contracts/tools';
import { authenticate } from './auth.js';
import { lockAdministrator, requireActiveMember, type Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import type { IdentitySecrets } from '../identity/secrets.js';
import { toolRegistry } from '../tools/registry.js';
import { validatePublicEndpoint } from '../lib/safe-endpoint.js';
export async function connectionActor(tx: Sql, p: Identity) {
  const [member] = await tx.query(
    "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND kind='human' AND status='active' AND access_type='member' AND coalesce((permissions->>'execution.manage')::boolean,true) FOR SHARE",
    [p.workspaceId, p.membershipId],
  );
  const [authority] = await tx.query('SELECT * FROM public.member_account_authority($1,$2)', [
    p.workspaceId,
    p.membershipId,
  ]);
  if (!member || !authority?.verified)
    throw new AppError(
      403,
      'CONNECTION_AUTHORITY_REQUIRED',
      'A current verified human member with execution permission must authorize provider connections.',
    );
}
export function toolRoutes(
  app: FastifyInstance,
  db: Database,
  secrets: IdentitySecrets,
  hosts: string[] = [],
) {
  app.get('/v1/execution/tools', async (req) => {
    await authenticate(db, req);
    return Object.values(toolRegistry);
  });
  app.get('/v1/execution/tool-policy', async (req) => {
    const p = await authenticate(db, req);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'execution.manage');
      const [row] = await tx.query(
        'SELECT version,rules FROM tool_policies WHERE workspace_id=$1',
        [p.workspaceId],
      );
      const rules = Object.fromEntries(
        toolEffects.map((effect) => [
          effect,
          toolRule.parse((row?.rules as Record<string, unknown> | undefined)?.[effect] ?? {}),
        ]),
      );
      return { version: Number(row?.version ?? 1), rules };
    });
  });
  app.put('/v1/execution/tool-policy', async (req) => {
    const p = await authenticate(db, req),
      input = toolPolicyInput.parse(req.body);
    return db.transaction(async (tx) => {
      await lockAdministrator(tx, p, 'execution.manage');
      await tx.query('INSERT INTO tool_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [
        p.workspaceId,
      ]);
      const [row] = await tx.query(
        'UPDATE tool_policies SET rules=$3,version=version+1,updated_by=$4 WHERE workspace_id=$1 AND version=$2 RETURNING version',
        [p.workspaceId, input.version, JSON.stringify(input.rules), p.membershipId],
      );
      if (!row)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'The tool policy changed. Reload before saving.',
        );
      await recordChange(tx, p, 'tool.policy_changed', p.workspaceId);
      return row;
    });
  });
  app.get('/v1/execution/connections', async (req) => {
    const p = await authenticate(db, req);
    return db.query(
      'SELECT id,name,owner_id,endpoint,operations,version,revoked_at,protocol,health,conversation_ids,checked_at FROM tool_connections WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',
      [p.workspaceId],
    );
  });
  app.post('/v1/execution/connections', async (req, reply) => {
    const p = await authenticate(db, req),
      input = connectionInput.parse(req.body),
      connectionId = randomUUID();
    if (p.kind !== 'human' || p.accessType !== 'member')
      throw new AppError(
        403,
        'HUMAN_REQUIRED',
        'A full human member must own provider connections.',
      );
    await validatePublicEndpoint(input.endpoint, hosts, 'TOOL_PROVIDER');
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      await connectionActor(tx, p);
      await tx.query(
        'INSERT INTO tool_connections(id,workspace_id,owner_id,name,endpoint,operations) VALUES($1,$2,$3,$4,$5,$6)',
        [
          connectionId,
          p.workspaceId,
          p.membershipId,
          input.name,
          input.endpoint,
          JSON.stringify(input.operations),
        ],
      );
      await tx.query(
        'INSERT INTO tool_connection_secrets(workspace_id,connection_id,encrypted_secret) VALUES($1,$2,$3)',
        [
          p.workspaceId,
          connectionId,
          secrets.seal('tool-connection:' + p.workspaceId + ':' + connectionId, input.secret),
        ],
      );
      await recordChange(tx, p, 'tool.connection_created', connectionId, null, p.membershipId);
    });
    return reply.code(201).send({ id: connectionId });
  });
  for (const operation of ['grant', 'revoke', 'rotate'] as const)
    app.post('/v1/execution/connections/:id/' + operation, async (req) => {
      const p = await authenticate(db, req),
        connectionId = z.uuid().parse((req.params as { id: string }).id);
      const input =
        operation === 'grant'
          ? connectionGrant.parse(req.body)
          : operation === 'rotate'
            ? z
                .object({ secret: z.string().min(16).max(4000) })
                .strict()
                .parse(req.body)
            : z
                .object({ memberId: z.uuid().optional() })
                .strict()
                .parse(req.body ?? {});
      return db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        await connectionActor(tx, p);
        const [connection] = await tx.query(
          'SELECT * FROM tool_connections WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND revoked_at IS NULL FOR UPDATE',
          [p.workspaceId, connectionId, p.membershipId],
        );
        if (!connection || p.kind !== 'human') throw notFound();
        if (connection.protocol === 'mcp' && operation === 'rotate')
          throw new AppError(
            400,
            'MCP_CREDENTIAL_ROUTE',
            'Rotate MCP credentials from its connection settings.',
          );
        if (operation === 'grant') {
          const input = connectionGrant.parse(req.body);
          await requireActiveMember(tx, p, input.memberId);
          const [member] = await tx.query(
            "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND access_type='member'",
            [p.workspaceId, input.memberId],
          );
          if (!member)
            throw new AppError(
              400,
              'INVALID_GRANTEE',
              'Only full members and agents may receive provider grants.',
            );
          if (
            Date.parse(input.expiresAt) <= Date.now() ||
            Date.parse(input.expiresAt) > Date.now() + 90 * 86400000
          )
            throw new AppError(400, 'INVALID_EXPIRY', 'Grants must expire within 90 days.');
          const names = (connection.operations as { name: string }[]).map((o) => o.name);
          if (input.operations.some((o) => !names.includes(o)))
            throw new AppError(400, 'INVALID_OPERATION', 'Choose registered operations.');
          await tx.query(
            'INSERT INTO tool_connection_grants(workspace_id,connection_id,member_id,operations,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,connection_id,member_id) DO UPDATE SET operations=EXCLUDED.operations,expires_at=EXCLUDED.expires_at,revoked_at=NULL',
            [p.workspaceId, connectionId, input.memberId, input.operations, input.expiresAt],
          );
        } else if ('secret' in input) {
          await tx.query(
            'UPDATE tool_connection_secrets SET encrypted_secret=$3 WHERE workspace_id=$1 AND connection_id=$2',
            [
              p.workspaceId,
              connectionId,
              secrets.seal('tool-connection:' + p.workspaceId + ':' + connectionId, input.secret),
            ],
          );
        } else if (input.memberId) {
          await tx.query(
            'UPDATE tool_connection_grants SET revoked_at=now() WHERE workspace_id=$1 AND connection_id=$2 AND member_id=$3',
            [p.workspaceId, connectionId, input.memberId],
          );
        } else {
          await tx.query(
            'UPDATE tool_connections SET revoked_at=now() WHERE workspace_id=$1 AND id=$2',
            [p.workspaceId, connectionId],
          );
        }
        await tx.query(
          'UPDATE tool_connections SET version=version+1 WHERE workspace_id=$1 AND id=$2',
          [p.workspaceId, connectionId],
        );
        await recordChange(
          tx,
          p,
          'tool.connection_' + operation,
          connectionId,
          null,
          p.membershipId,
        );
        return { ok: true };
      });
    });
  app.get('/v1/execution/actions/:id', async (req) => {
    const p = await authenticate(db, req),
      actionId = z.uuid().parse((req.params as { id: string }).id);
    const [a] = await db.query(
      'SELECT a.id,a.invocation_id,a.idempotency_key,a.state,a.result,a.receipt,a.error_code,a.created_at,a.updated_at FROM tool_actions a WHERE a.workspace_id=$1 AND a.invocation_id=$2',
      [p.workspaceId, actionId],
    );
    if (!a) throw notFound();
    return {
      ...a,
      events: await db.query(
        'SELECT id,state,receipt,created_at FROM tool_action_events WHERE workspace_id=$1 AND action_id=$2 ORDER BY id DESC LIMIT 100',
        [p.workspaceId, a.id],
      ),
    };
  });
  app.get('/v1/execution/forms/:id', async (req) => {
    const p = await authenticate(db, req),
      formId = z.uuid().parse((req.params as { id: string }).id);
    const [form] = await db.query(
      'SELECT id,title,description,fields,expires_at FROM tool_forms WHERE workspace_id=$1 AND id=$2 AND expires_at>now()',
      [p.workspaceId, formId],
    );
    if (!form) throw notFound();
    return form;
  });
  app.post('/v1/execution/forms/:id/submissions', async (req) => {
    const p = await authenticate(db, req),
      formId = z.uuid().parse((req.params as { id: string }).id),
      input = z
        .object({
          clientId: z.uuid(),
          values: z.record(
            z.string().max(40),
            z.union([z.string().max(2000), z.number().finite(), z.boolean()]),
          ),
        })
        .strict()
        .parse(req.body);
    if (p.kind !== 'human')
      throw new AppError(403, 'HUMAN_REQUIRED', 'A person must submit interactive forms.');
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      await requireActiveMember(tx, p, p.membershipId);
      const [form] = await tx.query(
        'SELECT * FROM tool_forms WHERE workspace_id=$1 AND id=$2 AND expires_at>now() FOR SHARE',
        [p.workspaceId, formId],
      );
      if (!form) throw notFound();
      const fields = formFields.parse(form.fields);
      if (Object.keys(input.values).some((k) => !fields.some((f) => f.name === k)))
        throw new AppError(400, 'INVALID_FIELD', 'An unexpected form field was submitted.');
      for (const f of fields) {
        const v = input.values[f.name];
        if (
          (f.required && (v === undefined || v === '')) ||
          (v !== undefined &&
            typeof v !==
              ({ text: 'string', number: 'number', boolean: 'boolean' } as const)[f.type])
        )
          throw new AppError(400, 'INVALID_FIELD', 'Check the required form values and types.');
      }
      const [existing] = await tx.query(
        'SELECT id,values FROM tool_form_submissions WHERE workspace_id=$1 AND form_id=$2 AND member_id=$3',
        [p.workspaceId, formId, p.membershipId],
      );
      if (existing) {
        if (
          existing.id !== input.clientId ||
          JSON.stringify(existing.values) !== JSON.stringify(input.values)
        )
          throw new AppError(409, 'ALREADY_SUBMITTED', 'You already submitted this form.');
        return { id: existing.id, replayed: true };
      }
      await tx.query(
        'INSERT INTO tool_form_submissions(id,workspace_id,form_id,member_id,values) VALUES($1,$2,$3,$4,$5)',
        [input.clientId, p.workspaceId, formId, p.membershipId, JSON.stringify(input.values)],
      );
      await recordChange(
        tx,
        p,
        'tool.form_submitted',
        formId,
        String(form.conversation_id),
        p.membershipId,
      );
      return { id: input.clientId };
    });
  });
}
