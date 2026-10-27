import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { id, runInput, approvalInput } from '@ao/contracts';
import { authenticate } from './auth.js';
import { AppError } from '../lib/errors.js';
import { enqueueRun, cancelRun, reconcileRun } from '../execution/runs.js';
import { toolRegistry } from '../tools/registry.js';
import { ToolGateway } from '../execution/gateway.js';
import type { HostedRuntime } from '../execution/types.js';
export function executionRoutes(app: FastifyInstance, db: Database, runtime: HostedRuntime) {
  app.get('/v1/execution/capabilities', async (req) => {
    await authenticate(db, req);
    return {
      hostedRuntime: runtime.configured,
      tools: Object.keys(toolRegistry),
      approvalPolicy: 'versioned_workspace_policy',
      toolVersion: 1,
      runtime: runtime.capabilities ?? {
        durableCheckpoints: false,
        resumeObservation: false,
        maxSeconds: 300,
      },
    };
  });
  app.post('/v1/runs', async (req, reply) => {
    const p = await authenticate(db, req),
      input = runInput.parse(req.body);
    if (!runtime.configured)
      throw new AppError(
        503,
        'RUNTIME_UNAVAILABLE',
        'Hosted execution is not configured. Ask your operator to connect the managed runtime.',
      );
    const result = await db.transaction((tx) => enqueueRun(tx, p, input));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.get('/v1/runs', async (req) => {
    const p = await authenticate(db, req);
    return db.query(
      `SELECT r.id,r.prompt,r.status,r.error_code,r.created_at,r.updated_at,r.conversation_id,m.name agent_name,c.name channel_name FROM agent_runs r JOIN agents a ON a.id=r.agent_id JOIN memberships m ON m.id=a.membership_id JOIN conversations c ON c.id=r.conversation_id WHERE r.workspace_id=$1 AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.membership_id=$2)) ORDER BY r.created_at DESC LIMIT 100`,
      [p.workspaceId, p.membershipId],
    );
  });
  app.get('/v1/runs/:id', async (req) => {
    const p = await authenticate(db, req),
      runId = id.parse((req.params as { id: string }).id);
    const [run] = await db.query(
      "SELECT r.id,r.prompt,r.status,r.error_code,r.created_at,r.updated_at,r.conversation_id,m.name agent_name,CASE WHEN c.kind='group' THEN c.title ELSE c.name END channel_name FROM agent_runs r JOIN agents a ON a.workspace_id=r.workspace_id AND a.id=r.agent_id JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id JOIN conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id WHERE r.workspace_id=$1 AND r.id=$2",
      [p.workspaceId, runId],
    );
    if (!run) throw new AppError(404, 'NOT_FOUND', 'The run is unavailable.');
    return run;
  });
  app.post('/v1/runs/:id/cancel', async (req) =>
    cancelRun(
      db,
      runtime,
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
    ),
  );
  app.post('/v1/runs/:id/reconcile', async (req) =>
    reconcileRun(
      db,
      runtime,
      await authenticate(db, req),
      id.parse((req.params as { id: string }).id),
    ),
  );
  app.get('/v1/approvals', async (req) => {
    const p = await authenticate(db, req);
    return db.query(
      `SELECT t.id,t.run_id,t.tool_name,t.parameters,t.action_digest,t.authorization_snapshot,t.status,t.expires_at,t.result,t.error_code,m.name agent_name,c.name channel_name FROM tool_invocations t JOIN agent_runs r ON r.id=t.run_id JOIN agents a ON a.id=r.agent_id JOIN memberships m ON m.id=a.membership_id JOIN conversations c ON c.id=r.conversation_id WHERE t.workspace_id=$1 AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.membership_id=$2)) ORDER BY t.created_at DESC LIMIT 100`,
      [p.workspaceId, p.membershipId],
    );
  });
  app.post('/v1/approvals/:id/decisions', async (req) => {
    const p = await authenticate(db, req),
      actionId = id.parse((req.params as { id: string }).id),
      input = approvalInput.parse(req.body);
    return new ToolGateway(db).decide(p, actionId, input.decision, input.digest, input.reason);
  });
}
