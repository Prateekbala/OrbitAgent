import type { Database } from '@ao/database';
import type { HostedRuntime, RuntimeRequest, RuntimeOutcome } from '../execution/types.js';
import { AppError } from '../lib/errors.js';
import { modelCapability } from './byok-crypto.js';
import { agentOutput } from '@ao/contracts';
export class RoutedRuntime implements HostedRuntime {
  readonly configured: boolean;
  readonly capabilities;
  constructor(
    private db: Database,
    private platform: HostedRuntime,
    private broker?: { url: string; signingKey?: string },
  ) {
    this.configured = platform.configured || Boolean(broker);
    this.capabilities = platform.capabilities ?? {};
  }
  requiredReservation(
    configuration: Parameters<NonNullable<HostedRuntime['requiredReservation']>>[0],
  ) {
    if (!this.platform.requiredReservation)
      throw new AppError(
        409,
        'MODEL_PRICING_REQUIRED',
        'Configure conservative model pricing before execution.',
      );
    return this.platform.requiredReservation(configuration);
  }
  async forRun(workspaceId: string, runId: string): Promise<HostedRuntime> {
    const [row] = await this.db.query('SELECT run_model_route($1,$2) value', [workspaceId, runId]);
    const route = row?.value as {
      keyId: string | null;
      generation: number | null;
      required: boolean;
      disabled: boolean;
    } | null;
    if (!route)
      throw new AppError(409, 'ORGANIZATION_UNAVAILABLE', 'The run is no longer authorized.');
    if (route.keyId) {
      if (route.disabled || !this.broker?.signingKey)
        throw new AppError(409, 'BYOK_UNAVAILABLE', 'The isolated model broker is unavailable.');
      return new ByokRuntime(
        { ...this.broker, signingKey: this.broker.signingKey },
        { workspaceId, runId, keyId: route.keyId, generation: route.generation! },
        this,
      );
    }
    if (route.required)
      throw new AppError(409, 'BYOK_REQUIRED', 'A customer model key is required.');
    if (!this.platform.configured)
      throw new AppError(
        503,
        'RUNTIME_UNAVAILABLE',
        'This run has no configured platform runtime or customer model key.',
      );
    return this.platform;
  }
  createSession(signal: AbortSignal) {
    return this.platform.createSession(signal);
  }
  generate(id: string, request: RuntimeRequest, signal: AbortSignal) {
    return this.platform.generate(id, request, signal);
  }
  private async sessionRuntime(id: string) {
    if (!id.startsWith('byok:')) return this.platform;
    const runId = id.slice(5);
    const [row] = await this.db.query('SELECT workspace_id FROM agent_runs WHERE id=$1', [runId]);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'The model session is unavailable.');
    return this.forRun(String(row.workspace_id), runId);
  }
  async cancel(id: string) {
    if (id.startsWith('byok:')) return;
    await (await this.sessionRuntime(id)).cancel(id);
  }
  async recover(id: string, signal: AbortSignal) {
    if (id.startsWith('byok:')) return (await this.recoverDetailed(id, signal))?.output ?? null;
    return (await this.sessionRuntime(id)).recover(id, signal);
  }
  async recoverDetailed(id: string, signal: AbortSignal) {
    if (id.startsWith('byok:')) {
      const [row] = await this.db.query('SELECT recover_byok_result($1) result', [id.slice(5)]);
      const result = row?.result as RuntimeOutcome | null;
      return result ? { ...result, output: agentOutput.parse(result.output) } : null;
    }
    const runtime = await this.sessionRuntime(id);
    if (runtime.recoverDetailed) return runtime.recoverDetailed(id, signal);
    const output = await runtime.recover(id, signal);
    return output ? { output } : null;
  }
}
class ByokRuntime implements HostedRuntime {
  readonly configured = true;
  readonly capabilities;
  constructor(
    private config: { url: string; signingKey: string },
    private binding: { workspaceId: string; runId: string; keyId: string; generation: number },
    private parent: RoutedRuntime,
  ) {
    const url = new URL(config.url);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
      throw new Error('Model broker requires TLS outside loopback.');
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
      throw new Error('Configure an exact model broker origin.');
    this.capabilities = {
      ...parent.capabilities,
      durableCheckpoints: false,
      resumeObservation: false,
      maxSeconds: 300,
      boundedTokens: true,
      maxModelCalls: 1,
      artifactExport: true,
    };
  }
  requiredReservation(c: Parameters<RoutedRuntime['requiredReservation']>[0]) {
    return this.parent.requiredReservation(c);
  }
  async createSession(_signal: AbortSignal) {
    return 'byok:' + this.binding.runId;
  }
  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    signal: AbortSignal,
    request?: RuntimeRequest,
  ): Promise<RuntimeOutcome | null> {
    const response = await fetch(
      this.config.url.replace(/\/$/, '') + '/internal/byok/runs/' + this.binding.runId,
      {
        method,
        signal,
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + modelCapability(this.config.signingKey, this.binding),
          'content-type': 'application/json',
        },
        ...(request ? { body: JSON.stringify(request) } : {}),
      },
    );
    if (!response.ok)
      throw new AppError(
        409,
        'BYOK_OUTCOME_UNAVAILABLE',
        'The isolated model request did not complete; do not retry it without reconciliation.',
      );
    if (method === 'DELETE') return null;
    const value = (await response.json()) as RuntimeOutcome | null;
    if (!value) return null;
    return {
      output: agentOutput.parse(value.output),
      ...(value.usage ? { usage: value.usage } : {}),
    };
  }
  async generate(id: string, request: RuntimeRequest, signal: AbortSignal) {
    return (await this.generateDetailed(id, request, signal)).output;
  }
  async generateDetailed(id: string, request: RuntimeRequest, signal: AbortSignal) {
    if (id !== 'byok:' + this.binding.runId || request.runId !== this.binding.runId)
      throw new Error('Model run mismatch.');
    const outcome = await this.call('POST', signal, request);
    if (!outcome) throw new Error('Missing model result.');
    return outcome;
  }
  async recover(_id: string, signal: AbortSignal) {
    return (await this.call('GET', signal))?.output ?? null;
  }
  async recoverDetailed(_id: string, signal: AbortSignal) {
    return this.call('GET', signal);
  }
  async cancel(_id: string) {
    await this.call('DELETE', AbortSignal.timeout(5000));
  }
}
