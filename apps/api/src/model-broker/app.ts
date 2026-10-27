import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scopedDatabase, modelBrokerScope, type Database } from '@ao/database';
import { agentOutput } from '@ao/contracts';
import { agentConfiguration } from '@ao/contracts/agents';
import { verifyModelCapability, openModelKey, keyContext } from '../governance/byok-crypto.js';
import { generateText, Output } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { RuntimeOutcome, RuntimeRequest } from '../execution/types.js';
const input = z
  .object({
    runId: z.uuid(),
    prompt: z.string().max(20000),
    instructions: z.string().max(60000),
    context: z.string().max(100000),
    configuration: agentConfiguration,
  })
  .strict();
export type ModelGenerator = (
  secret: string,
  request: RuntimeRequest,
  signal: AbortSignal,
) => Promise<RuntimeOutcome>;
export function customerModelGenerator(fetcher: typeof fetch = fetch): ModelGenerator {
  return async (secret, request, signal) => {
    const cfg = agentConfiguration.parse(request.configuration);
    if (!/^openai\/[a-zA-Z0-9._-]{1,100}$/.test(cfg.model))
      throw new Error('Unsupported customer model.');
    const model = createOpenAICompatible({
      name: 'openai-byok',
      baseURL: 'https://api.openai.com/v1',
      apiKey: secret,
      supportsStructuredOutputs: true,
      includeUsage: true,
      fetch: (url, options) => {
        if (
          typeof options?.body !== 'string' ||
          Buffer.byteLength(options.body) + 4096 > cfg.limits.maxInputTokens
        )
          throw new Error('Input budget exceeded.');
        return fetcher(url, { ...options, redirect: 'error' });
      },
    }).chatModel(cfg.model.slice(7));
    const result = await generateText({
      model,
      output: Output.object({ schema: agentOutput }),
      system: request.instructions,
      prompt: JSON.stringify({ request: request.prompt, conversationContext: request.context }),
      maxOutputTokens: cfg.limits.maxOutputTokens,
      maxRetries: 0,
      abortSignal: signal,
      experimental_telemetry: { isEnabled: false },
    });
    return {
      output: agentOutput.parse(result.output),
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        costMicros: null,
      },
    };
  };
}
const generateCustomerModel = customerModelGenerator();
export function buildModelBroker(
  base: Database,
  options: {
    verifyKey: string;
    privateKeys: readonly string[];
    generate?: ModelGenerator;
    https?: { key: string; cert: string };
  },
) {
  const db = scopedDatabase(base),
    app = Fastify({
      ...(options.https ? { https: options.https } : {}),
      logger: false,
      bodyLimit: 250000,
      requestTimeout: 305000,
    }),
    active = new Map<string, AbortController>();
  app.setErrorHandler((_error, _req, reply) =>
    reply.code(409).send({
      error: {
        code: 'MODEL_REQUEST_REJECTED',
        message: 'The isolated model request could not be completed.',
      },
    }),
  );
  app.get('/health', async () => ({ ok: true, service: 'orbit-model-broker' }));
  const authorize = async (req: import('fastify').FastifyRequest) => {
    const c = verifyModelCapability(
      options.verifyKey,
      req.headers.authorization?.replace(/^Bearer /, '') ?? '',
    );
    if (z.object({ id: z.uuid() }).parse(req.params).id !== c.runId)
      throw new Error('Run mismatch.');
    return c;
  };
  app.post('/internal/byok/runs/:id', async (req, reply) => {
    const c = await authorize(req),
      body = input.parse(req.body);
    if (body.runId !== c.runId) throw new Error('Run mismatch.');
    return modelBrokerScope(c.workspaceId, async () => {
      const [record] = await db.query('SELECT broker_run_credential($1,$2,$3,$4) value', [
        c.workspaceId,
        c.runId,
        c.keyId,
        c.generation,
      ]);
      if (!record?.value) throw new Error('Model authority revoked.');
      const credential = record.value as {
        organizationId: string;
        sealedKey: string;
        configuration: unknown;
        model: string;
      };
      const configuration = agentConfiguration.parse(credential.configuration);
      if (
        JSON.stringify(configuration) !== JSON.stringify(body.configuration) ||
        Buffer.byteLength(JSON.stringify(body)) + 4096 > configuration.limits.maxInputTokens
      )
        throw new Error('Model bounds changed.');
      const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const [claimed] = await db.query(
        "INSERT INTO byok_runs(workspace_id,run_id,organization_id,key_id,key_generation,model,state,expires_at,request_hash) VALUES($1,$2,$3,$4,$5,$6,'dispatched',now()+$7::interval,$8) ON CONFLICT DO NOTHING RETURNING run_id",
        [
          c.workspaceId,
          c.runId,
          credential.organizationId,
          c.keyId,
          c.generation,
          configuration.model,
          configuration.limits.maxSeconds + ' seconds',
          hash,
        ],
      );
      if (!claimed) {
        const [prior] = await db.query(
          'SELECT state,result,request_hash FROM byok_runs WHERE workspace_id=$1 AND run_id=$2',
          [c.workspaceId, c.runId],
        );
        if (prior?.request_hash !== hash) throw new Error('Model input conflict.');
        if (prior?.state === 'completed') return prior.result;
        throw new Error('Existing model dispatch must not be replayed.');
      }
      const controller = new AbortController();
      active.set(c.runId, controller);
      const deadline = setTimeout(
        () => controller.abort(),
        Math.min(300, configuration.limits.maxSeconds) * 1000,
      );
      const monitor = setInterval(
        () =>
          void db
            .query('SELECT broker_run_authority($1,$2,$3,$4) valid', [
              c.workspaceId,
              c.runId,
              c.keyId,
              c.generation,
            ])
            .then(
              ([row]) => {
                if (!row?.valid) controller.abort();
              },
              () => controller.abort(),
            ),
        1000,
      );
      try {
        let secret: string | undefined;
        for (const key of options.privateKeys)
          try {
            secret = openModelKey(
              key,
              keyContext(credential.organizationId, c.keyId, c.generation),
              credential.sealedKey,
            );
            break;
          } catch {}
        if (!secret) throw new Error('Customer key cannot be opened.');
        const [authority] = await db.query('SELECT broker_run_authority($1,$2,$3,$4) valid', [
          c.workspaceId,
          c.runId,
          c.keyId,
          c.generation,
        ]);
        if (!authority?.valid) throw new Error('Model authority revoked.');
        const outcome = await (options.generate ?? generateCustomerModel)(
          secret,
          body,
          controller.signal,
        );
        secret = undefined;
        const checked = {
          output: agentOutput.parse(outcome.output),
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        };
        const [current] = await db.query('SELECT broker_run_authority($1,$2,$3,$4) valid', [
          c.workspaceId,
          c.runId,
          c.keyId,
          c.generation,
        ]);
        if (!current?.valid) throw new Error('Model authority revoked.');
        const [saved] = await db.query(
          "UPDATE byok_runs SET state='completed',result=$3::jsonb WHERE workspace_id=$1 AND run_id=$2 AND state='dispatched' RETURNING run_id",
          [c.workspaceId, c.runId, JSON.stringify(checked)],
        );
        if (!saved) throw new Error('Model dispatch cancelled.');
        return checked;
      } catch {
        await db.query(
          "UPDATE byok_runs SET state='uncertain',result=NULL WHERE workspace_id=$1 AND run_id=$2 AND state='dispatched'",
          [c.workspaceId, c.runId],
        );
        return reply.code(409).send({
          error: {
            code: 'MODEL_OUTCOME_UNKNOWN',
            message: 'Reconcile this model request before retrying.',
          },
        });
      } finally {
        clearTimeout(deadline);
        clearInterval(monitor);
        active.delete(c.runId);
      }
    });
  });
  app.get('/internal/byok/runs/:id', async (req) => {
    const c = await authorize(req);
    return modelBrokerScope(c.workspaceId, async () => {
      const [row] = await db.query('SELECT broker_run_authority($1,$2,$3,$4) valid', [
        c.workspaceId,
        c.runId,
        c.keyId,
        c.generation,
      ]);
      if (!row?.valid) throw new Error('Model authority revoked.');
      const [result] = await db.query(
        "SELECT result FROM byok_runs WHERE workspace_id=$1 AND run_id=$2 AND state='completed'",
        [c.workspaceId, c.runId],
      );
      return result?.result ?? null;
    });
  });
  app.delete('/internal/byok/runs/:id', async (req) => {
    const c = await authorize(req);
    return modelBrokerScope(c.workspaceId, async () => {
      active.get(c.runId)?.abort();
      await db.query(
        "UPDATE byok_runs SET state='cancelled',result=NULL WHERE workspace_id=$1 AND run_id=$2 AND key_id=$3 AND key_generation=$4 AND state='dispatched'",
        [c.workspaceId, c.runId, c.keyId, c.generation],
      );
      return { ok: true };
    });
  });
  app.addHook('onClose', async () => {
    for (const c of active.values()) c.abort();
  });
  return app;
}
