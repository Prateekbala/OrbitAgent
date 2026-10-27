import { createHash, randomUUID } from 'node:crypto';
import type { Sql, Database } from '@ao/database';
import { toolProposal } from '@ao/contracts';
import type { ToolProposal } from '@ao/contracts';
import { recordChange } from '../lib/events.js';
import { AppError, notFound } from '../lib/errors.js';
import { requireAdmin, requireConversation, type Identity } from '../lib/policy.js';
import { runIdentities, requireRunContext } from './policy.js';
import type { RunRow, InvocationRow } from './types.js';
import { delegateRun } from './delegation.js';
import { runConfiguration } from './controls.js';
import {
  authorizeTool,
  effectiveRule,
  toolRegistry,
  type ActionAuthorization,
} from '../tools/registry.js';
import type { IdentitySecrets } from '../identity/secrets.js';
import { digest as secretDigest } from '../lib/security.js';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export function actionDigest(
  runId: string,
  conversationId: string,
  proposal: ToolProposal,
  policyVersion = 1,
  authorization: Record<string, unknown> = {},
) {
  return createHash('sha256')
    .update(
      canonical({
        runId,
        conversationId,
        proposal,
        toolVersion: 1,
        policyVersion,
        ...(Object.keys(authorization).length ? { authorization } : {}),
      }),
    )
    .digest('hex');
}
export async function settleRun(tx: Sql, run: RunRow) {
  await tx.query(
    `UPDATE agent_runs SET status=CASE WHEN EXISTS(SELECT 1 FROM tool_invocations WHERE run_id=$1 AND status='failed') THEN 'failed' ELSE 'succeeded' END,error_code=CASE WHEN EXISTS(SELECT 1 FROM tool_invocations WHERE run_id=$1 AND status='failed') THEN 'TOOL_FAILED' ELSE NULL END,updated_at=now() WHERE id=$1 AND status='awaiting_approval' AND NOT EXISTS(SELECT 1 FROM tool_invocations WHERE run_id=$1 AND status IN ('pending','approved','executing','outcome_unknown'))`,
    [run.id],
  );
}
export class ToolGateway {
  constructor(
    private readonly db: Database,
    private readonly secrets?: IdentitySecrets,
  ) {}
  async decide(
    identity: Identity,
    invocationId: string,
    decision: 'approved' | 'rejected',
    digest: string,
    reason: string,
  ) {
    requireAdmin(identity);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [identity.workspaceId]);
      const [ref] = await tx.query<InvocationRow>(
        'SELECT * FROM tool_invocations WHERE workspace_id=$1 AND id=$2',
        [identity.workspaceId, invocationId],
      );
      if (!ref) throw notFound();
      const [run] = await tx.query<RunRow>(
        'SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [identity.workspaceId, ref.run_id],
      );
      if (!run) throw notFound();
      const [action] = await tx.query<InvocationRow>(
        'SELECT * FROM tool_invocations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [identity.workspaceId, invocationId],
      );
      if (!action) throw notFound();
      const [currentApprover] = await tx.query(
        'SELECT role,kind,status,permissions,access_type FROM memberships WHERE workspace_id=$1 AND id=$2 FOR SHARE',
        [identity.workspaceId, identity.membershipId],
      );
      const [authority] = await tx.query('SELECT * FROM public.member_account_authority($1,$2)', [
        identity.workspaceId,
        identity.membershipId,
      ]);
      if (
        !authority?.verified ||
        !currentApprover ||
        currentApprover.kind !== 'human' ||
        currentApprover.status !== 'active' ||
        currentApprover.access_type !== 'member' ||
        (currentApprover.permissions as Record<string, unknown>)['execution.manage'] === false ||
        !['owner', 'admin'].includes(String(currentApprover.role))
      )
        throw new AppError(
          403,
          'FORBIDDEN',
          'A current human administrator must approve this action.',
        );
      await requireConversation(tx, identity, run.conversation_id);
      if (action.status !== 'pending' || run.status !== 'awaiting_approval')
        throw new AppError(
          409,
          'ACTION_NOT_PENDING',
          'This action is no longer awaiting approval.',
        );
      if (new Date(action.expires_at).getTime() <= Date.now())
        throw new AppError(409, 'APPROVAL_EXPIRED', 'This approval has expired.');
      const proposal = toolProposal.parse({
        tool: action.tool_name,
        parameters: action.parameters,
      });
      if (
        action.tool_version !== 1 ||
        digest !== action.action_digest ||
        digest !==
          actionDigest(
            run.id,
            run.conversation_id,
            proposal,
            action.policy_version,
            action.authorization_snapshot as Record<string, unknown>,
          )
      )
        throw new AppError(
          409,
          'ACTION_CHANGED',
          'The proposed action changed. Refresh and review it again.',
        );
      await validateAuthorization(tx, run, action, proposal);
      const rule = (action.authorization_snapshot as ActionAuthorization | undefined)?.rule;
      if (rule?.approval === 'owner' && currentApprover.role !== 'owner')
        throw new AppError(
          403,
          'OWNER_APPROVAL_REQUIRED',
          'A workspace owner must approve this operation.',
        );
      if (rule?.independent && run.requester_id === identity.membershipId)
        throw new AppError(
          403,
          'INDEPENDENT_APPROVAL_REQUIRED',
          'A different administrator must review this operation.',
        );
      await tx.query(
        'INSERT INTO approval_decisions(id,workspace_id,invocation_id,approver_id,decision,action_digest,reason,approver_auth_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          identity.workspaceId,
          action.id,
          identity.membershipId,
          decision,
          digest,
          reason,
          authority.auth_version,
        ],
      );
      await tx.query('UPDATE tool_invocations SET status=$1 WHERE id=$2', [decision, action.id]);
      await recordChange(tx, identity, 'approval.' + decision, action.id, run.conversation_id);
      await settleRun(tx, run);
      return { ok: true };
    });
  }
  async execute(invocationId: string) {
    return this.db.transaction(async (tx) => {
      const [tenant] = await tx.query('SELECT workspace_id FROM tool_invocations WHERE id=$1', [
        invocationId,
      ]);
      if (!tenant) return;
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [tenant.workspace_id]);
      const [ref] = await tx.query<InvocationRow>('SELECT * FROM tool_invocations WHERE id=$1', [
        invocationId,
      ]);
      if (!ref) return;
      const [run] = await tx.query<RunRow>('SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE', [
        ref.run_id,
      ]);
      if (!run) return;
      const [action] = await tx.query<InvocationRow>(
        'SELECT * FROM tool_invocations WHERE id=$1 FOR UPDATE',
        [invocationId],
      );
      if (!action || action.status !== 'approved' || run.status !== 'awaiting_approval') return;
      if (new Date(action.expires_at).getTime() <= Date.now()) {
        await tx.query("UPDATE tool_invocations SET status='expired' WHERE id=$1", [action.id]);
        await settleRun(tx, run);
        return;
      }
      const proposal = toolProposal.parse({
        tool: action.tool_name,
        parameters: action.parameters,
      });
      const [approval] = await tx.query(
        'SELECT d.*,m.role,m.kind,m.permissions,m.access_type,m.status membership_status FROM approval_decisions d JOIN memberships m ON m.id=d.approver_id AND m.workspace_id=d.workspace_id WHERE d.invocation_id=$1 FOR SHARE OF m',
        [action.id],
      );
      const [authority] = approval
        ? await tx.query('SELECT * FROM public.member_account_authority($1,$2)', [
            run.workspace_id,
            approval.approver_id,
          ])
        : [];
      if (
        !authority?.verified ||
        Number(authority.auth_version) !== approval?.approver_auth_version ||
        !approval ||
        approval.decision !== 'approved' ||
        approval.kind !== 'human' ||
        approval.membership_status !== 'active' ||
        approval.access_type !== 'member' ||
        (approval.permissions as Record<string, unknown>)['execution.manage'] === false ||
        !['owner', 'admin'].includes(String(approval.role)) ||
        approval.action_digest !== action.action_digest ||
        action.tool_version !== 1 ||
        actionDigest(
          run.id,
          run.conversation_id,
          proposal,
          action.policy_version,
          action.authorization_snapshot as Record<string, unknown>,
        ) !== action.action_digest
      )
        throw new AppError(
          409,
          'APPROVAL_INVALID',
          'Approval authority or action parameters changed.',
        );
      const { agent, requester } = await runIdentities(tx, run);
      await validateAuthorization(tx, run, action, proposal);
      const rule = (action.authorization_snapshot as ActionAuthorization | undefined)?.rule;
      if (
        (rule?.approval === 'owner' && approval.role !== 'owner') ||
        (rule?.independent && approval.approver_id === run.requester_id)
      )
        throw new AppError(409, 'APPROVAL_INVALID', 'Approval no longer meets workspace policy.');
      if (!runConfiguration(run).tools.includes(proposal.tool))
        throw new AppError(409, 'TOOL_GRANT_DENIED', 'The run does not grant this tool.');
      await requireConversation(
        tx,
        {
          workspaceId: run.workspace_id,
          membershipId: String(approval.approver_id),
          name: 'Approver',
          kind: 'human',
          role: approval.role as Identity['role'],
        },
        run.conversation_id,
      );
      if (proposal.tool === 'connection_action' || proposal.tool === 'execute_code') {
        if (!this.secrets)
          throw new AppError(
            503,
            'CAPABILITY_KEY_UNAVAILABLE',
            'Configure encryption before enabling external execution.',
          );
        const expiresAt = new Date(Date.now() + 60000).toISOString();
        const capability = JSON.stringify({
          workspaceId: run.workspace_id,
          runId: run.id,
          invocationId: action.id,
          digest: action.action_digest,
          expiresAt,
          nonce: randomUUID() + randomUUID(),
        });
        await tx.query(
          `INSERT INTO tool_actions(workspace_id,invocation_id,capability_hash,capability_expires_at,encrypted_capability) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,invocation_id) DO NOTHING`,
          [
            run.workspace_id,
            action.id,
            secretDigest(capability),
            expiresAt,
            this.secrets.seal('tool-capability:' + run.workspace_id + ':' + action.id, capability),
          ],
        );
        await tx.query("UPDATE tool_invocations SET status='executing' WHERE id=$1", [action.id]);
        return;
      }
      if (proposal.tool === 'read_tasks' || proposal.tool === 'read_knowledge') {
        const rows =
          proposal.tool === 'read_tasks'
            ? await tx.query(
                'SELECT id,title,state FROM tasks WHERE workspace_id=$1 AND conversation_id=$2 AND resource_visible_to(workspace_id,conversation_id,created_at,$4) AND resource_visible_to(workspace_id,conversation_id,created_at,$5) AND title ILIKE $3 ORDER BY created_at DESC,id DESC LIMIT 20',
                [
                  run.workspace_id,
                  run.conversation_id,
                  '%' + proposal.parameters.query.replace(/[\\%_]/g, '\\$&') + '%',
                  requester.membershipId,
                  agent.membershipId,
                ],
              )
            : await tx.query(
                "SELECT k.id,k.title,left(k.body,1000) body,k.version FROM knowledge_pages k JOIN knowledge_metadata m ON m.workspace_id=k.workspace_id AND m.page_id=k.id WHERE k.workspace_id=$1 AND k.conversation_id=$2 AND m.state='active' AND NOT m.blocked AND knowledge_lineage_visible(k.workspace_id,k.id,$4) AND knowledge_lineage_visible(k.workspace_id,k.id,$5) AND m.superseded_by IS NULL AND m.review_state NOT IN ('stale','contradicted') AND resource_visible_to(k.workspace_id,k.conversation_id,k.created_at,$4) AND resource_visible_to(k.workspace_id,k.conversation_id,k.created_at,$5) AND k.title ILIKE $3 ORDER BY k.updated_at DESC,k.id DESC LIMIT 20",
                [
                  run.workspace_id,
                  run.conversation_id,
                  '%' + proposal.parameters.query.replace(/[\\%_]/g, '\\$&') + '%',
                  requester.membershipId,
                  agent.membershipId,
                ],
              );
        await tx.query("UPDATE tool_invocations SET status='succeeded',result=$1 WHERE id=$2", [
          JSON.stringify({ items: rows }),
          action.id,
        ]);
        await recordChange(tx, agent, 'tool.' + proposal.tool, action.id, run.conversation_id);
        await settleRun(tx, run);
        return;
      }
      const resourceId = randomUUID();
      if (proposal.tool === 'interactive_form') {
        await tx.query(
          'INSERT INTO tool_forms(id,workspace_id,conversation_id,invocation_id,title,description,fields) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            resourceId,
            run.workspace_id,
            run.conversation_id,
            action.id,
            proposal.parameters.title,
            proposal.parameters.description,
            proposal.parameters.fields,
          ],
        );
      } else if (proposal.tool === 'delegate_agent') {
        const delegated = await delegateRun(tx, requester, run.id, {
          ...proposal.parameters,
          requestKey: action.id,
        });
        await tx.query("UPDATE tool_invocations SET status='succeeded',result=$1 WHERE id=$2", [
          JSON.stringify({ resourceId: delegated.id }),
          action.id,
        ]);
        await recordChange(tx, agent, 'tool.delegate_agent', delegated.id, run.conversation_id);
        await settleRun(tx, run);
        return;
      } else if (proposal.tool === 'create_task') {
        const input = proposal.parameters;
        await tx.query(
          'INSERT INTO tasks(id,workspace_id,conversation_id,title,description,priority,assignee_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
          [
            resourceId,
            run.workspace_id,
            run.conversation_id,
            input.title,
            input.description,
            input.priority,
            agent.membershipId,
          ],
        );
      } else if (proposal.tool === 'save_knowledge') {
        const input = proposal.parameters;
        await tx.query(
          'INSERT INTO knowledge_pages(id,workspace_id,conversation_id,title,body,author_id) VALUES($1,$2,$3,$4,$5,$6)',
          [
            resourceId,
            run.workspace_id,
            run.conversation_id,
            input.title,
            input.body,
            agent.membershipId,
          ],
        );
        await tx.query(
          'INSERT INTO knowledge_versions(id,page_id,title,body,version,author_id,workspace_id) VALUES($1,$2,$3,$4,1,$5,$6)',
          [randomUUID(), resourceId, input.title, input.body, agent.membershipId, run.workspace_id],
        );
      }
      await tx.query("UPDATE tool_invocations SET status='succeeded',result=$1 WHERE id=$2", [
        JSON.stringify({ resourceId }),
        action.id,
      ]);
      await recordChange(tx, agent, 'tool.' + proposal.tool, resourceId, run.conversation_id);
      await settleRun(tx, run);
    });
  }
}

export async function validateAuthorization(
  tx: Sql,
  run: RunRow,
  action: InvocationRow,
  proposal: ToolProposal,
) {
  const current = await authorizeTool(tx, run, proposal);
  await requireRunContext(tx, run);
  const policy = await effectiveRule(tx, run.workspace_id, current.effect);
  const captured = (action.authorization_snapshot ?? {}) as Record<string, unknown>;
  if (
    policy.version !== action.policy_version ||
    (Object.keys(captured).length && canonical(current) !== canonical(captured))
  )
    throw new AppError(
      409,
      'ACTION_POLICY_CHANGED',
      'Policy or connection authorization changed. Generate and review a new action.',
    );
  if (toolRegistry[proposal.tool].version !== action.tool_version)
    throw new AppError(409, 'TOOL_VERSION_CHANGED', 'The tool implementation changed.');
  return current;
}
