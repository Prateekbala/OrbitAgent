import type { AgentOutput } from '@ao/contracts';
import type { AgentConfiguration } from '@ao/contracts/agents';
export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
}
export interface RuntimeOutcome {
  output: AgentOutput;
  usage?: RuntimeUsage;
}
export interface RuntimeRequest {
  runId: string;
  prompt: string;
  instructions: string;
  context: string;
  configuration?: AgentConfiguration;
}
export interface HostedRuntime {
  readonly configured: boolean;
  forRun?(workspaceId: string, runId: string): Promise<HostedRuntime>;
  requiredReservation?(configuration: AgentConfiguration): number;
  readonly capabilities?: {
    models?: string[];
    durableCheckpoints?: boolean;
    resumeObservation?: boolean;
    maxSeconds?: number;
    boundedTokens?: boolean;
    [key: string]: unknown;
  };
  createSession(signal: AbortSignal): Promise<string>;
  generate(sessionId: string, request: RuntimeRequest, signal: AbortSignal): Promise<AgentOutput>;
  cancel(sessionId: string): Promise<void>;
  recover(sessionId: string, signal: AbortSignal): Promise<AgentOutput | null>;
  recoverDetailed?(sessionId: string, signal: AbortSignal): Promise<RuntimeOutcome | null>;
  generateDetailed?(
    sessionId: string,
    request: RuntimeRequest,
    signal: AbortSignal,
  ): Promise<RuntimeOutcome>;
  observe?(sessionId: string, signal: AbortSignal): Promise<RuntimeOutcome>;
}
export interface RunRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  agent_id: string;
  requester_id: string;
  requester_auth_version: number;
  conversation_id: string;
  instructions: string;
  prompt: string;
  status: string;
  session_id: string | null;
  lease_token: string | null;
  dispatch_started: boolean;
  configuration?: AgentConfiguration | null;
  agent_revision?: number | null;
  deadline_at?: Date | string | null;
  parent_run_id?: string | null;
  root_run_id?: string | null;
  delegation_depth?: number;
  delegation_deadline?: Date | string | null;
  requester_policy_version?: number | null;
}
export interface InvocationRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  run_id: string;
  tool_name: import('@ao/contracts/tools').ToolName;
  tool_version: number;
  policy_version: number;
  parameters: unknown;
  action_digest: string;
  status: string;
  expires_at: Date | string;
}
