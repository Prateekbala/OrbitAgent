import { requireGovernedExport } from '../governance/policy.js';
import { randomUUID } from 'node:crypto';
import { digest } from '../lib/security.js';
import type { FastifyInstance } from 'fastify';
import { workerScope, type Database, type Sql } from '@ao/database';
import { z } from 'zod';
import {
  retrievalQuery,
  answerQuery,
  memoryInput,
  memoryCorrection,
  transcriptInput,
  sourceReference,
  sourceKind,
} from '@ao/contracts/retrieval';
import { authenticate } from './auth.js';
import { requireConversation, type Identity } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordChange } from '../lib/events.js';
import { plainText } from '../retrieval/text.js';
import { RetrievalService, requireSources, type Embeddings } from '../retrieval/service.js';
import type { FileDependencies } from '../files/config.js';
import { FileService } from '../files/service.js';
import type { AnswerSynthesizer } from '../retrieval/answers.js';
const key = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
const page = z
  .object({
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export interface TextExtractor {
  readonly id: string;
  extract(input: { data: Buffer; contentType: string; signal: AbortSignal }): Promise<string>;
}
async function author(db: Sql, p: Identity) {
  const [member] = await db.query(
    "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND kind='human' AND access_type='member' AND coalesce((permissions->>'knowledge.write')::boolean,true) AND retrieval_principal_current(workspace_id,id) FOR SHARE",
    [p.workspaceId, p.membershipId],
  );
  await requireSources(db, p, []);
  if (!member)
    throw new AppError(
      403,
      'MEMORY_OWNER_REQUIRED',
      'A human member with knowledge authoring permission must manage retained memory.',
    );
}
async function memoryGraph(tx: Sql, p: Identity, sources: unknown[], target?: string) {
  const [graph] = await tx.query('SELECT memory_graph_valid($1,$2,$3) allowed', [
    p.workspaceId,
    JSON.stringify(sources),
    target ?? null,
  ]);
  if (!graph?.allowed)
    throw new AppError(
      409,
      'MEMORY_PROVENANCE_LIMIT',
      'Memory provenance must be acyclic and stay within eight levels and 128 reference paths.',
    );
}
function future(value: string, maxDays = 365) {
  const time = new Date(value).getTime();
  if (time <= Date.now() || time > Date.now() + maxDays * 86400000)
    throw new AppError(400, 'INVALID_EXPIRY', `Choose a future expiry within ${maxDays} days.`);
}
export function retrievalRoutes(
  app: FastifyInstance,
  db: Database,
  options: {
    embeddings?: Embeddings;
    files?: FileDependencies;
    extractor?: TextExtractor;
    answers?: AnswerSynthesizer;
  } = {},
) {
  const service = new RetrievalService(db, options.embeddings, options.answers);
  app.post(
    '/v1/search/retrieve',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => service.search(await authenticate(db, req), retrievalQuery.parse(req.body)),
  );
  app.post(
    '/v1/search/answer',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => service.answer(await authenticate(db, req), answerQuery.parse(req.body)),
  );
  app.post(
    '/v1/search/embeddings',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const p = await authenticate(db, req),
        input = z
          .object({ sources: z.array(sourceReference).min(1).max(20) })
          .strict()
          .parse(req.body);
      if (!options.embeddings)
        throw new AppError(
          503,
          'EMBEDDINGS_UNAVAILABLE',
          'An embedding provider is not configured.',
        );
      return db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
        await requireSources(tx, p, input.sources);
        const [epoch] = await tx.query(
          'SELECT epoch FROM retrieval_authority WHERE workspace_id=$1',
          [p.workspaceId],
        );
        for (const ref of input.sources)
          await tx.query(
            "INSERT INTO retrieval_embedding_jobs(workspace_id,member_id,credential_id,kind,source_id,source_version,epoch,model,auth_version,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,workspace_policy_version($1)) ON CONFLICT(workspace_id,member_id,credential_id,kind,source_id,source_version,model) DO UPDATE SET state='pending',next_ordinal=0,lease=NULL,lease_until=NULL,attempts=0,error_code=NULL,available_at=now(),expires_at=now()+interval '1 day',epoch=EXCLUDED.epoch,auth_version=EXCLUDED.auth_version,policy_version=EXCLUDED.policy_version",
            [
              p.workspaceId,
              p.membershipId,
              p.credentialId ?? null,
              ref.kind,
              ref.id,
              ref.version,
              epoch!.epoch,
              options.embeddings!.model,
              p.authVersion ?? null,
            ],
          );
        return { queued: true };
      });
    },
  );
  app.get('/v1/search/embeddings', async (req) => {
    const p = await authenticate(db, req);
    return db.query(
      'SELECT id,kind,source_id,source_version,model,state,next_ordinal,error_code FROM retrieval_embedding_jobs WHERE workspace_id=$1 AND member_id=$2 ORDER BY created_at DESC LIMIT 100',
      [p.workspaceId, p.membershipId],
    );
  });
  app.get('/v1/search/sources/:kind/:id', async (req) => {
    const p = await authenticate(db, req),
      params = z.object({ kind: sourceKind, id: z.uuid() }).parse(req.params),
      query = z
        .object({
          version: z.coerce.number().int().positive(),
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
        })
        .strict()
        .parse(req.query);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      await requireSources(tx, p, [{ ...params, version: query.version }]);
      const queries = {
        message: "SELECT '' title,body FROM messages WHERE workspace_id=$1 AND id=$2",
        knowledge: 'SELECT title,body FROM knowledge_pages WHERE workspace_id=$1 AND id=$2',
        task: 'SELECT title,description body FROM tasks WHERE workspace_id=$1 AND id=$2',
        file: 'SELECT f.name title,e.body FROM file_extractions e JOIN files f ON f.workspace_id=e.workspace_id AND f.id=e.file_id WHERE e.workspace_id=$1 AND e.file_id=$2',
        document: 'SELECT title,body FROM connection_resources WHERE workspace_id=$1 AND id=$2',
        transcript: 'SELECT title,body FROM retained_transcripts WHERE workspace_id=$1 AND id=$2',
        memory: 'SELECT title,body FROM agent_memories WHERE workspace_id=$1 AND id=$2',
      };
      const [source] = await tx.query(
        'SELECT title,substring(body from $3::integer+1 for 10000) body,length(body)>$3::integer+10000 has_more FROM (' +
          queries[params.kind] +
          ') source',
        [p.workspaceId, params.id, query.offset],
      );
      if (!source) throw notFound();
      return {
        id: params.id,
        kind: params.kind,
        version: query.version,
        title: source.title || params.kind,
        body: source.body,
        hasMore: source.has_more,
      };
    });
  });
  app.get('/v1/search/contexts/:id', async (req) =>
    service.inspect(await authenticate(db, req), key(req.params)),
  );
  app.get('/v1/memory', async (req) => {
    const p = await authenticate(db, req),
      q = page.parse(req.query);
    const rows = await db.query(
      'SELECT id,agent_id,owner_id,boundary,conversation_id,title,body,sources,expires_at,version,created_at FROM agent_memories WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
      [p.workspaceId, q.after ?? null, q.limit + 1],
    );
    return {
      items: rows.slice(0, q.limit),
      next_after: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
  app.post('/v1/memory', async (req, reply) => {
    const p = await authenticate(db, req),
      input = memoryInput.parse(req.body);
    future(input.expiresAt);
    const result = await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      await author(tx, p);
      await memoryGraph(tx, p, input.sources);
      await requireSources(tx, p, input.sources);
      if (input.conversationId) await requireConversation(tx, p, input.conversationId, true);
      const [agent] = await tx.query(
        "SELECT id FROM agents WHERE workspace_id=$1 AND id=$2 AND status='active'",
        [p.workspaceId, input.agentId],
      );
      if (!agent) throw notFound();
      const [row] = await tx.query(
        'INSERT INTO agent_memories(workspace_id,agent_id,owner_id,boundary,conversation_id,title,body,sources,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,version',
        [
          p.workspaceId,
          input.agentId,
          p.membershipId,
          input.boundary,
          input.conversationId ?? null,
          input.title,
          input.body,
          JSON.stringify(input.sources),
          input.expiresAt,
        ],
      );
      await tx.query(
        "INSERT INTO memory_revisions(workspace_id,memory_id,version,actor_id,title,body,sources,reason) VALUES($1,$2,1,$3,$4,$5,$6,'Created')",
        [
          p.workspaceId,
          row!.id,
          p.membershipId,
          input.title,
          input.body,
          JSON.stringify(input.sources),
        ],
      );
      await recordChange(
        tx,
        p,
        'memory.created',
        String(row!.id),
        input.conversationId,
        p.membershipId,
      );
      return row;
    });
    return reply.code(201).send(result);
  });
  app.patch('/v1/memory/:id', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = memoryCorrection.parse(req.body);
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
      await author(tx, p);
      const [old] = await tx.query(
        'SELECT * FROM agent_memories WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND version=$4 FOR UPDATE',
        [p.workspaceId, id, p.membershipId, input.version],
      );
      if (!old)
        throw new AppError(409, 'MEMORY_CHANGED', 'The memory changed or is no longer accessible.');
      if (old.release_id)
        throw new AppError(
          409,
          'RELEASE_IMMUTABLE',
          'A declassified copy requires a new source-owner approval before changing its content.',
        );
      if (input.sources.some((s) => s.kind === 'memory' && s.id === id))
        throw new AppError(400, 'MEMORY_CYCLE', 'Memory cannot cite itself.');
      const prior = z.array(sourceReference).parse(old.sources);
      if (prior.some((ref) => !input.sources.some((s) => s.kind === ref.kind && s.id === ref.id)))
        throw new AppError(
          409,
          'PROVENANCE_REQUIRED',
          'Corrections must retain source provenance. Delete the memory to remove it.',
        );
      await memoryGraph(tx, p, input.sources, id);
      await requireSources(tx, p, input.sources);
      await tx.query(
        'UPDATE agent_memories SET title=$3,body=$4,sources=$5,version=version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id, input.title, input.body, JSON.stringify(input.sources)],
      );
      await tx.query(
        'INSERT INTO memory_revisions(workspace_id,memory_id,version,actor_id,title,body,sources,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          p.workspaceId,
          id,
          input.version + 1,
          p.membershipId,
          input.title,
          input.body,
          JSON.stringify(input.sources),
          input.reason,
        ],
      );
      await recordChange(
        tx,
        p,
        'memory.corrected',
        id,
        old.conversation_id as string | undefined,
        p.membershipId,
      );
      return { id, version: input.version + 1 };
    });
  });
  app.get('/v1/memory/:id/export', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    return db.transaction(async (tx) => {
      await requireGovernedExport(tx, p.workspaceId);
      const [memory] = await tx.query(
        'SELECT * FROM agent_memories WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id],
      );
      if (!memory) throw notFound();
      await requireSources(tx, p, [{ kind: 'memory', id, version: Number(memory.version) }]);
      const revisions =
        memory.owner_id === p.membershipId
          ? await tx.query(
              'SELECT version,title,body,sources,reason,created_at FROM memory_revisions WHERE workspace_id=$1 AND memory_id=$2 ORDER BY version DESC LIMIT 100',
              [p.workspaceId, id],
            )
          : [];
      return { memory, revisions, revisionLimit: 100 };
    });
  });
  app.post('/v1/memory/:id/forward', async (req, reply) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = z
        .object({ conversationId: z.uuid(), reason: z.string().trim().min(1).max(1000) })
        .strict()
        .parse(req.body);
    return reply.code(201).send(
      await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        await author(tx, p);
        await requireConversation(tx, p, input.conversationId, true);
        const [memory] = await tx.query(
          'SELECT * FROM agent_memories WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 FOR SHARE',
          [p.workspaceId, id, p.membershipId],
        );
        if (!memory) throw notFound();
        await requireSources(tx, p, [{ kind: 'memory', id, version: Number(memory.version) }]);
        const sources = [{ kind: 'memory', id, version: memory.version }];
        await memoryGraph(tx, p, sources);
        const [copy] = await tx.query(
          "INSERT INTO agent_memories(workspace_id,agent_id,owner_id,boundary,conversation_id,title,body,sources,expires_at) VALUES($1,$2,$3,'conversation',$4,$5,$6,$7,$8) RETURNING id,version",
          [
            p.workspaceId,
            memory.agent_id,
            p.membershipId,
            input.conversationId,
            memory.title,
            memory.body,
            JSON.stringify(sources),
            memory.expires_at,
          ],
        );
        await tx.query(
          'INSERT INTO memory_revisions(workspace_id,memory_id,version,actor_id,title,body,sources,reason) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
          [
            p.workspaceId,
            copy!.id,
            p.membershipId,
            memory.title,
            memory.body,
            JSON.stringify(sources),
            input.reason,
          ],
        );
        await recordChange(
          tx,
          p,
          'memory.forwarded',
          String(copy!.id),
          input.conversationId,
          p.membershipId,
        );
        return copy;
      }),
    );
  });
  app.post('/v1/memory/:id/declassify', async (req, reply) => {
    const p = await authenticate(db, req),
      id = key(req.params),
      input = z
        .object({
          version: z.number().int().positive(),
          conversationId: z.uuid().optional(),
          reason: z.string().trim().min(10).max(1000),
          acknowledgeAudienceExpansion: z.literal(true),
        })
        .strict()
        .parse(req.body);
    return reply.code(201).send(
      await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        await author(tx, p);
        const [memory] = await tx.query(
          'SELECT * FROM agent_memories WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND version=$4 FOR SHARE',
          [p.workspaceId, id, p.membershipId, input.version],
        );
        if (!memory) throw notFound();
        await requireSources(tx, p, [{ kind: 'memory', id, version: input.version }]);
        const [owned] = await tx.query("SELECT retrieval_source_owned($1,'memory',$2,$3) allowed", [
          p.workspaceId,
          id,
          p.membershipId,
        ]);
        if (!owned?.allowed)
          throw new AppError(
            403,
            'SOURCE_OWNER_APPROVAL_REQUIRED',
            'Declassification requires ownership of every source. Forwarding preserves mixed-owner source audiences.',
          );
        if (input.conversationId) await requireConversation(tx, p, input.conversationId, true);
        const published = randomUUID(),
          release = randomUUID(),
          sources = [{ kind: 'memory', id, version: input.version }];
        await memoryGraph(tx, p, sources);
        await tx.query(
          'INSERT INTO memory_releases(id,workspace_id,source_memory_id,source_version,published_memory_id,approved_by,reason,body_hash,target_conversation_id,sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            release,
            p.workspaceId,
            id,
            input.version,
            published,
            p.membershipId,
            input.reason,
            digest(String(memory.body)),
            input.conversationId ?? null,
            JSON.stringify(sources),
          ],
        );
        await tx.query(
          'INSERT INTO agent_memories(id,workspace_id,agent_id,owner_id,boundary,conversation_id,title,body,sources,expires_at,release_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [
            published,
            p.workspaceId,
            memory.agent_id,
            p.membershipId,
            input.conversationId ? 'conversation' : 'workspace',
            input.conversationId ?? null,
            memory.title,
            memory.body,
            JSON.stringify(sources),
            memory.expires_at,
            release,
          ],
        );
        await tx.query(
          'INSERT INTO memory_revisions(workspace_id,memory_id,version,actor_id,title,body,sources,reason) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
          [
            p.workspaceId,
            published,
            p.membershipId,
            memory.title,
            memory.body,
            JSON.stringify(sources),
            input.reason,
          ],
        );
        await recordChange(tx, p, 'memory.declassified', published, input.conversationId);
        return { id: published, releaseId: release, version: 1 };
      }),
    );
  });
  app.delete('/v1/memory/:id/declassification', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    await author(db, p);
    return db.transaction(async (tx) => {
      const [row] = await tx.query(
        'UPDATE memory_releases SET revoked_at=now() WHERE workspace_id=$1 AND published_memory_id=$2 AND approved_by=$3 AND revoked_at IS NULL RETURNING id',
        [p.workspaceId, id, p.membershipId],
      );
      if (!row) throw notFound();
      await recordChange(tx, p, 'memory.declassification_revoked', id, undefined, p.membershipId);
      return { ok: true };
    });
  });
  app.delete('/v1/memory/:id', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    await author(db, p);
    return workerScope(p.workspaceId, () =>
      db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        await author(tx, p);
        const [row] = await tx.query(
          'DELETE FROM agent_memories WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 RETURNING id',
          [p.workspaceId, id, p.membershipId],
        );
        if (!row) throw notFound();
        await tx.query(
          "DELETE FROM retrieval_documents WHERE workspace_id=$1 AND kind='memory' AND source_id=$2",
          [p.workspaceId, id],
        );
        await recordChange(tx, p, 'memory.deleted', id, undefined, p.membershipId);
        return { ok: true };
      }),
    );
  });
  app.post('/v1/search/transcripts', async (req, reply) => {
    const p = await authenticate(db, req),
      input = transcriptInput.parse(req.body);
    future(input.retainedUntil);
    return reply.code(201).send(
      await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        await author(tx, p);
        await requireConversation(tx, p, input.conversationId, true);
        const [old] = await tx.query(
          'SELECT id,title,body,conversation_id FROM retained_transcripts WHERE workspace_id=$1 AND owner_id=$2 AND client_id=$3',
          [p.workspaceId, p.membershipId, input.clientId],
        );
        if (old) {
          if (
            old.title !== input.title ||
            old.body !== input.body ||
            old.conversation_id !== input.conversationId
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This import key belongs to another transcript.',
            );
          return { id: old.id };
        }
        const [row] = await tx.query(
          'INSERT INTO retained_transcripts(workspace_id,conversation_id,owner_id,client_id,title,body,language,consent_reference,retained_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
          [
            p.workspaceId,
            input.conversationId,
            p.membershipId,
            input.clientId,
            input.title,
            input.body,
            input.language,
            input.consentReference,
            input.retainedUntil,
          ],
        );
        await recordChange(tx, p, 'transcript.retained', String(row!.id), input.conversationId);
        return row;
      }),
    );
  });
  app.delete('/v1/search/transcripts/:id', async (req) => {
    const p = await authenticate(db, req),
      id = key(req.params);
    await author(db, p);
    return workerScope(p.workspaceId, () =>
      db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        await author(tx, p);
        const [row] = await tx.query(
          'DELETE FROM retained_transcripts WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 RETURNING id',
          [p.workspaceId, id, p.membershipId],
        );
        if (!row) throw notFound();
        await tx.query(
          "DELETE FROM retrieval_documents WHERE workspace_id=$1 AND kind='transcript' AND source_id=$2",
          [p.workspaceId, id],
        );
        return { ok: true };
      }),
    );
  });
  app.post(
    '/v1/search/files/:id/extract',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const p = await authenticate(db, req),
        id = key(req.params);
      await author(db, p);
      if (!options.files)
        throw new AppError(503, 'FILES_UNAVAILABLE', 'File storage is not configured.');
      const files = new FileService(db, options.files),
        file = await files.inspect(p, id, true);
      const [currentExtraction] = await db.query(
        "SELECT retrieval_source_version($1,'file',$2) version",
        [p.workspaceId, id],
      );
      const extractionVersion = Number(currentExtraction?.version ?? 1);
      await requireSources(db, p, [{ kind: 'file', id, version: extractionVersion }]);
      if (Number(file.size) > 4 * 1024 * 1024)
        throw new AppError(413, 'EXTRACTION_LIMIT', 'Extract files smaller than 4 MiB.');
      const stream = await options.files.store.get(String(file.object_key));
      const timeout = setTimeout(
        () => stream.destroy(new AppError(504, 'EXTRACTION_TIMEOUT', 'File extraction timed out.')),
        20000,
      );
      const pieces: Buffer[] = [];
      let size = 0;
      try {
        for await (const value of stream) {
          const data = Buffer.from(value);
          size += data.length;
          if (size > 4 * 1024 * 1024)
            throw new AppError(413, 'EXTRACTION_LIMIT', 'File extraction exceeded its byte limit.');
          pieces.push(data);
        }
      } finally {
        clearTimeout(timeout);
        stream.destroy();
      }
      const data = Buffer.concat(pieces),
        decoded = plainText(data, String(file.content_type)),
        plain = decoded !== null;
      if (!plain && !options.extractor)
        throw new AppError(
          503,
          'OCR_UNAVAILABLE',
          'An isolated OCR/text extraction provider is required for this file type.',
        );
      await requireSources(db, p, [{ kind: 'file', id, version: extractionVersion }]);
      const body = plain
        ? decoded!
        : await options.extractor!.extract({
            data,
            contentType: String(file.content_type),
            signal: AbortSignal.timeout(20000),
          });
      if (body.length > 1000000)
        throw new AppError(
          413,
          'EXTRACTION_LIMIT',
          'Extracted text exceeds one million characters.',
        );
      return db.transaction(async (tx) => {
        await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [p.workspaceId]);
        await requireSources(tx, p, [{ kind: 'file', id, version: extractionVersion }]);
        await tx.query(
          'INSERT INTO file_extractions(workspace_id,file_id,body,method,sha256,extractor,version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,file_id) DO UPDATE SET body=EXCLUDED.body,method=EXCLUDED.method,sha256=EXCLUDED.sha256,extractor=EXCLUDED.extractor,version=file_extractions.version+1,created_at=now()',
          [
            p.workspaceId,
            id,
            body,
            plain ? 'text' : 'ocr',
            file.sha256,
            plain ? 'utf8-v1' : options.extractor!.id,
            extractionVersion,
          ],
        );
        return { id, characters: body.length, method: plain ? 'text' : 'ocr' };
      });
    },
  );
  app.get('/v1/search/health', async (req) => {
    const p = await authenticate(db, req);
    if (
      p.kind !== 'human' ||
      !['owner', 'admin'].includes(p.role) ||
      p.permissions?.['workspace.manage'] === false
    )
      throw new AppError(
        403,
        'ADMIN_REQUIRED',
        'Workspace administrators can inspect indexing health.',
      );
    return workerScope(p.workspaceId, async () => ({
      jobs: await db.query(
        'SELECT state,count(*)::integer count,min(updated_at) oldest FROM retrieval_jobs GROUP BY state',
      ),
      index: await db.query(
        'SELECT kind,count(*)::integer documents,min(indexed_at) oldest FROM retrieval_documents GROUP BY kind',
      ),
      measurements: await db.query(
        'SELECT count(*)::integer queries,percentile_cont(0.5) WITHIN GROUP(ORDER BY duration_ms) p50_ms,percentile_cont(0.95) WITHIN GROUP(ORDER BY duration_ms) p95_ms,max(candidate_count) max_candidates FROM retrieval_metrics',
      ),
    }));
  });
  app.post('/v1/search/rebuild', async (req) => {
    const p = await authenticate(db, req);
    if (
      p.kind !== 'human' ||
      !['owner', 'admin'].includes(p.role) ||
      p.permissions?.['workspace.manage'] === false
    )
      throw new AppError(403, 'ADMIN_REQUIRED', 'Workspace administrators can rebuild indexes.');
    return workerScope(p.workspaceId, async () => {
      await db.query(
        "UPDATE retrieval_jobs SET state='pending',generation=generation+1,attempts=0,lease=NULL,lease_until=NULL,available_at=now(),updated_at=now()",
      );
      await db.query(
        "UPDATE retrieval_embedding_jobs SET state='pending',next_ordinal=0,lease=NULL,lease_until=NULL,available_at=now() WHERE state='completed' AND expires_at>now()",
      );
      return { queued: true };
    });
  });
}
