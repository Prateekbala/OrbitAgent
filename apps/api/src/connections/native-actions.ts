import { scopedDatabase, workerScope, type Database, type Sql } from '@ao/database';
import type { ConnectorId } from '@ao/contracts/connections';
import { AppError } from '../lib/errors.js';
import type { ProviderReceipt } from '../tools/provider.js';
import type { ConnectionService } from './service.js';
import {
  nativeOperations,
  parseNativeMutation,
  nativeWriteProvider,
  type NativeWriteProvider,
} from './mutations.js';

export async function authorizeNativeConnection(
  tx: Sql,
  workspace: string,
  id: string,
  operation: string,
  payload: string,
  members: string[],
) {
  const [c] = await tx.query(
    "SELECT * FROM connections WHERE workspace_id=$1 AND id=$2 AND state='connected' AND write_enabled AND connection_authority_current(workspace_id,id) FOR SHARE",
    [workspace, id],
  );
  if (!c)
    throw new AppError(
      409,
      'CONNECTION_UNAVAILABLE',
      'The owner must enable native writes on a current connection.',
    );
  const mutation = parseNativeMutation(c.provider as ConnectorId, operation, payload);
  for (const member of new Set(members)) {
    const [active] = await tx.query(
      "SELECT 1 FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND access_type='member' AND coalesce((permissions->>'execution.manage')::boolean,true) AND retrieval_principal_current(workspace_id,id)",
      [workspace, member],
    );
    const [grant] =
      member === c.owner_id
        ? [active]
        : await tx.query(
            'SELECT 1 FROM connection_grants WHERE workspace_id=$1 AND connection_id=$2 AND member_id=$3 AND revoked_at IS NULL AND expires_at>now() AND $4=ANY(operations) AND $5=ANY(resources) FOR SHARE',
            [workspace, id, member, operation, mutation.resource],
          );
    if (!active || !grant || (member !== c.owner_id && c.audience !== 'workspace'))
      throw new AppError(
        409,
        'CONNECTION_OWNER_AUTHORIZATION_REQUIRED',
        'The owner must grant the exact write operation and resource to every consumer.',
      );
  }
  return {
    connection: c,
    mutation,
    description: nativeOperations(c.provider as ConnectorId).find((o) => o.id === operation)!.label,
  };
}
export interface NativeAction {
  workspaceId: string;
  connectionId: string;
  connectionVersion: number;
  operation: string;
  payload: string;
  key: string;
  reconcile: boolean;
  guard(): Promise<void>;
}
export class NativeConnectorActions {
  constructor(
    private db: Database,
    private connections: ConnectionService,
    private provider: NativeWriteProvider = nativeWriteProvider(),
  ) {
    this.db = scopedDatabase(db);
  }
  async execute(input: NativeAction): Promise<ProviderReceipt> {
    return workerScope(input.workspaceId, async () => {
      let enteredProvider = false;
      try {
        await input.guard();
        const [c] = await this.db.query(
          "SELECT * FROM connections WHERE workspace_id=$1 AND id=$2 AND state='connected' AND write_enabled AND version=$3 AND connection_authority_current(workspace_id,id)",
          [input.workspaceId, input.connectionId, input.connectionVersion],
        );
        if (!c) return { status: 'unknown' };
        const [reserved] = await this.db.query(
          "UPDATE connections SET next_request_at=now()+$4::integer*interval '1 second' WHERE workspace_id=$1 AND id=$2 AND version=$3 AND next_request_at<=now() RETURNING id",
          [input.workspaceId, input.connectionId, input.connectionVersion, input.reconcile ? 2 : 6],
        );
        if (!reserved)
          return input.reconcile
            ? { status: 'unknown' }
            : { status: 'not_applied', receipt: 'connection-throttled:' + input.key };
        const mutation = parseNativeMutation(
          c.provider as ConnectorId,
          input.operation,
          input.payload,
        );
        const credential = await this.connections.credentials(
          input.workspaceId,
          input.connectionId,
          c,
        );
        enteredProvider = true;
        return await this.provider({
          provider: c.provider as ConnectorId,
          operation: input.operation,
          resource: mutation.resource,
          mutation,
          credential,
          config: c.config as Record<string, string>,
          key: input.key,
          reconcile: input.reconcile,
          guard: input.guard,
          observe: async (response) => {
            if ([401, 403, 429].includes(response.status))
              await this.db.query(
                "UPDATE connections SET last_error_code=$4,state=CASE WHEN $5 THEN 'reconnect_required' ELSE state END,next_request_at=greatest(next_request_at,now()+$6::integer*interval '1 second') WHERE workspace_id=$1 AND id=$2 AND version=$3",
                [
                  input.workspaceId,
                  input.connectionId,
                  input.connectionVersion,
                  response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_AUTH_REQUIRED',
                  response.status !== 429,
                  Math.max(2, response.retryAfter),
                ],
              );
          },
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        return input.reconcile || enteredProvider
          ? { status: 'unknown' }
          : { status: 'not_applied', receipt: 'authorization-unavailable:' + input.key };
      }
    });
  }
}
