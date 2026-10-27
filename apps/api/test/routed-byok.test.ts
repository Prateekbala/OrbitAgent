import { it, expect } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { scopedDatabase } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { buildModelBroker } from '../src/model-broker/app.js';
import { RoutedRuntime } from '../src/governance/byok-runtime.js';
import { ExecutionWorker } from '../src/execution/worker.js';
import { agentConfiguration } from '@ao/contracts/agents';
import type { HostedRuntime } from '../src/execution/types.js';
it('executes an authorized queued run through the isolated broker without using the platform runtime', async () => {
  const wrapping = generateKeyPairSync('rsa', { modulusLength: 3072 }),
    signing = generateKeyPairSync('ed25519');
  let calls = 0;
  const platform: HostedRuntime = {
    configured: true,
    capabilities: { models: ['openai/fixture-model'], maxSeconds: 300 },
    requiredReservation: () => 1,
    async createSession() {
      throw new Error('Platform credential must not be used.');
    },
    async generate() {
      throw new Error('Platform credential must not be used.');
    },
    async recover() {
      return null;
    },
    async cancel() {},
  };
  const f = await messagingFixture(undefined, undefined, {
    runtime: platform,
    byokPublicKey: wrapping.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  const broker = buildModelBroker(f.db, {
    verifyKey: signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeys: [wrapping.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
    generate: async (secret, request) => {
      calls++;
      expect(secret).toBe('sk-isolated-execution-fixture-secret');
      expect(JSON.stringify(request)).not.toContain(secret);
      return {
        output: { reply: 'Isolated customer result', proposals: [] },
        usage: { inputTokens: 15, outputTokens: 5, costMicros: null },
      };
    },
  });
  try {
    const url = await broker.listen({ host: '127.0.0.1', port: 0 }),
      org = String(
        (
          await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
            f.ownerBoot.workspace.id,
          ])
        )[0]!.organization_id,
      );
    const key = await f.call(f.owner, 'PUT', `/v1/organizations/${org}/model-keys`, {
      version: 0,
      label: 'Isolated account',
      provider: 'openai',
      secret: 'sk-isolated-execution-fixture-secret',
      models: ['openai/fixture-model'],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(key.statusCode, key.body).toBe(200);
    const agent = await f.call(f.owner, 'POST', '/v1/agents', {
      name: 'Customer key agent',
      role: 'Summarize authorized messages.',
      runtime: 'managed',
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const configuration = agentConfiguration.parse({
      instructions: 'Summarize authorized messages.',
      model: 'openai/fixture-model',
      activation: 'manual',
      tools: [],
    });
    expect(
      (
        await f.call(f.owner, 'POST', `/v1/agents/${agent.json().id}/revisions`, {
          version: 1,
          configuration,
        })
      ).statusCode,
    ).toBe(200);
    const run = await f.call(f.owner, 'POST', '/v1/runs', {
      agentId: agent.json().id,
      conversationId: f.ownerBoot.channels[0]!.id,
      prompt: 'Summarize the discussion.',
      requestKey: randomUUID(),
    });
    expect(run.statusCode, run.body).toBe(201);
    const runtime = new RoutedRuntime(scopedDatabase(f.db), platform, {
      url,
      signingKey: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    await new ExecutionWorker(f.db, runtime).tick();
    const [stored] = await f.db.query(
      'SELECT status,error_code,session_id FROM agent_runs WHERE id=$1',
      [run.json().id],
    );
    expect(stored?.status, JSON.stringify(stored)).toBe('succeeded');
    expect(calls).toBe(1);
    expect(stored?.session_id).toBe('byok:' + run.json().id);
    const traces = await f.db.query('SELECT summary,payload FROM run_checkpoints WHERE run_id=$1', [
      run.json().id,
    ]);
    expect(JSON.stringify(traces)).not.toContain('sk-isolated-execution-fixture-secret');
  } finally {
    await broker.close();
    await f.close();
  }
}, 30000);
