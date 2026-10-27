import { hasPermission } from '../identity/authorization.js';
import { sharedExport } from '../interoperability/shared-export.js';
import { sharedFileRoutes } from '../interoperability/shared-files.js';
import { currentSession } from '../identity/security.js';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '@ao/database';
import { id, messageInput, messageEdit, messageReaction, fileInput } from '@ao/contracts';
import {
  migrationCreate,
  migrationMappings,
  migrationBatch,
  migrationControl,
  migrationResolve,
  sharedInvite,
  sharedAccept,
  sharedParticipants,
} from '@ao/contracts/interoperability';
import { authenticate } from './auth.js';
import { ImportService } from '../interoperability/imports.js';
import { SharedChannelService } from '../interoperability/shared.js';
import { MigrationRelay } from '../interoperability/relay.js';
import { IdentitySecrets } from '../identity/secrets.js';
import { normalizePage } from '../interoperability/adapters.js';
import { MessageService, listMessages } from '../messaging/service.js';
import { sendMessage } from '../messaging/send.js';
import { FileService } from '../files/service.js';
import type { FileDependencies } from '../files/config.js';
import { WorkspaceExport } from '../interoperability/exports.js';
import { archiveStream } from '../interoperability/archive.js';
import { AppError } from '../lib/errors.js';
export function interoperabilityRoutes(
  app: FastifyInstance,
  db: Database,
  secrets: IdentitySecrets,
  files?: FileDependencies,
) {
  const browser = async (req: FastifyRequest) => {
    await currentSession(db, req);
    return authenticate(db, req);
  };
  const imports = new ImportService(db),
    shared = new SharedChannelService(db),
    relay = new MigrationRelay(db, secrets),
    exports = new WorkspaceExport(db, files);
  const param = (params: unknown) => id.parse((params as { id: string }).id);
  app.get('/v1/migrations', async (req) => imports.list(await browser(req)));
  app.post('/v1/migrations', async (req, reply) =>
    reply.code(201).send(await imports.create(await browser(req), migrationCreate.parse(req.body))),
  );
  app.get('/v1/migrations/:id', async (req) =>
    imports.report(await browser(req), param(req.params)),
  );
  app.put('/v1/migrations/:id/mappings', async (req) =>
    imports.mappings(await browser(req), param(req.params), migrationMappings.parse(req.body)),
  );
  app.post('/v1/migrations/:id/batches', async (req) =>
    imports.stage(await browser(req), param(req.params), migrationBatch.parse(req.body)),
  );
  app.post('/v1/migrations/:id/control', async (req) => {
    const p = await browser(req),
      input = migrationControl.parse(req.body);
    return imports.control(p, param(req.params), input.version, input.action);
  });
  app.post('/v1/migrations/:id/preflight', async (req) =>
    imports.preflight(await browser(req), param(req.params)),
  );
  app.post('/v1/migrations/:id/process', async (req) =>
    imports.process(await browser(req), param(req.params)),
  );
  app.get('/v1/migrations/:id/deliveries', async (req) =>
    relay.history(await browser(req), param(req.params)),
  );
  app.post('/v1/migrations/:id/deliveries/:delivery/reconcile', async (req) => {
    const p = await browser(req),
      q = z.object({ id, delivery: id }).parse(req.params),
      input = z
        .object({
          version: z.number().int().positive(),
          outcome: z.enum(['completed', 'retry', 'cancelled']),
          externalId: z.string().min(1).max(200).optional(),
          confirmedNotApplied: z.boolean().optional(),
          evidence: z.string().trim().min(10).max(2000),
        })
        .strict()
        .parse(req.body);
    return relay.reconcile(p, q.id, q.delivery, input);
  });
  app.post('/v1/migrations/:id/relay-secret', async (req) =>
    relay.rotate(await browser(req), param(req.params)),
  );
  app.post('/v1/migrations/:id/records/:record/resolve', async (req) => {
    const p = await browser(req),
      q = z.object({ id, record: id }).parse(req.params),
      input = migrationResolve.parse(req.body);
    return imports.resolve(p, q.id, q.record, input.version, input.action);
  });
  app.post('/v1/migration-normalize', async (req) => {
    await exports.authorize(await browser(req));
    const input = z
      .object({
        provider: z.enum(['slack', 'teams', 'discord']),
        channelId: z.string().min(1).max(200),
        messages: z.array(z.unknown()).max(100),
      })
      .strict()
      .parse(req.body);
    return { records: normalizePage(input.provider, input.channelId, input.messages) };
  });
  app.get('/v1/workspace-export', async (req, reply) => {
    const p = await browser(req);
    await exports.authorize(p);
    reply
      .header('content-type', 'application/x-tar')
      .header('content-disposition', 'attachment; filename="orbit-workspace.tar"')
      .header('x-content-type-options', 'nosniff');
    return reply.send(archiveStream(exports.entries(p)));
  });
  relay.routes(app);
  sharedFileRoutes(app, db, shared, files);
  app.get('/v1/shared-channels', async (req) => shared.list(await browser(req)));
  app.post('/v1/shared-channels/invitations', async (req, reply) =>
    reply.code(201).send(await shared.invite(await browser(req), sharedInvite.parse(req.body))),
  );
  app.post('/v1/shared-channels/preview', async (req) => {
    const p = await browser(req);
    return shared.preview(
      p,
      z
        .object({ token: z.string().min(40).max(100) })
        .strict()
        .parse(req.body).token,
    );
  });
  app.post('/v1/shared-channels/accept', async (req) =>
    shared.accept(await browser(req), sharedAccept.parse(req.body)),
  );
  app.get('/v1/shared-channels/:id/participants', async (req) =>
    shared.participantList(await browser(req), param(req.params)),
  );
  app.put('/v1/shared-channels/:id/participants', async (req) => {
    const p = await browser(req),
      input = sharedParticipants.parse(req.body);
    return shared.participants(p, param(req.params), input.membershipIds, input.version);
  });
  app.post('/v1/shared-channels/:id/revoke', async (req) => {
    const p = await browser(req),
      input = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    return shared.revoke(p, param(req.params), input.version);
  });
  app.get('/v1/shared-channels/:id/messages', async (req) => {
    const p = await browser(req),
      q = z
        .object({ before: z.coerce.number().int().positive().optional(), threadId: id.optional() })
        .parse(req.query);
    return shared.inChannel(p, param(req.params), false, (guest, c) =>
      listMessages(db, guest, c, q.threadId ?? null, q.before ?? null),
    );
  });
  app.post('/v1/shared-channels/:id/messages', async (req, reply) => {
    const p = await browser(req),
      input = messageInput.parse(req.body);
    return reply
      .code(201)
      .send(
        await shared.inChannel(p, param(req.params), true, (guest, c) =>
          db.transaction((tx) => sendMessage(tx, guest, c, input)),
        ),
      );
  });
  app.patch('/v1/shared-channels/:id/messages/:message', async (req) => {
    const p = await browser(req),
      q = z.object({ id, message: id }).parse(req.params),
      input = messageEdit.parse(req.body);
    return shared.inChannel(p, q.id, true, async (guest, c) => {
      const [m] = await db.query(
        'SELECT conversation_id FROM messages WHERE workspace_id=$1 AND id=$2',
        [guest.workspaceId, q.message],
      );
      if (m?.conversation_id !== c) throw new AppError(404, 'NOT_FOUND', 'Message is unavailable.');
      return new MessageService(db).edit(guest, q.message, input);
    });
  });
  app.put('/v1/shared-channels/:id/messages/:message/reactions', async (req) => {
    const p = await browser(req),
      q = z.object({ id, message: id }).parse(req.params),
      input = messageReaction.parse(req.body);
    return shared.inChannel(p, q.id, true, async (guest, c) => {
      const [m] = await db.query(
        'SELECT conversation_id FROM messages WHERE workspace_id=$1 AND id=$2',
        [guest.workspaceId, q.message],
      );
      if (m?.conversation_id !== c) throw new AppError(404, 'NOT_FOUND', 'Message is unavailable.');
      return new MessageService(db).react(guest, q.message, input.emoji, false);
    });
  });
  app.get('/v1/shared-channels/:id/export', async (req, reply) => {
    const p = await browser(req),
      session = await currentSession(db, req),
      grantId = param(req.params);
    if (!hasPermission(p, 'files.read'))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'File read permission is required for a complete channel export.',
      );
    await shared.inChannel(p, grantId, false, async (_guest, _c, policy) => {
      if (!policy.export)
        throw new AppError(
          403,
          'SHARED_EXPORT_DISABLED',
          'Participating organizations disabled channel exports.',
        );
    });
    reply
      .type('application/x-tar')
      .header('content-disposition', 'attachment; filename="shared-channel.tar"');
    return reply.send(archiveStream(sharedExport(db, shared, p, grantId, session.id, files)));
  });
  app.post('/v1/shared-channels/:id/files', async (req, reply) => {
    const p = await browser(req),
      input = fileInput.parse(req.body);
    if (!files) throw new AppError(503, 'FILES_UNAVAILABLE', 'File storage is unavailable.');
    if (!hasPermission(p, 'files.write'))
      throw new AppError(403, 'PERMISSION_DENIED', 'File upload permission is required.');
    return reply
      .code(201)
      .send(
        await shared.inChannel(p, param(req.params), true, (guest, c) =>
          new FileService(db, files).reserve(guest, c, input),
        ),
      );
  });
}
