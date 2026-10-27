import { randomUUID } from 'node:crypto';
import { workerScope, scopedDatabase, type Database, type Sql } from '@ao/database';
import type { ConnectorId } from '@ao/contracts/connections';
import type { z } from 'zod';
import { connectionInput, connectionImport } from '@ao/contracts/connections';
import { manifest, validateConnectionConfiguration } from './catalog.js';
import { ProviderFailure, type ConnectorProvider, type Credential } from './provider.js';
import type { Identity } from '../lib/policy.js';
import { requireConversation } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import type { IdentitySecrets } from '../identity/secrets.js';
export async function connectionActor(tx: Sql, p: Identity) {
  const [m] = await tx.query(
    "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND kind='human' AND access_type='member' AND status='active' AND coalesce((permissions->>'execution.manage')::boolean,true) AND coalesce((permissions->>'knowledge.read')::boolean,true) FOR SHARE",
    [p.workspaceId, p.membershipId],
  );
  const [a] = await tx.query('SELECT * FROM member_account_authority($1,$2)', [
    p.workspaceId,
    p.membershipId,
  ]);
  if (!m || !a?.verified)
    throw new AppError(
      403,
      'CONNECTION_AUTHORITY_REQUIRED',
      'A verified human member with execution permission must manage connections.',
    );
  const [policy] = await tx.query('SELECT workspace_policy_version($1) version', [p.workspaceId]);
  return { auth: Number(a.auth_version), policy: Number(policy!.version) };
}
export const credentialContext = (workspace: string, id: string) => `connection:${workspace}:${id}`;
export async function ownedConnection(tx: Sql, p: Identity, id: string) {
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
  await connectionActor(tx, p);
  const [row] = await tx.query(
    'SELECT * FROM connections WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 FOR UPDATE',
    [p.workspaceId, id, p.membershipId],
  );
  if (!row) throw notFound();
  return row;
}
export class ConnectionService {
  constructor(
    private db: Database,
    private secrets: IdentitySecrets,
    private provider: ConnectorProvider,
    private refresh?: (provider: ConnectorId, credential: Credential) => Promise<Credential>,
  ) {
    this.db = scopedDatabase(db);
  }
  async create(
    p: Identity,
    input: z.infer<typeof connectionInput>,
    credential?: Credential,
    expected?: { auth: number; policy: number },
  ) {
    if (!manifest(input.provider).operations.length)
      throw new AppError(
        409,
        'CONNECTOR_NOT_IMPLEMENTED',
        'This provider is listed in the catalog but its adapter is not implemented.',
      );
    if (
      input.subscriptions.some(
        (value) =>
          !['bridge:resource.changed', 'bridge:resource.deleted', 'bridge:email.received'].includes(
            value,
          ),
      )
    )
      throw new AppError(
        409,
        'SUBSCRIPTION_NOT_IMPLEMENTED',
        'Use explicit bridge subscriptions; native provider subscriptions require a qualified adapter.',
      );
    if (!validateConnectionConfiguration(input.provider, input.config))
      throw new AppError(
        400,
        'INVALID_CONNECTION_CONFIGURATION',
        'Use account identifiers and approved resource fields. Credentials belong only in the encrypted credential field.',
      );
    const fields = manifest(input.provider).configuration;
    if (
      fields.some((field) => field.required && !input.config[field.key]?.trim()) ||
      Object.keys(input.config).some((key) => !fields.some((field) => field.key === key))
    )
      throw new AppError(
        400,
        'CONNECTOR_CONFIGURATION_REQUIRED',
        'Supply exactly the configuration fields documented in the provider manifest.',
      );
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const authority = await connectionActor(tx, p),
        id = randomUUID();
      if (expected && (authority.auth !== expected.auth || authority.policy !== expected.policy))
        throw new AppError(409, 'AUTHORITY_CHANGED', 'Start a new connection request.');
      const encrypted = this.secrets.seal(
        credentialContext(p.workspaceId, id),
        JSON.stringify(
          credential ?? {
            accessToken: input.credential,
            tokenType: input.provider === 'linear' ? 'raw' : 'Bearer',
          },
        ),
      );
      await tx.query(
        'INSERT INTO connections(id,workspace_id,owner_id,provider,name,audience,config,subscriptions,auth_version,policy_version,write_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          id,
          p.workspaceId,
          p.membershipId,
          input.provider,
          input.name,
          input.audience,
          JSON.stringify(input.config),
          input.subscriptions,
          authority.auth,
          authority.policy,
          credential ? credential.writeAllowed === true : input.allowWrites,
        ],
      );
      await tx.query(
        'INSERT INTO connection_secrets(workspace_id,connection_id,encrypted_value) VALUES($1,$2,$3)',
        [p.workspaceId, id, encrypted],
      );
      await recordChange(tx, p, 'connection.created', id, undefined, p.membershipId);
      return { id };
    });
  }
  private async authorize(tx: Sql, p: Identity, id: string, operation: string, resource: string) {
    const [row] = await tx.query(
      `SELECT c.* FROM connections c JOIN memberships owner ON owner.workspace_id=c.workspace_id AND owner.id=c.owner_id
   WHERE c.workspace_id=$1 AND c.id=$2 AND c.state='connected' AND c.credential_expires_at>now() AND connection_authority_current(c.workspace_id,c.id) AND owner.status='active' AND owner.kind='human' AND owner.access_type='member'
   AND coalesce((owner.permissions->>'execution.manage')::boolean,true) AND coalesce((owner.permissions->>'knowledge.read')::boolean,true)
   AND (c.owner_id=$3 OR EXISTS(SELECT 1 FROM connection_grants g WHERE g.workspace_id=c.workspace_id AND g.connection_id=c.id AND g.member_id=$3 AND g.revoked_at IS NULL AND g.expires_at>now() AND $4=ANY(g.operations) AND $5=ANY(g.resources))) FOR UPDATE OF c`,
      [p.workspaceId, id, p.membershipId, operation, resource],
    );
    if (!row) throw notFound();
    const [authority] = await tx.query('SELECT * FROM member_account_authority($1,$2)', [
      p.workspaceId,
      row.owner_id,
    ]);
    const [policy] = await tx.query('SELECT workspace_policy_version($1) version', [p.workspaceId]);
    if (
      !authority?.verified ||
      Number(authority.auth_version) !== row.auth_version ||
      Number(policy!.version) !== row.policy_version
    )
      throw new AppError(
        409,
        'CONNECTION_AUTHORITY_CHANGED',
        'The owner must reconnect this connection after an account or organization policy change.',
      );
    const m = manifest(row.provider as ConnectorId);
    if (!m.operations.some((o) => o.id === operation && o.effect === 'read'))
      throw new AppError(
        400,
        'OPERATION_DENIED',
        'This operation is not supported by the provider manifest.',
      );
    return row;
  }
  async reconnect(
    p: Identity,
    id: string,
    version: number,
    credential: Credential,
    expected: { auth: number; policy: number },
  ) {
    return this.db.transaction(async (tx) => {
      const row = await ownedConnection(tx, p, id),
        authority = await connectionActor(tx, p);
      if (
        Number(row.version) !== version ||
        authority.auth !== expected.auth ||
        authority.policy !== expected.policy
      )
        throw new AppError(
          409,
          'CONNECTION_CHANGED',
          'The account or connection changed. Start consent again.',
        );
      await tx.query(
        'UPDATE connection_secrets SET encrypted_value=$3,generation=generation+1,refresh_lease=NULL,refresh_until=NULL,rotated_at=now() WHERE workspace_id=$1 AND connection_id=$2',
        [
          p.workspaceId,
          id,
          this.secrets.seal(credentialContext(p.workspaceId, id), JSON.stringify(credential)),
        ],
      );
      await tx.query(
        'INSERT INTO connection_secrets(workspace_id,connection_id,encrypted_value) VALUES($1,$2,$3) ON CONFLICT(workspace_id,connection_id) DO NOTHING',
        [
          p.workspaceId,
          id,
          this.secrets.seal(credentialContext(p.workspaceId, id), JSON.stringify(credential)),
        ],
      );
      await tx.query(
        "UPDATE connections SET state='connected',version=version+1,write_enabled=$3,auth_version=$4,policy_version=$5,credential_expires_at=now()+interval '90 days',last_error_code=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id, credential.writeAllowed === true, authority.auth, authority.policy],
      );
      await tx.query(
        'UPDATE connection_grants SET revoked_at=now() WHERE workspace_id=$1 AND connection_id=$2',
        [p.workspaceId, id],
      );
      await tx.query(
        "UPDATE connection_resources SET deleted_at=now(),body='',title='Reconnect requires reimport',version=version+1 WHERE workspace_id=$1 AND connection_id=$2",
        [p.workspaceId, id],
      );
      await tx.query(
        "UPDATE connection_webhooks SET enabled=false,encrypted_incoming='',encrypted_outgoing='',version=version+1 WHERE workspace_id=$1 AND connection_id=$2",
        [p.workspaceId, id],
      );
      await recordChange(tx, p, 'connection.reconnected', id, null, p.membershipId);
      return { id, version: version + 1 };
    });
  }
  async read(
    p: Identity,
    id: string,
    input: z.infer<typeof connectionImport>,
    retentionCeiling?: string | Date,
    guard?: (tx: Sql) => Promise<void>,
  ) {
    const connection = await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const row = await this.authorize(tx, p, id, input.operation, input.resource);
      await guard?.(tx);
      if (input.conversationId) await requireConversation(tx, p, input.conversationId, true);
      if (new Date(String(row.next_request_at)).getTime() > Date.now())
        throw new AppError(
          429,
          'CONNECTION_RATE_LIMITED',
          'Wait before the next provider request.',
        );
      await tx.query(
        "UPDATE connections SET next_request_at=now()+$3::integer*interval '1 second' WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, id, row.provider === 'notion' ? 40 : 2],
      );
      const [clock] = await tx.query('SELECT now()::text started');
      return Object.assign(row, { request_started: clock!.started });
    });
    const credential = await this.credentials(p.workspaceId, id, connection);
    let document;
    try {
      document = await this.provider.read({
        provider: connection.provider as ConnectorId,
        operation: input.operation,
        resource: input.resource,
        credential,
        config: connection.config as Record<string, string>,
        signal: AbortSignal.timeout(15000),
        guard: () =>
          this.db.transaction(async (tx) => {
            const current = await this.authorize(tx, p, id, input.operation, input.resource);
            if (current.version !== connection.version)
              throw new AppError(
                409,
                'CONNECTION_CHANGED',
                'The connection changed during resource traversal.',
              );
            if (input.conversationId) await requireConversation(tx, p, input.conversationId, true);
            await guard?.(tx);
          }),
      });
    } catch (error) {
      const code = error instanceof ProviderFailure ? error.code : 'PROVIDER_UNAVAILABLE';
      await workerScope(p.workspaceId, () =>
        this.db.query(
          "UPDATE connections SET last_error_code=$3,state=CASE WHEN $3='PROVIDER_AUTH_REQUIRED' THEN 'reconnect_required' ELSE state END,next_request_at=now()+$4::integer*interval '1 second' WHERE workspace_id=$1 AND id=$2 AND version=$5",
          [
            p.workspaceId,
            id,
            code,
            error instanceof ProviderFailure ? Math.max(2, error.retryAfter) : 30,
            connection.version,
          ],
        ),
      );
      throw new AppError(
        502,
        code,
        'The provider request failed. Credentials and provider response details have been withheld.',
      );
    }
    if (document.truncated)
      throw new AppError(
        422,
        'INCOMPLETE_PROVIDER_RESOURCE',
        'This resource needs a paginated or recursive provider adapter before it can be imported completely.',
      );
    if (document.body.length > 1000000 || document.title.length > 500)
      throw new AppError(502, 'PROVIDER_RESPONSE_LIMIT', 'The resource exceeds import limits.');
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      const current = await this.authorize(tx, p, id, input.operation, input.resource);
      await guard?.(tx);
      if (retentionCeiling && new Date(retentionCeiling).getTime() <= Date.now())
        throw new AppError(
          410,
          'RESOURCE_RETENTION_EXPIRED',
          'The imported resource retention period expired.',
        );
      if (current.version !== connection.version)
        throw new AppError(409, 'CONNECTION_CHANGED', 'The connection changed during the request.');
      if (input.conversationId) await requireConversation(tx, p, input.conversationId, true);
      if (current.owner_id !== p.membershipId)
        throw new AppError(
          403,
          'CONNECTION_OWNER_REQUIRED',
          'The connection owner must import resources. Consumers can search explicitly granted imports.',
        );
      const [old] = await tx.query(
        'SELECT conversation_id,fetched_at>$4::timestamptz newer FROM connection_resources WHERE workspace_id=$1 AND connection_id=$2 AND external_id=$3 FOR UPDATE',
        [p.workspaceId, id, input.resource, connection.request_started],
      );
      if (old?.newer)
        throw new AppError(
          409,
          'RESOURCE_FETCH_SUPERSEDED',
          'A newer provider read completed first. Fetch this resource again.',
        );
      if (old && old.conversation_id !== (input.conversationId ?? null))
        throw new AppError(
          409,
          'RESOURCE_AUDIENCE_IMMUTABLE',
          'Create a separately reviewed copy to change this resource audience.',
        );
      const [row] = await tx.query(
        `INSERT INTO connection_resources(workspace_id,connection_id,external_id,operation,conversation_id,title,body,source_url,provider_version,retained_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,least(now()+$10::integer*interval '1 day',coalesce($11::timestamptz,'infinity'::timestamptz))) ON CONFLICT(workspace_id,connection_id,external_id) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,source_url=EXCLUDED.source_url,provider_version=EXCLUDED.provider_version,retained_until=EXCLUDED.retained_until,deleted_at=NULL,version=connection_resources.version+CASE WHEN (connection_resources.title,connection_resources.body,connection_resources.provider_version) IS DISTINCT FROM (EXCLUDED.title,EXCLUDED.body,EXCLUDED.provider_version) THEN 1 ELSE 0 END,fetched_at=now() RETURNING id,version`,
        [
          p.workspaceId,
          id,
          input.resource,
          input.operation,
          input.conversationId ?? null,
          document.title,
          document.body,
          document.sourceUrl ?? null,
          document.providerVersion ?? null,
          input.retentionDays,
          retentionCeiling ?? null,
        ],
      );
      await tx.query(
        'UPDATE connections SET last_success_at=now(),last_error_code=NULL WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id],
      );
      await recordChange(
        tx,
        p,
        'connection.resource_imported',
        String(row!.id),
        input.conversationId,
        p.membershipId,
      );
      return row!;
    });
  }
  async credentials(
    workspace: string,
    id: string,
    connection: Record<string, unknown>,
  ): Promise<Credential> {
    return workerScope(workspace, async () => {
      const [policy] = await this.db.query(
        "SELECT governance_policy($1) policy,governance_egress($1,'connection',$2) egress",
        [workspace, connection.provider],
      );
      const current = policy?.policy as
        { connections?: boolean; connectionProviders?: string[] } | undefined;
      if (
        !policy?.egress ||
        current?.connections === false ||
        (current?.connectionProviders?.length &&
          !current.connectionProviders.includes(String(connection.provider)))
      )
        throw new AppError(
          409,
          'GOVERNANCE_DENIED',
          'Organization policy disables this connection.',
        );
      const [row] = await this.db.query(
        'SELECT encrypted_value,generation FROM connection_secrets WHERE workspace_id=$1 AND connection_id=$2',
        [workspace, id],
      );
      if (!row) throw notFound();
      const credential = JSON.parse(
        this.secrets.open(credentialContext(workspace, id), String(row.encrypted_value)),
      ) as Credential;
      if (!credential.expiresAt || credential.expiresAt > Date.now() + 60000) return credential;
      if (!this.refresh || !credential.refreshToken)
        throw new AppError(
          409,
          'CONNECTION_RECONNECT_REQUIRED',
          'The provider credential expired. Reconnect the account.',
        );
      const lease = randomUUID();
      const [claimed] = await this.db.query(
        "UPDATE connection_secrets SET refresh_lease=$3,refresh_until=now()+interval '30 seconds' WHERE workspace_id=$1 AND connection_id=$2 AND generation=$4 AND (refresh_until IS NULL OR refresh_until<now()) RETURNING generation",
        [workspace, id, lease, row.generation],
      );
      if (!claimed)
        throw new AppError(
          409,
          'CONNECTION_REFRESH_BUSY',
          'Credential refresh is already in progress. Retry shortly.',
        );
      let refreshed: Credential;
      try {
        refreshed = await this.refresh(connection.provider as ConnectorId, credential);
      } catch {
        await this.db.query(
          "UPDATE connections SET state='reconnect_required',last_error_code='TOKEN_REFRESH_FAILED' WHERE workspace_id=$1 AND id=$2 AND version=$3",
          [workspace, id, connection.version],
        );
        throw new AppError(
          409,
          'CONNECTION_RECONNECT_REQUIRED',
          'The owner must reconnect this account.',
        );
      }
      const [saved] = await this.db.query(
        `UPDATE connection_secrets s SET encrypted_value=$4,generation=generation+1,refresh_lease=NULL,refresh_until=NULL,rotated_at=now() WHERE s.workspace_id=$1 AND s.connection_id=$2 AND s.refresh_lease=$3 AND s.refresh_until>now() AND EXISTS(SELECT 1 FROM connections c WHERE c.workspace_id=s.workspace_id AND c.id=s.connection_id AND c.version=$5 AND c.state='connected') RETURNING generation`,
        [
          workspace,
          id,
          lease,
          this.secrets.seal(credentialContext(workspace, id), JSON.stringify(refreshed)),
          connection.version,
        ],
      );
      if (!saved)
        throw new AppError(
          409,
          'CONNECTION_CHANGED',
          'The connection changed during token refresh.',
        );
      return refreshed;
    });
  }
}
