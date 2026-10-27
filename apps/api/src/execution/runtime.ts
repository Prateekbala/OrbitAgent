import { Client } from 'eve/client';
import { agentOutput } from '@ao/contracts';
import type { HostedRuntime, RuntimeRequest, RuntimeUsage, RuntimeOutcome } from './types.js';
import type { AgentConfiguration } from '@ao/contracts/agents';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
const modelPricing = z.record(
  z.string().min(1).max(150),
  z
    .object({
      inputMicrosPerMillion: z.number().int().min(0).max(1000000000),
      outputMicrosPerMillion: z.number().int().min(0).max(1000000000),
    })
    .strict(),
);
export function parseModelPricing(value: string | undefined) {
  if (!value) return {};
  try {
    return modelPricing.parse(JSON.parse(value));
  } catch {
    throw new Error(
      'AGENT_MODEL_PRICING_JSON must contain model IDs with integer inputMicrosPerMillion and outputMicrosPerMillion rates.',
    );
  }
}
export class EveRuntime implements HostedRuntime {
  readonly configured: boolean;
  readonly capabilities;
  private readonly client: Client | null;
  private readonly pricing;
  private readonly defaultModel;
  constructor(
    url: string | undefined,
    secret: string | undefined,
    options: {
      durabilityQualified?: boolean;
      models?: string[];
      pricing?: ReturnType<typeof parseModelPricing>;
      defaultModel?: string;
    } = {},
  ) {
    if (secret && secret.length < 32)
      throw new Error('EVE_SERVICE_TOKEN must contain at least 32 characters.');
    this.configured = Boolean(url && secret);
    this.pricing = options.pricing ?? {};
    this.defaultModel = options.defaultModel;
    this.capabilities = {
      models: options.models ?? [],
      durableCheckpoints: options.durabilityQualified ?? false,
      resumeObservation: options.durabilityQualified ?? false,
      maxSeconds: options.durabilityQualified ? 86400 : 300,
      boundedTokens: true,
      artifactExport: true,
      pricedModels: Object.keys(this.pricing),
      maxModelCalls: 1,
    };
    if (url) {
      const parsed = new URL(url);
      if (
        parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))
      )
        throw new Error('EVE_RUNTIME_URL must use HTTPS outside loopback.');
    }
    this.client =
      url && secret ? new Client({ host: url, auth: { bearer: secret }, redirect: 'error' }) : null;
  }
  requiredReservation(configuration: AgentConfiguration) {
    const selected =
        configuration.model === 'operator_default' ? this.defaultModel : configuration.model,
      rate = selected ? this.pricing[selected] : undefined;
    if (!rate)
      throw new AppError(
        409,
        'MODEL_PRICING_REQUIRED',
        'The operator must configure conservative model pricing bounds before hosted execution.',
      );
    return Math.max(
      1,
      Math.ceil(
        (configuration.limits.maxInputTokens * rate.inputMicrosPerMillion +
          configuration.limits.maxOutputTokens * rate.outputMicrosPerMillion) /
          1000000,
      ),
    );
  }
  async createSession(signal: AbortSignal) {
    if (!this.client) throw new Error('Hosted runtime is not configured.');
    const { session } = await this.client.sessions.create({ signal });
    return session.state.sessionId;
  }
  async generate(sessionId: string, request: RuntimeRequest, signal: AbortSignal) {
    return (await this.generateDetailed(sessionId, request, signal)).output;
  }
  async generateDetailed(
    sessionId: string,
    request: RuntimeRequest,
    signal: AbortSignal,
  ): Promise<RuntimeOutcome> {
    if (!this.client) throw new Error('Hosted runtime is not configured.');
    const response = await this.client.sessions.attach(sessionId).send(
      JSON.stringify({
        runId: request.runId,
        roleInstructions: request.instructions,
        request: request.prompt,
        conversationContext: request.context,
        configuration: request.configuration,
      }),
      { outputSchema: agentOutput, signal },
    );
    const result = await response.result();
    if (
      !['completed', 'waiting'].includes(result.status) ||
      !result.events.some((event) => event.type === 'turn.completed') ||
      !result.events.some((event) => event.type === 'result.completed') ||
      result.events.some(
        (event) => event.type.endsWith('.failed') || event.type === 'turn.cancelled',
      )
    )
      throw new Error('The hosted turn did not complete.');
    let usage: RuntimeUsage | undefined;
    for (const event of result.events) {
      if (
        (event.type === 'session.waiting' ||
          event.type === 'session.completed' ||
          event.type === 'session.failed') &&
        event.data &&
        'usage' in event.data
      ) {
        usage = runtimeUsage(event.data.usage);
      }
    }
    return { output: agentOutput.parse(result.data), ...(usage ? { usage } : {}) };
  }
  async observe(sessionId: string, signal: AbortSignal): Promise<RuntimeOutcome> {
    if (!this.client || !this.capabilities.resumeObservation)
      throw new Error('Checkpoint recovery is not qualified.');
    let output: unknown = null;
    for await (const event of this.client.sessions
      .attach(sessionId)
      .stream({ startIndex: 0, follow: true, signal })) {
      if (event.type === 'result.completed') output = event.data.result;
      if (
        event.type === 'turn.failed' ||
        event.type === 'turn.cancelled' ||
        event.type === 'session.failed'
      )
        throw new Error('The existing hosted turn stopped.');
      if ((event.type === 'session.waiting' || event.type === 'session.completed') && output)
        return {
          output: agentOutput.parse(output),
          ...(event.data && 'usage' in event.data ? { usage: runtimeUsage(event.data.usage) } : {}),
        };
    }
    throw new Error('The existing hosted turn has no settled result.');
  }
  async recover(sessionId: string, signal: AbortSignal) {
    return (await this.recoverDetailed(sessionId, signal))?.output ?? null;
  }
  async recoverDetailed(sessionId: string, signal: AbortSignal): Promise<RuntimeOutcome | null> {
    if (!this.client) throw new Error('Hosted runtime is not configured.');
    let output: unknown = null;
    let settled = false;
    let usage: RuntimeUsage | undefined;
    for await (const event of this.client.sessions
      .attach(sessionId)
      .stream({ startIndex: 0, follow: false, signal })) {
      if (event.type === 'result.completed') {
        output = event.data.result;
        settled = false;
      }
      if (event.type === 'session.waiting' || event.type === 'session.completed') {
        settled = true;
        if (event.data && 'usage' in event.data) usage = runtimeUsage(event.data.usage);
      }
      if (
        event.type === 'session.failed' ||
        event.type === 'turn.cancelled' ||
        event.type === 'turn.failed'
      ) {
        output = null;
        settled = false;
      }
    }
    return output && settled
      ? { output: agentOutput.parse(output), ...(usage ? { usage } : {}) }
      : null;
  }
  async cancel(sessionId: string) {
    if (this.client)
      await this.client.sessions.attach(sessionId).cancel({ signal: AbortSignal.timeout(5000) });
  }
}
function runtimeUsage(value: unknown): RuntimeUsage {
  const usage = value as { inputTokens?: number; outputTokens?: number; costUsd?: number };
  return {
    inputTokens: Math.max(0, Math.ceil(usage.inputTokens ?? 0)),
    outputTokens: Math.max(0, Math.ceil(usage.outputTokens ?? 0)),
    costMicros:
      typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)
        ? Math.max(0, Math.ceil(usage.costUsd * 1000000))
        : null,
  };
}
