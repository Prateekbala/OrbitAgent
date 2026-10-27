import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { z } from 'zod';
import { id } from '@ao/contracts';
import {
  draftInput,
  scheduleInput,
  scheduleUpdate,
  sidebarInput,
  personalListQuery,
} from '@ao/contracts/personal';
import { authenticate } from './auth.js';
import {
  personalAuthority,
  contentReferences,
  setMessagePreference,
  futureSendTime,
  personalEvent,
} from '../messaging/personal.js';
import { pageBoundary, pageResult } from '../messaging/pagination.js';
import { AppError, notFound } from '../lib/errors.js';
import { digest } from '../lib/security.js';
import { requireConversation } from '../lib/policy.js';
export function personalMessagingRoutes(app: FastifyInstance, db: Database) {
  for (const [suffix, kind] of [
    ['saved', 'save'],
    ['pin', 'pin'],
    ['follow', 'follow'],
  ] as const)
    for (const method of ['PUT', 'DELETE'] as const)
      app.route({
        method,
        url: `/v1/messages/:id/${suffix}`,
        handler: async (req) => {
          const p = await authenticate(db, req),
            message = id.parse((req.params as { id: string }).id);
          return db.transaction((tx) =>
            setMessagePreference(tx, p, message, kind, method === 'PUT'),
          );
        },
      });
  for (const kind of ['saved-messages', 'followed-threads', 'pins'] as const)
    app.get(kind === 'pins' ? '/v1/conversations/:id/pins' : `/v1/${kind}`, async (req) => {
      const p = await authenticate(db, req),
        q = personalListQuery.parse(req.query),
        conversation = kind === 'pins' ? id.parse((req.params as { id: string }).id) : null,
        scope = kind + ':' + (conversation ?? ''),
        boundary = pageBoundary(p, scope, q.after);
      return db.transaction(async (tx) => {
        await personalAuthority(tx, p, conversation ?? undefined);
        const table =
          kind === 'pins'
            ? 'message_pins'
            : kind === 'saved-messages'
              ? 'saved_messages'
              : 'thread_followers';
        const rows = await tx.query(
          `SELECT pref.message_id id,pref.message_id,m.conversation_id,m.thread_id,m.body,m.format,a.name author_name,pref.created_at,to_char(pref.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') position_time FROM ${table} pref JOIN messages m ON m.workspace_id=pref.workspace_id AND m.id=pref.message_id JOIN memberships a ON a.workspace_id=m.workspace_id AND a.id=m.author_id WHERE pref.workspace_id=$1 AND ${kind === 'pins' ? 'pref.conversation_id=$2' : 'pref.membership_id=$2'} ${kind === 'followed-threads' ? 'AND pref.following' : ''} AND m.deleted_at IS NULL AND ($3::timestamptz IS NULL OR (pref.created_at,pref.message_id)<($3::timestamptz,$4::uuid)) ORDER BY pref.created_at DESC,pref.message_id DESC LIMIT $5`,
          [
            p.workspaceId,
            conversation ?? p.membershipId,
            boundary?.at ?? null,
            boundary?.id ?? null,
            q.limit + 1,
          ],
        );
        return pageResult(p, scope, rows, q.limit);
      });
    });
  app.get('/v1/conversations/:id/draft', async (req) => {
    const p = await authenticate(db, req),
      conversation = id.parse((req.params as { id: string }).id),
      q = z.object({ threadId: id.optional() }).parse(req.query);
    return db.transaction(async (tx) => {
      await personalAuthority(tx, p, conversation);
      const [row] = await tx.query(
        'SELECT id,conversation_id,thread_id,body,format,attachment_ids "attachmentIds",mention_ids "mentionIds",version,updated_at FROM message_drafts WHERE workspace_id=$1 AND membership_id=$2 AND conversation_id=$3 AND thread_id IS NOT DISTINCT FROM $4::uuid',
        [p.workspaceId, p.membershipId, conversation, q.threadId ?? null],
      );
      return (
        row ?? {
          body: '',
          format: 'markdown',
          attachmentIds: [],
          mentionIds: [],
          version: 0,
          conversation_id: conversation,
          thread_id: q.threadId ?? null,
        }
      );
    });
  });
  app.put('/v1/conversations/:id/draft', async (req) => {
    const p = await authenticate(db, req),
      conversation = id.parse((req.params as { id: string }).id),
      input = draftInput.parse(req.body);
    return db.transaction(async (tx) => {
      await personalAuthority(tx, p, conversation, false, 'update');
      await contentReferences(tx, p, conversation, input);
      await tx.query('SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
        p.workspaceId,
        conversation,
      ]);
      const [current] = await tx.query(
        'SELECT version FROM message_drafts WHERE workspace_id=$1 AND membership_id=$2 AND conversation_id=$3 AND thread_id IS NOT DISTINCT FROM $4::uuid',
        [p.workspaceId, p.membershipId, conversation, input.threadId ?? null],
      );
      if (Number(current?.version ?? 0) !== input.version)
        throw new AppError(
          409,
          'DRAFT_CONFLICT',
          'This draft changed on another device. Review the saved draft before replacing it.',
        );
      const [row] = await tx.query(
        'INSERT INTO message_drafts(workspace_id,membership_id,conversation_id,thread_id,body,format,attachment_ids,mention_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,membership_id,conversation_id,thread_id) DO UPDATE SET body=EXCLUDED.body,format=EXCLUDED.format,attachment_ids=EXCLUDED.attachment_ids,mention_ids=EXCLUDED.mention_ids,version=message_drafts.version+1,updated_at=now() RETURNING version,updated_at',
        [
          p.workspaceId,
          p.membershipId,
          conversation,
          input.threadId ?? null,
          input.body,
          input.format,
          input.attachmentIds,
          input.mentionIds,
        ],
      );
      return row;
    });
  });
  app.get('/v1/drafts', async (req) => {
    const p = await authenticate(db, req),
      q = personalListQuery.parse(req.query),
      b = pageBoundary(p, 'drafts', q.after);
    await personalAuthority(db, p);
    const rows = await db.query(
      "SELECT d.id,d.conversation_id,d.thread_id,d.body,d.format,d.updated_at created_at,to_char(d.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') position_time FROM message_drafts d WHERE d.workspace_id=$1 AND d.membership_id=$2 AND (d.body<>'' OR cardinality(d.attachment_ids)>0) AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=d.conversation_id AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.membership_id=$2))) AND ($3::timestamptz IS NULL OR (d.updated_at,d.id)<($3::timestamptz,$4::uuid)) ORDER BY d.updated_at DESC,d.id DESC LIMIT $5",
      [p.workspaceId, p.membershipId, b?.at ?? null, b?.id ?? null, q.limit + 1],
    );
    return pageResult(p, 'drafts', rows, q.limit);
  });
  app.get('/v1/scheduled-messages', async (req) => {
    const p = await authenticate(db, req),
      q = personalListQuery.parse(req.query),
      b = pageBoundary(p, 'scheduled', q.after);
    await personalAuthority(db, p);
    const rows = await db.query(
      `SELECT id,conversation_id,thread_id,body,format,send_at,status,error_code,version,message_id,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') position_time FROM scheduled_messages WHERE workspace_id=$1 AND membership_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,
      [p.workspaceId, p.membershipId, b?.at ?? null, b?.id ?? null, q.limit + 1],
    );
    return pageResult(p, 'scheduled', rows, q.limit);
  });
  app.post('/v1/conversations/:id/scheduled-messages', async (req, reply) => {
    const p = await authenticate(db, req),
      conversation = id.parse((req.params as { id: string }).id),
      input = scheduleInput.parse(req.body),
      sendAt = new Date(input.sendAt),
      hash = digest(JSON.stringify({ ...input, sendAt: sendAt.toISOString() }));
    if (input.expectedAuthorId && input.expectedAuthorId !== p.membershipId)
      throw new AppError(
        409,
        'SENDING_IDENTITY_CHANGED',
        'Use the account that queued this message.',
      );
    const result = await db.transaction(async (tx) => {
      await personalAuthority(tx, p, conversation, true, 'update');
      if (input.expectedMembershipVersion !== undefined) {
        const [member] = await tx.query(
          'SELECT version FROM memberships WHERE workspace_id=$1 AND id=$2',
          [p.workspaceId, p.membershipId],
        );
        if (member?.version !== input.expectedMembershipVersion)
          throw new AppError(
            409,
            'SENDING_AUTHORITY_CHANGED',
            'Review queued messages after a membership change.',
          );
      }
      if (input.expectedAccessInterval !== undefined) {
        const [interval] = await tx.query(
          'SELECT id FROM conversation_membership_intervals WHERE workspace_id=$1 AND conversation_id=$2 AND membership_id=$3 AND left_at IS NULL',
          [p.workspaceId, conversation, p.membershipId],
        );
        if ((interval?.id ?? null) !== input.expectedAccessInterval)
          throw new AppError(
            409,
            'SENDING_AUTHORITY_CHANGED',
            'Review queued messages after a conversation grant changes.',
          );
      }
      await tx.query('SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
        p.workspaceId,
        conversation,
      ]);
      const [existing] = await tx.query(
        'SELECT id,request_hash,conversation_id FROM scheduled_messages WHERE workspace_id=$1 AND membership_id=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (existing) {
        if (existing.request_hash !== hash || existing.conversation_id !== conversation)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This request ID was used for another scheduled message.',
          );
        return { id: existing.id, replayed: true };
      }
      futureSendTime(input.sendAt);
      const [queued] = await tx.query(
        "SELECT count(*)::int count FROM scheduled_messages WHERE workspace_id=$1 AND membership_id=$2 AND status='scheduled'",
        [p.workspaceId, p.membershipId],
      );
      if (Number(queued?.count) >= 1000)
        throw new AppError(
          429,
          'SCHEDULE_LIMIT',
          'This account already has 1,000 scheduled messages.',
        );
      if (!input.body && !input.attachmentIds.length)
        throw new AppError(400, 'EMPTY_MESSAGE', 'Add text or an attachment.');
      await contentReferences(tx, p, conversation, input);
      if (input.attachmentIds.length) {
        const [held] = await tx.query(
          "SELECT sf.file_id FROM scheduled_message_files sf JOIN scheduled_messages s ON s.workspace_id=sf.workspace_id AND s.id=sf.schedule_id WHERE sf.workspace_id=$1 AND sf.file_id=ANY($2::uuid[]) AND s.status='scheduled' LIMIT 1",
          [p.workspaceId, input.attachmentIds],
        );
        if (held)
          throw new AppError(
            409,
            'ATTACHMENT_RESERVED',
            'A file is reserved by another scheduled message. Upload a separate copy.',
          );
      }
      const [authority] = await tx.query('SELECT * FROM member_account_authority($1,$2)', [
        p.workspaceId,
        p.membershipId,
      ]);
      const [policy] = await tx.query('SELECT public.workspace_policy_version($1) version', [
        p.workspaceId,
      ]);
      const schedule = randomUUID();
      await tx.query(
        'INSERT INTO scheduled_messages(id,workspace_id,membership_id,conversation_id,thread_id,client_id,body,format,attachment_ids,mention_ids,send_at,auth_version,request_hash,organization_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          schedule,
          p.workspaceId,
          p.membershipId,
          conversation,
          input.threadId ?? null,
          input.clientId,
          input.body,
          input.format,
          input.attachmentIds,
          input.mentionIds,
          sendAt,
          authority?.auth_version,
          hash,
          policy?.version,
        ],
      );
      for (const file of input.attachmentIds) {
        await tx.query(
          'INSERT INTO scheduled_message_files(workspace_id,schedule_id,file_id) VALUES($1,$2,$3)',
          [p.workspaceId, schedule, file],
        );
        await tx.query(
          "UPDATE files SET expires_at=greatest(now()+interval '1 day',$3::timestamptz+interval '1 day') WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, file, sendAt],
        );
      }
      await personalEvent(tx, p);
      return { id: schedule, replayed: false };
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.patch('/v1/scheduled-messages/:id', async (req) => {
    const p = await authenticate(db, req),
      schedule = id.parse((req.params as { id: string }).id),
      input = scheduleUpdate.parse(req.body);
    return db.transaction(async (tx) => {
      await personalAuthority(tx, p);
      const [reference] = await tx.query(
        'SELECT conversation_id FROM scheduled_messages WHERE workspace_id=$1 AND id=$2 AND membership_id=$3',
        [p.workspaceId, schedule, p.membershipId],
      );
      if (!reference) throw notFound();
      await requireConversation(tx, p, String(reference.conversation_id), true);
      const [current] = await tx.query(
        'SELECT version,status FROM scheduled_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [p.workspaceId, schedule],
      );
      if (current?.version !== input.version || current.status !== 'scheduled')
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'This scheduled message changed or was already delivered.',
        );
      const time = input.sendAt ? futureSendTime(input.sendAt) : null;
      await tx.query(
        "UPDATE scheduled_messages SET send_at=coalesce($3,send_at),status=CASE WHEN $4 THEN 'cancelled' ELSE status END,version=version+1 WHERE workspace_id=$1 AND id=$2",
        [p.workspaceId, schedule, time, !!input.cancel],
      );
      if (time)
        await tx.query(
          "UPDATE files SET expires_at=greatest(now()+interval '1 day',$3::timestamptz+interval '1 day') WHERE workspace_id=$1 AND id IN (SELECT file_id FROM scheduled_message_files WHERE workspace_id=$1 AND schedule_id=$2)",
          [p.workspaceId, schedule, time],
        );
      if (input.cancel)
        await tx.query(
          "UPDATE files SET expires_at=least(expires_at,now()+interval '1 day') WHERE workspace_id=$1 AND id IN (SELECT file_id FROM scheduled_message_files WHERE workspace_id=$1 AND schedule_id=$2)",
          [p.workspaceId, schedule],
        );
      await personalEvent(tx, p);
      return { ok: true };
    });
  });
  app.get('/v1/sidebar', async (req) => {
    const p = await authenticate(db, req);
    await personalAuthority(db, p);
    const [row] = await db.query(
      'SELECT sections,hidden_ids "hiddenIds",version FROM personal_sidebars WHERE workspace_id=$1 AND membership_id=$2',
      [p.workspaceId, p.membershipId],
    );
    return row ?? { sections: [], hiddenIds: [], version: 0 };
  });
  app.put('/v1/sidebar', async (req) => {
    const p = await authenticate(db, req),
      input = sidebarInput.parse(req.body);
    return db.transaction(async (tx) => {
      await personalAuthority(tx, p);
      for (const conversation of new Set([
        ...input.sections.flatMap((s) => s.conversationIds),
        ...input.hiddenIds,
      ]))
        await requireConversation(tx, p, conversation);
      const [row] = await tx.query(
        'INSERT INTO personal_sidebars(workspace_id,membership_id,sections,hidden_ids,version) SELECT $1,$2,$3,$4,1 WHERE $5=0 ON CONFLICT(workspace_id,membership_id) DO UPDATE SET sections=$3,hidden_ids=$4,version=personal_sidebars.version+1 WHERE personal_sidebars.version=$5 RETURNING version',
        [
          p.workspaceId,
          p.membershipId,
          JSON.stringify(input.sections),
          input.hiddenIds,
          input.version,
        ],
      );
      if (!row && input.version > 0) {
        const [updated] = await tx.query(
          'UPDATE personal_sidebars SET sections=$3,hidden_ids=$4,version=version+1 WHERE workspace_id=$1 AND membership_id=$2 AND version=$5 RETURNING version',
          [
            p.workspaceId,
            p.membershipId,
            JSON.stringify(input.sections),
            input.hiddenIds,
            input.version,
          ],
        );
        if (updated) {
          await personalEvent(tx, p);
          return updated;
        }
      }
      if (!row)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Sidebar preferences changed. Reload them before saving.',
        );
      await personalEvent(tx, p);
      return row;
    });
  });
}
