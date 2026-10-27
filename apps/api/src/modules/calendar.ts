import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { identityScope, workerScope, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { id } from '@ao/contracts';
import { revision, workPage } from '@ao/contracts/workflows';
import { authenticate } from './auth.js';
import { IdentitySecrets } from '../identity/secrets.js';
import { workAuthority, workManager } from '../workflows/service.js';
import { workPrincipal, assumeWorkPrincipal } from '../workflows/authority.js';
import { taskActor, updateTask, manageTask } from '../tasks/service.js';
import { getTask } from '../tasks/queries.js';
import { workVersion } from '../tasks/work.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { calendarIcs } from '../calendar/ical.js';
import { calendarContext } from '../calendar/worker.js';
import type { CalendarProvider } from '../calendar/google.js';
export function calendarRoutes(
  app: FastifyInstance,
  db: Database,
  provider: CalendarProvider | null,
  secrets: IdentitySecrets,
  origin: string,
) {
  app.get('/v1/calendar/connections', async (req) => {
    const p = await authenticate(db, req),
      rows = await db.query(
        'SELECT id,provider,calendar_id,status,version,last_synced_at,error_code FROM calendar_connections WHERE workspace_id=$1 AND membership_id=$2 ORDER BY id',
        [p.workspaceId, p.membershipId],
      );
    return { configured: Boolean(provider), items: rows };
  });
  app.post('/v1/calendar/google/connect', async (req) => {
    const p = await authenticate(db, req);
    workManager(p, p.membershipId);
    if (!provider)
      throw new AppError(
        503,
        'CALENDAR_NOT_CONFIGURED',
        'The operator must configure Google Calendar OAuth.',
      );
    if (!req.cookies.ao_session)
      throw new AppError(403, 'SESSION_REQUIRED', 'Sign in with a browser session.');
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(48).toString('base64url'),
      key = randomUUID();
    await db.transaction(async (tx) => {
      await taskActor(tx, p);
      const authority = await workAuthority(tx, p);
      await tx.query(
        "INSERT INTO calendar_oauth_states(id,workspace_id,membership_id,state_hash,session_hash,verifier,auth_version,policy_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')",
        [
          key,
          p.workspaceId,
          p.membershipId,
          digest(state),
          digest(req.cookies.ao_session!),
          secrets.seal('calendar-oauth:' + key, verifier),
          authority.auth,
          authority.policy,
        ],
      );
    });
    return {
      url: provider.authorization(state, createHash('sha256').update(verifier).digest('base64url')),
    };
  });
  app.get('/v1/calendar/google/callback', async (req, reply) => {
    const p = await authenticate(db, req);
    workManager(p, p.membershipId);
    if (!provider)
      throw new AppError(503, 'CALENDAR_NOT_CONFIGURED', 'Calendar OAuth is unavailable.');
    const q = z
      .object({
        state: z.string().min(20).max(200),
        code: z.string().min(1).max(4096),
        scope: z.string().max(4000).optional(),
        authuser: z.string().max(100).optional(),
        prompt: z.string().max(100).optional(),
      })
      .strict()
      .parse(req.query);
    const state = await db.transaction(async (tx) => {
      const [row] = await tx.query(
        'UPDATE calendar_oauth_states SET consumed_at=now() WHERE workspace_id=$1 AND membership_id=$2 AND state_hash=$3 AND session_hash=$4 AND consumed_at IS NULL AND expires_at>now() RETURNING *',
        [p.workspaceId, p.membershipId, digest(q.state), digest(req.cookies.ao_session ?? '')],
      );
      if (!row)
        throw new AppError(
          400,
          'INVALID_OAUTH_STATE',
          'This connection request expired or was already used.',
        );
      const authority = await workAuthority(tx, p);
      if (authority.auth !== row.auth_version || authority.policy !== row.policy_version)
        throw new AppError(409, 'AUTHORITY_REVOKED', 'Start a new connection request.');
      return row;
    });
    const credentials = await provider.exchange(
      q.code,
      secrets.open('calendar-oauth:' + state.id, String(state.verifier)),
    );
    await db.transaction(async (tx) => {
      await taskActor(tx, p);
      const authority = await workAuthority(tx, p);
      if (authority.auth !== state.auth_version || authority.policy !== state.policy_version)
        throw new AppError(409, 'AUTHORITY_REVOKED', 'Start a new connection request.');
      const [old] = await tx.query(
          "SELECT id FROM calendar_connections WHERE workspace_id=$1 AND membership_id=$2 AND provider='google' FOR UPDATE",
          [p.workspaceId, p.membershipId],
        ),
        key = String(old?.id ?? randomUUID());
      await tx.query(
        "INSERT INTO calendar_connections(id,workspace_id,membership_id,credentials,auth_version,policy_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,membership_id,provider) DO UPDATE SET credentials=EXCLUDED.credentials,auth_version=EXCLUDED.auth_version,policy_version=EXCLUDED.policy_version,status='active',version=calendar_connections.version+1,sync_token=NULL,page_token=NULL,next_sync_at=now(),lease_token=NULL,lease_expires_at=NULL,error_code=NULL",
        [
          key,
          p.workspaceId,
          p.membershipId,
          secrets.seal(calendarContext(p.workspaceId, key), JSON.stringify(credentials)),
          authority.auth,
          authority.policy,
        ],
      );
      await tx.query('DELETE FROM calendar_exports WHERE workspace_id=$1 AND connection_id=$2', [
        p.workspaceId,
        key,
      ]);
    });
    return reply.redirect(origin + '/app?calendar=connected');
  });
  app.post('/v1/calendar/connections/:id/sync', async (req) => {
    const p = await authenticate(db, req),
      key = id.parse((req.params as { id: string }).id);
    const [row] = await db.query(
      "UPDATE calendar_connections SET next_sync_at=now() WHERE workspace_id=$1 AND id=$2 AND membership_id=$3 AND status='active' RETURNING id",
      [p.workspaceId, key, p.membershipId],
    );
    if (!row) throw notFound();
    return { ok: true };
  });
  app.delete('/v1/calendar/connections/:id', async (req) => {
    const p = await authenticate(db, req),
      key = id.parse((req.params as { id: string }).id),
      input = z.object({ version: revision }).strict().parse(req.body);
    const [row] = await db.query(
      "UPDATE calendar_connections SET status='disconnected',credentials='',lease_token=NULL,lease_expires_at=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2 AND membership_id=$3 AND version=$4 RETURNING id",
      [p.workspaceId, key, p.membershipId, input.version],
    );
    if (!row)
      throw new AppError(409, 'VERSION_CONFLICT', 'Refresh this connection before disconnecting.');
    return { ok: true };
  });
  app.get('/v1/calendar/conflicts', async (req) => {
    const p = await authenticate(db, req),
      q = workPage.parse(req.query),
      rows = await db.query(
        "SELECT e.task_id id,e.connection_id,e.remote,t.title,t.version,to_char(t.due_date,'YYYY-MM-DD') due_date FROM calendar_exports e JOIN tasks t ON t.workspace_id=e.workspace_id AND t.id=e.task_id WHERE e.workspace_id=$1 AND e.status='conflict' AND ($2::uuid IS NULL OR e.task_id>$2) ORDER BY e.task_id LIMIT $3",
        [p.workspaceId, q.after ?? null, q.limit + 1],
      ),
      items = rows.slice(0, q.limit);
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.post('/v1/calendar/conflicts/:id', async (req) => {
    let p = await authenticate(db, req);
    const key = id.parse((req.params as { id: string }).id),
      input = z
        .object({
          connectionId: id,
          version: revision,
          resolution: z.enum(['local', 'remote', 'unlink']),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      p = await taskActor(tx, p);
      const [connection] = await tx.query(
        'SELECT id,lease_expires_at FROM calendar_connections WHERE workspace_id=$1 AND id=$2 AND membership_id=$3 FOR UPDATE',
        [p.workspaceId, input.connectionId, p.membershipId],
      );
      if (!connection) throw notFound();
      if (
        connection.lease_expires_at &&
        new Date(String(connection.lease_expires_at)).getTime() > Date.now()
      )
        throw new AppError(
          409,
          'CALENDAR_SYNC_BUSY',
          'Wait for the current sync before resolving this conflict.',
        );
      const task = await getTask(tx, p, key, true);
      manageTask(p, task);
      workVersion(task.version, input.version);
      const [mapping] = await tx.query(
        "SELECT remote FROM calendar_exports WHERE workspace_id=$1 AND connection_id=$2 AND task_id=$3 AND status='conflict' FOR UPDATE",
        [p.workspaceId, input.connectionId, key],
      );
      if (!mapping) throw notFound();
      const remote = mapping.remote as { etag?: string; date?: string; status?: string } | null;
      if (input.resolution === 'remote') {
        if (!remote?.date || remote.status === 'cancelled')
          throw new AppError(
            400,
            'REMOTE_DATE_UNAVAILABLE',
            'The external event has no usable date. Unlink it or keep the task.',
          );
        const date = z.iso.date().parse(remote.date);
        await updateTask(tx, p, task, { version: task.version, dueDate: date });
      }
      await tx.query(
        "UPDATE calendar_exports SET status=$4,suppressed=($4='removed'),etag=$5,task_version=$6,pending_payload=NULL,pending_task_version=NULL,remote=NULL WHERE workspace_id=$1 AND connection_id=$2 AND task_id=$3",
        [
          p.workspaceId,
          input.connectionId,
          key,
          input.resolution === 'unlink' ? 'removed' : 'synced',
          remote?.etag ?? null,
          input.resolution === 'local' ? 0 : task.version + (input.resolution === 'remote' ? 1 : 0),
        ],
      );
      await tx.query(
        'UPDATE calendar_connections SET next_sync_at=now() WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, input.connectionId],
      );
      return { ok: true };
    });
  });
  app.post('/v1/calendar/feeds', async (req) => {
    const p = await authenticate(db, req);
    workManager(p, p.membershipId);
    const token = randomBytes(32).toString('base64url'),
      key = randomUUID();
    await db.transaction(async (tx) => {
      await taskActor(tx, p);
      const authority = await workAuthority(tx, p);
      const [active] = await tx.query(
        'SELECT count(*)::int count FROM calendar_feeds WHERE workspace_id=$1 AND membership_id=$2 AND revoked_at IS NULL AND expires_at>now()',
        [p.workspaceId, p.membershipId],
      );
      if (Number(active!.count) >= 10)
        throw new AppError(
          409,
          'CALENDAR_FEED_LIMIT',
          'Revoke an existing subscription before creating more than ten active feeds.',
        );
      await tx.query(
        "INSERT INTO calendar_feeds(id,workspace_id,membership_id,token_hash,auth_version,policy_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '90 days')",
        [key, p.workspaceId, p.membershipId, digest(token), authority.auth, authority.policy],
      );
    });
    return { id: key, url: origin + '/api/v1/calendar/feed?token=' + token };
  });
  app.get('/v1/calendar/feeds', async (req) => {
    const p = await authenticate(db, req),
      q = workPage.parse(req.query),
      rows = await db.query(
        'SELECT id,expires_at,revoked_at,created_at FROM calendar_feeds WHERE workspace_id=$1 AND membership_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',
        [p.workspaceId, p.membershipId, q.after ?? null, q.limit + 1],
      ),
      items = rows.slice(0, q.limit);
    return { items, next_after: rows.length > q.limit ? items.at(-1)!.id : null };
  });
  app.delete('/v1/calendar/feeds/:id', async (req) => {
    const p = await authenticate(db, req);
    await db.query(
      'UPDATE calendar_feeds SET revoked_at=now() WHERE workspace_id=$1 AND membership_id=$2 AND id=$3',
      [p.workspaceId, p.membershipId, id.parse((req.params as { id: string }).id)],
    );
    return { ok: true };
  });
  app.get(
    '/v1/calendar/feed',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = z
          .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .strict()
          .parse(req.query),
        [feed] = await identityScope(() =>
          db.query('SELECT * FROM calendar_feed_identity($1)', [digest(q.token)]),
        );
      if (!feed) throw notFound();
      const ws = String(feed.workspace_id);
      return workerScope(ws, () =>
        db.transaction(async (tx) => {
          await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [ws]);
          const p = await workPrincipal(tx, ws, String(feed.membership_id), {
            auth: Number(feed.auth_version),
            policy: Number(feed.policy_version),
          });
          await assumeWorkPrincipal(tx, p);
          const tasks = await tx.query(
            "SELECT id,title,state,version,updated_at,to_char(due_date,'YYYY-MM-DD') due_date FROM tasks WHERE workspace_id=$1 AND assignee_id=$2 AND conversation_id IS NULL AND due_date BETWEEN (now() AT TIME ZONE 'UTC')::date-30 AND (now() AT TIME ZONE 'UTC')::date+366 ORDER BY due_date,id LIMIT 1001",
            [ws, p.membershipId],
          );
          if (tasks.length > 1000)
            throw new AppError(
              409,
              'CALENDAR_FEED_LIMIT',
              'Use a Google connection for more than 1,000 calendar tasks.',
            );
          return reply
            .type('text/calendar; charset=utf-8')
            .header('content-disposition', 'inline; filename="orbit-tasks.ics"')
            .send(calendarIcs(ws, tasks));
        }),
      );
    },
  );
}
