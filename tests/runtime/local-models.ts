import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'eve/client';
import { configuredEmbeddings } from '../../apps/api/src/retrieval/embeddings.js';
import { agentConfiguration } from '@ao/contracts/agents';
import { agentOutput } from '@ao/contracts';
import { EveRuntime } from '../../apps/api/src/execution/runtime.js';
const vector = await configuredEmbeddings('ollama/orbit-embeddings')!.embed(
  ['A local Orbit verification sentence.'],
  AbortSignal.timeout(60000),
);
assert.equal(vector.length, 1);
assert(vector[0]!.length > 0 && vector[0]!.every(Number.isFinite));
const client = new Client({
  host: process.env.EVE_RUNTIME_URL!,
  auth: { bearer: process.env.EVE_SERVICE_TOKEN! },
  redirect: 'error',
});
const runtime = new EveRuntime(process.env.EVE_RUNTIME_URL, process.env.EVE_SERVICE_TOKEN);
const sessionId = await runtime.createSession(AbortSignal.timeout(15000));
try {
  const configuration = agentConfiguration.parse({
    instructions: 'Provide a concise factual reply. Do not propose actions unless requested.',
    tools: [],
    limits: { maxOutputTokens: 700, maxInputTokens: 60000, maxTools: 0 },
  });
  const result = await runtime.generateDetailed(
    sessionId,
    {
      runId: randomUUID(),
      instructions: configuration.instructions,
      prompt:
        'Reply with a short greeting confirming that this agent is using a local model. Do not propose any actions.',
      context: '',
      configuration,
    },
    AbortSignal.timeout(240000),
  );
  const output = agentOutput.parse(result.output);
  assert(result.usage && result.usage.inputTokens > 0 && result.usage.outputTokens > 0);
  assert(output.reply.length > 0);
  assert.deepEqual(output.proposals, []);
  console.log(
    'Real local embeddings and an authenticated, schema-validated hosted agent turn passed. No paid provider was called.',
  );
} finally {
  await client.sessions.attach(sessionId).reset({
    reason: 'Synthetic local model verification complete.',
    signal: AbortSignal.timeout(10000),
  });
}
