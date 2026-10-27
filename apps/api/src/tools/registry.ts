import { validateRemoteInput } from '../developer/mcp-validation.js';
import { remoteTool } from '../developer/remote-mcp.js';
import type { Sql } from '@ao/database';
import {
  toolRule,
  type ToolDefinition,
  type ToolEffect,
  type ToolName,
  type ToolRule,
} from '@ao/contracts/tools';
import type { ToolProposal } from '@ao/contracts';
import type { RunRow } from '../execution/types.js';
import { AppError } from '../lib/errors.js';
import { runIdentities } from '../execution/policy.js';
import { hasPermission } from '../identity/authorization.js';
import { authorizeNativeConnection } from '../connections/native-actions.js';

const definitions: ToolDefinition[] = [
  {
    name: 'create_task',
    effect: 'write',
    permission: 'tasks.write',
    resource: 'source_conversation',
    cost: 'local',
  },
  {
    name: 'save_knowledge',
    effect: 'write',
    permission: 'knowledge.write',
    resource: 'source_conversation',
    cost: 'local',
  },
  {
    name: 'delegate_agent',
    effect: 'write',
    permission: 'execution.manage',
    resource: 'source_conversation',
    cost: 'local',
  },
  {
    name: 'read_tasks',
    effect: 'read',
    permission: 'tasks.read',
    resource: 'source_conversation',
    cost: 'local',
  },
  {
    name: 'read_knowledge',
    effect: 'read',
    permission: 'knowledge.read',
    resource: 'source_conversation',
    cost: 'local',
  },
  {
    name: 'connection_action',
    effect: 'publish',
    permission: 'execution.manage',
    resource: 'owner_connection',
    cost: 'provider',
  },
  {
    name: 'execute_code',
    effect: 'execute',
    permission: 'execution.manage',
    resource: 'isolated_sandbox',
    cost: 'sandbox',
  },
  {
    name: 'interactive_form',
    effect: 'write',
    permission: 'messages.write',
    resource: 'source_conversation',
    cost: 'local',
  },
].map(
  (d) =>
    ({
      ...d,
      version: 1,
      deadlineSeconds: d.cost === 'sandbox' ? 35 : 15,
      maxResultBytes: 32000,
      redaction: 'No credentials, environment, raw headers or provider response bodies.',
    }) as ToolDefinition,
);
export const toolRegistry = Object.freeze(
  Object.fromEntries(definitions.map((d) => [d.name, Object.freeze(d)])),
) as Readonly<Record<ToolName, ToolDefinition>>;
export interface ActionAuthorization {
  effect: ToolEffect;
  rule: ToolRule;
  connectionVersion?: number;
  connectionOwner?: string;
  connectionName?: string;
  destination?: string;
  operationDescription?: string;
  nativeProvider?: string;
  remoteMcp?: boolean;
  remoteToolName?: string;
  resource?: string;
}
export async function effectiveRule(tx: Sql, workspaceId: string, effect: ToolEffect) {
  const [policy] = await tx.query('SELECT version,rules FROM tool_policies WHERE workspace_id=$1', [
    workspaceId,
  ]);
  return {
    version: Number(policy?.version ?? 1),
    rule: toolRule.parse((policy?.rules as Record<string, unknown> | undefined)?.[effect] ?? {}),
  };
}
export async function authorizeTool(
  tx: Sql,
  run: RunRow,
  proposal: ToolProposal,
): Promise<ActionAuthorization> {
  const [governance] = await tx.query(
    "SELECT governance_policy($1) policy,governance_egress($1,'tool',$2) egress",
    [run.workspace_id, proposal.tool],
  );
  const enforced = governance?.policy as { tools?: string[] } | undefined;
  if (!governance?.egress || (enforced?.tools?.length && !enforced.tools.includes(proposal.tool)))
    throw new AppError(409, 'GOVERNANCE_DENIED', 'Organization policy disables this tool.');
  const definition = toolRegistry[proposal.tool];
  const { agent, requester } = await runIdentities(tx, run);
  if (
    !hasPermission(agent, definition.permission) ||
    !hasPermission(requester, definition.permission)
  )
    throw new AppError(
      409,
      'TOOL_PERMISSION_REQUIRED',
      'The requester and agent must retain the required resource permission.',
    );
  let effect = definition.effect;
  const context: Omit<ActionAuthorization, 'effect' | 'rule'> = {};
  if (proposal.tool === 'connection_action') {
    const [c] = await tx.query(
      "SELECT c.* FROM tool_connections c JOIN memberships m ON m.workspace_id=c.workspace_id AND m.id=c.owner_id WHERE c.workspace_id=$1 AND c.id=$2 AND c.revoked_at IS NULL AND m.kind='human' AND m.status='active' AND m.access_type='member' AND coalesce((m.permissions->>'execution.manage')::boolean,true) FOR SHARE OF c,m",
      [run.workspace_id, proposal.parameters.connectionId],
    );
    if (!c) {
      const native = await authorizeNativeConnection(
        tx,
        run.workspace_id,
        proposal.parameters.connectionId,
        proposal.parameters.operation,
        proposal.parameters.payload,
        [requester.membershipId, agent.membershipId],
      );
      Object.assign(context, {
        connectionVersion: Number(native.connection.version),
        connectionOwner: String(native.connection.owner_id),
        connectionName: String(native.connection.name),
        destination: String(native.connection.provider),
        nativeProvider: String(native.connection.provider),
        resource: native.mutation.resource,
        operationDescription: native.description,
      });
      effect = 'write';
    } else {
      const [ownerAuthority] = await tx.query(
        'SELECT * FROM public.member_account_authority($1,$2)',
        [run.workspace_id, c.owner_id],
      );
      if (!ownerAuthority?.verified)
        throw new AppError(
          409,
          'CONNECTION_OWNER_UNAVAILABLE',
          'The connection owner must retain a verified active account.',
        );
      const operation = (
        c.operations as {
          name: string;
          effect: ToolEffect;
          description: string;
          remoteName?: string;
        }[]
      ).find((o) => o.name === proposal.parameters.operation);
      if (!operation)
        throw new AppError(
          409,
          'OPERATION_DENIED',
          'The connection owner has not registered this operation.',
        );
      if (c.protocol === 'mcp') {
        if (!(c.conversation_ids as string[]).includes(run.conversation_id))
          throw new AppError(
            409,
            'MCP_AUDIENCE_DENIED',
            'This remote server is not granted to the source conversation.',
          );
        const tool = (c.mcp_manifest as unknown[])
          .map((t) => remoteTool.parse(t))
          .find((t) => t.name === operation.remoteName);
        if (!tool)
          throw new AppError(
            409,
            'MCP_TOOL_UNPUBLISHED',
            'The reviewed remote tool is unavailable.',
          );
        await validateRemoteInput(tool.inputSchema, JSON.parse(proposal.parameters.payload));
        context.remoteMcp = true;
        context.remoteToolName = tool.name;
      }
      for (const member of [requester.membershipId, agent.membershipId]) {
        const [grant] = await tx.query(
          'SELECT 1 FROM tool_connection_grants WHERE workspace_id=$1 AND connection_id=$2 AND member_id=$3 AND $4=ANY(operations) AND revoked_at IS NULL AND expires_at>now() FOR SHARE',
          [run.workspace_id, c.id, member, operation.name],
        );
        if (!grant)
          throw new AppError(
            409,
            'CONNECTION_OWNER_AUTHORIZATION_REQUIRED',
            'The connection owner must grant this operation to both requester and agent.',
          );
      }
      effect = operation.effect;
      Object.assign(context, {
        connectionVersion: Number(c.version),
        connectionOwner: String(c.owner_id),
        connectionName: String(c.name),
        destination: String(c.endpoint),
        operationDescription: operation.description,
      });
    }
  }
  const { rule } = await effectiveRule(tx, run.workspace_id, effect);
  if (rule.approval === 'deny')
    throw new AppError(409, 'TOOL_POLICY_DENIED', 'Workspace policy denies this operation.');
  return { effect, rule, ...context };
}
