import { beforeAll, afterAll, it, expect } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { workerScope, scopedDatabase } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { buildModelBroker } from '../src/model-broker/app.js';
import {
  modelCapability,
  sealModelKey,
  openModelKey,
  keyContext,
} from '../src/governance/byok-crypto.js';
import { agentConfiguration } from '@ao/contracts/agents';
const wrapping = generateKeyPairSync('rsa', { modulusLength: 3072 }),
  cap = generateKeyPairSync('ed25519'),
  publicKey = wrapping.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  privateKey = wrapping.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  signing = cap.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let f: Awaited<ReturnType<typeof messagingFixture>>,
  org: string,
  keyId: string,
  generation: number,
  runId: string,
  calls = 0;
let broker: ReturnType<typeof buildModelBroker>;
const secret = 'sk-synthetic-private-customer-key-123456';
const configuration = agentConfiguration.parse({
  instructions: 'Summarize the authorized discussion.',
  model: 'openai/fixture-model',
  tools: [],
  activation: 'manual',
});
beforeAll(async () => {
  f = await messagingFixture(undefined, undefined, {
    byokPublicKey: publicKey,
    runtime: {
      configured: true,
      async createSession() {
        return 'unused';
      },
      async generate() {
        throw new Error('Platform fallback must not run.');
      },
      async recover() {
        return null;
      },
      async cancel() {},
    },
  });
  org = String(
    (
      await f.db.query('SELECT organization_id FROM workspaces WHERE id=$1', [
        f.ownerBoot.workspace.id,
      ])
    )[0]!.organization_id,
  );
  broker = buildModelBroker(f.db, {
    verifyKey: cap.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeys: [privateKey],
    generate: async (key, request) => {
      calls++;
      expect(key).toBe(secret);
      expect(JSON.stringify(request)).not.toContain(secret);
      return {
        output: { reply: 'Customer-key output', proposals: [] },
        usage: { inputTokens: 20, outputTokens: 10, costMicros: null },
      };
    },
  });
}, 30000);
afterAll(async () => {
  await broker?.close();
  await f?.close();
});
it('limits key management to owners, seals with contextual public-key encryption and never lists secrets', async () => {
  const input = {
    version: 0,
    label: 'Customer account',
    provider: 'openai',
    secret,
    models: ['openai/fixture-model'],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  expect(
    (await f.call(f.mate, 'PUT', `/v1/organizations/${org}/model-keys`, input)).statusCode,
  ).toBe(403);
  const r = await f.call(f.owner, 'PUT', `/v1/organizations/${org}/model-keys`, input);
  expect(r.statusCode, r.body).toBe(200);
  keyId = r.json().id;
  generation = r.json().generation;
  const list = await f.call(f.owner, 'GET', `/v1/organizations/${org}/model-keys`);
  expect(list.body).not.toContain(secret);
  expect(list.body).not.toContain('sealed_key');
  const [stored] = await f.db.query('SELECT sealed_key FROM organization_model_keys WHERE id=$1', [
    keyId,
  ]);
  expect(String(stored!.sealed_key)).not.toContain(secret);
  expect(
    openModelKey(privateKey, keyContext(org, keyId, generation), String(stored!.sealed_key)),
  ).toBe(secret);
  expect(() =>
    openModelKey(
      privateKey,
      keyContext(randomUUID(), keyId, generation),
      String(stored!.sealed_key),
    ),
  ).toThrow();
  const encrypted = sealModelKey(publicKey, 'test-context', secret);
  expect(() => openModelKey(privateKey, 'different', encrypted)).toThrow();
});
it('pins keys to runs and prevents cross-tenant dispatch, duplicate provider calls and silent replay', async () => {
  const a = await f.call(f.owner, 'POST', '/v1/agents', {
    name: 'Isolated model',
    runtime: 'managed',
    role: configuration.instructions,
  });
  expect(a.statusCode, a.body).toBe(201);
  const updated = await f.call(f.owner, 'POST', `/v1/agents/${a.json().id}/revisions`, {
    version: 1,
    configuration,
  });
  expect(updated.statusCode, updated.body).toBe(200);
  const run = await f.call(f.owner, 'POST', '/v1/runs', {
    agentId: a.json().id,
    conversationId: f.ownerBoot.channels[0]!.id,
    prompt: 'Summarize the context.',
    requestKey: randomUUID(),
  });
  expect(run.statusCode, run.body).toBe(201);
  runId = run.json().id;
  await f.db.query(
    "UPDATE agent_runs SET status='running',dispatch_started=true,lease_token=$2,lease_expires_at=now()+interval '2 minutes' WHERE id=$1",
    [runId, randomUUID()],
  );
  const binding = { workspaceId: f.ownerBoot.workspace.id, runId, keyId, generation };
  const headers = { authorization: 'Bearer ' + modelCapability(signing, binding) };
  const request = {
    runId,
    prompt: 'Summarize the context.',
    instructions: configuration.instructions,
    context: '[]',
    configuration,
  };
  const denied = await broker.inject({
    method: 'POST',
    url: '/internal/byok/runs/' + runId,
    headers: {
      authorization:
        'Bearer ' + modelCapability(signing, { ...binding, workspaceId: f.otherBoot.workspace.id }),
    },
    payload: request,
  });
  expect(denied.statusCode).toBe(409);
  expect(calls).toBe(0);
  const result = await broker.inject({
    method: 'POST',
    url: '/internal/byok/runs/' + runId,
    headers,
    payload: request,
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().output.reply).toBe('Customer-key output');
  const replay = await broker.inject({
    method: 'POST',
    url: '/internal/byok/runs/' + runId,
    headers,
    payload: request,
  });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(calls).toBe(1);
  expect(
    (
      await broker.inject({
        method: 'POST',
        url: '/internal/byok/runs/' + runId,
        headers,
        payload: { ...request, prompt: 'Changed input' },
      })
    ).statusCode,
  ).toBe(409);
  await workerScope(f.ownerBoot.workspace.id, async () => {
    await expect(
      scopedDatabase(f.db).query('SELECT sealed_key FROM organization_model_keys'),
    ).rejects.toThrow(/permission denied/);
  });
});
it('revocation blocks recovery and never falls back to a platform credential', async () => {
  expect(
    (await f.call(f.owner, 'DELETE', `/v1/organizations/${org}/model-keys/${keyId}`)).statusCode,
  ).toBe(200);
  const r = await broker.inject({
    method: 'GET',
    url: '/internal/byok/runs/' + runId,
    headers: {
      authorization:
        'Bearer ' +
        modelCapability(signing, {
          workspaceId: f.ownerBoot.workspace.id,
          runId,
          keyId,
          generation,
        }),
    },
  });
  expect(r.statusCode).toBe(409);
  expect(r.body).not.toContain(secret);
  expect(calls).toBe(1);
});
