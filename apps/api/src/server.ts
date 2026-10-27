import { RoutedRuntime } from './governance/byok-runtime.js';
import { LifecycleWorker } from './governance/lifecycle.js';
import { dockerSandboxExecutor } from './tools/docker-sandbox.js';
import { configuredCommerce } from './billing/stripe.js';
import { BillingWorker } from './billing/worker.js';
import { FileGovernanceWorker } from './files/governance-worker.js';
import { configuredMedia } from './calls/provider.js';
import { CallWorker } from './calls/worker.js';
import { configuredPush } from './notifications/delivery-providers.js';
import { NotificationDeliveryWorker } from './notifications/delivery-worker.js';
import { SharedRetentionWorker } from './interoperability/retention.js';
import { MigrationWorker } from './interoperability/worker.js';
import { remoteMcp } from './developer/remote-mcp.js';
import { DeveloperWebhookWorker } from './developer/webhooks.js';
import { AutomationWorker } from './automations/worker.js';
import { configuredTextExtractor } from './retrieval/extraction.js';
import { EmbeddingWorker } from './retrieval/embedding-worker.js';
import { ConnectionEventWorker } from './connections/events.js';
import { ConnectionService } from './connections/service.js';
import { NativeConnectorActions } from './connections/native-actions.js';
import { configuredAnswerSynthesizer } from './retrieval/answers.js';
import { connectorProvider } from './connections/provider.js';
import { configuredEmbeddings } from './retrieval/embeddings.js';
import { FixedConnectorOAuth, type ConnectorOAuthProviders } from './connections/oauth.js';
import { RetrievalWorker } from './retrieval/worker.js';
import { ToolActionWorker } from './tools/worker.js';
import { actionProvider } from './tools/provider.js';
import { sandboxExecutor } from './tools/sandbox.js';
import { KnowledgeWorker } from './knowledge/worker.js';
import { CalendarSyncWorker } from './calendar/worker.js';
import { GoogleCalendarProvider } from './calendar/google.js';
import { IdentitySecrets, parsePreviousIdentityKeys } from './identity/secrets.js';
import { WorkflowWorker } from './workflows/worker.js';
import { MessageDeliveryWorker } from './messaging/worker.js';
import { TaskSchedulingWorker } from './scheduling/worker.js';
import { ActivityCleanupWorker } from './activity/worker.js';
import { IdentityCleanupWorker } from './identity/worker.js';
import { configuredFiles } from './files/config.js';
import { FileCleanupWorker } from './files/worker.js';
import { database, migrate, assertRuntimeConnection, scopedDatabase } from '@ao/database';
import { resolve } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { EveRuntime, parseModelPricing } from './execution/runtime.js';
import { configuredEmail } from './email/service.js';
import { EmailWorker } from './email/worker.js';
import { ExecutionWorker } from './execution/worker.js';
import { AgentDeliveryWorker, webhookSender } from './agents/webhooks.js';
const production = process.env.NODE_ENV === 'production';
if (production && process.env.TOOL_SANDBOX_PROVIDER === 'docker')
  throw new Error('Local Docker sandboxes cannot be selected in production.');
if (production && !process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required in production.');
if (production && !process.env.WEB_ORIGIN?.startsWith('https://'))
  throw new Error('An HTTPS WEB_ORIGIN is required in production.');
const db = await database(
  process.env.DATABASE_URL
    ? {
        url: process.env.DATABASE_URL,
        onPoolError: (code) =>
          process.stderr.write(
            JSON.stringify({ level: 'error', code, message: 'Idle database connection failed' }) +
              '\n',
          ),
      }
    : {
        directory: resolve(fileURLToPath(new URL('../../../', import.meta.url)), '.data/postgres'),
      },
);
if (production) await assertRuntimeConnection(db);
else await migrate(db);
const platformRuntime = new EveRuntime(process.env.EVE_RUNTIME_URL, process.env.EVE_SERVICE_TOKEN, {
  durabilityQualified: process.env.EVE_DURABILITY_QUALIFIED === 'true',
  pricing: parseModelPricing(process.env.AGENT_MODEL_PRICING_JSON),
  ...(process.env.AGENT_MODEL ? { defaultModel: process.env.AGENT_MODEL } : {}),
  models: (process.env.AGENT_APPROVED_MODELS?.trim() || process.env.AGENT_MODEL || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
});
const byokPublicKey = process.env.BYOK_WRAPPING_PUBLIC_KEY_FILE
  ? await readFile(process.env.BYOK_WRAPPING_PUBLIC_KEY_FILE, 'utf8')
  : undefined;
const signingKey = process.env.BYOK_CAPABILITY_SIGNING_KEY_FILE
  ? await readFile(process.env.BYOK_CAPABILITY_SIGNING_KEY_FILE, 'utf8')
  : undefined;
const runtime = new RoutedRuntime(
  scopedDatabase(db),
  platformRuntime,
  process.env.MODEL_BROKER_URL
    ? { url: process.env.MODEL_BROKER_URL, ...(signingKey ? { signingKey } : {}) }
    : undefined,
);
const agentWebhookHosts = (process.env.AGENT_WEBHOOK_HOSTS ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const email = configuredEmail(process.env, process.env.WEB_ORIGIN ?? 'http://localhost:3000');
if (production) email.requireConfigured();
const files = configuredFiles(
  process.env,
  resolve(fileURLToPath(new URL('../../../', import.meta.url))),
);
const calendar =
  process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    ? new GoogleCalendarProvider(
        process.env.GOOGLE_CALENDAR_CLIENT_ID,
        process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
        (process.env.WEB_ORIGIN ?? 'http://localhost:3000') + '/api/v1/calendar/google/callback',
      )
    : undefined;
const toolProviderHosts = (process.env.TOOL_PROVIDER_HOSTS ?? '')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const connectorOAuth: ConnectorOAuthProviders = {};
for (const [provider, prefix] of [
  ['google_drive', 'CONNECTOR_GOOGLE'],
  ['linear', 'CONNECTOR_LINEAR'],
  ['github', 'CONNECTOR_GITHUB'],
  ['gitlab', 'CONNECTOR_GITLAB'],
  ['jira', 'CONNECTOR_JIRA'],
  ['microsoft365', 'CONNECTOR_MICROSOFT'],
  ['notion', 'CONNECTOR_NOTION'],
  ['hubspot', 'CONNECTOR_HUBSPOT'],
] as const) {
  const clientId = process.env[prefix + '_CLIENT_ID'],
    secret = process.env[prefix + '_CLIENT_SECRET'];
  if (clientId && secret)
    connectorOAuth[provider] = new FixedConnectorOAuth(
      provider,
      clientId,
      secret,
      (process.env.WEB_ORIGIN ?? 'http://localhost:3000') +
        '/api/v1/connections/oauth/' +
        provider +
        '/callback',
    );
}
const textExtractor = configuredTextExtractor(process.env.RETRIEVAL_OCR_MODEL);
const retrievalEmbeddings = configuredEmbeddings(process.env.RETRIEVAL_EMBEDDING_MODEL);
const retrievalAnswers = configuredAnswerSynthesizer(process.env.RETRIEVAL_ANSWER_MODEL);
const media = configuredMedia(process.env),
  push = configuredPush(process.env);
const commerce = configuredCommerce(process.env, process.env.WEB_ORIGIN ?? 'http://localhost:3000');
const app = await buildApp(db, {
  ...(commerce ? { commerce } : {}),
  ...(media ? { media } : {}),
  ...(process.env.CALL_RECORDING_DIRECTORY
    ? { recordingDirectory: resolve(process.env.CALL_RECORDING_DIRECTORY) }
    : {}),
  push,
  ...(retrievalAnswers ? { answers: retrievalAnswers } : {}),
  ...(textExtractor ? { textExtractor } : {}),
  ...(retrievalEmbeddings ? { embeddings: retrievalEmbeddings } : {}),
  connectorOAuth,
  connectorDatabaseHosts: (process.env.CONNECTOR_DATABASE_HOSTS ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
  connectorWebhookHosts: (process.env.CONNECTOR_WEBHOOK_HOSTS ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
  publicApiOrigins: (process.env.PUBLIC_API_ORIGINS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
  remoteMcpHosts: (process.env.REMOTE_MCP_HOSTS ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
  developerWebhookHosts: (process.env.DEVELOPER_WEBHOOK_HOSTS ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
  toolProviderHosts,
  agentWebhookHosts,
  ...(calendar ? { calendar } : {}),
  federation: {
    allowedHosts: (process.env.IDENTITY_PROVIDER_HOSTS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  },
  organization: { region: process.env.DEPLOYMENT_REGION ?? 'global' },
  ...(process.env.IDENTITY_ENCRYPTION_KEY || process.env.EMAIL_ENCRYPTION_KEY
    ? { identityKey: process.env.IDENTITY_ENCRYPTION_KEY || process.env.EMAIL_ENCRYPTION_KEY! }
    : {}),
  email,
  files,
  ...(process.env.REALTIME_CURSOR_KEY || process.env.EMAIL_ENCRYPTION_KEY
    ? { realtimeKey: process.env.REALTIME_CURSOR_KEY || process.env.EMAIL_ENCRYPTION_KEY! }
    : {}),
  runtime,
  ...(byokPublicKey ? { byokPublicKey } : {}),
  ...(process.env.IDENTITY_PREVIOUS_KEYS_JSON
    ? { identityPreviousKeys: parsePreviousIdentityKeys(process.env.IDENTITY_PREVIOUS_KEYS_JSON) }
    : {}),
  ...(process.env.OPERATIONS_METRICS_TOKEN
    ? { metricsToken: process.env.OPERATIONS_METRICS_TOKEN }
    : {}),
  trustedProxies: (process.env.TRUSTED_PROXY_CIDRS ?? '').split(',').filter(Boolean),
  production,
  origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  logger: true,
});
const sandboxCredentials =
  process.env.TOOL_SANDBOX_TOKEN &&
  process.env.TOOL_SANDBOX_TEAM_ID &&
  process.env.TOOL_SANDBOX_PROJECT_ID
    ? {
        token: process.env.TOOL_SANDBOX_TOKEN,
        teamId: process.env.TOOL_SANDBOX_TEAM_ID,
        projectId: process.env.TOOL_SANDBOX_PROJECT_ID,
      }
    : undefined;
const connectorWebhookHosts = (process.env.CONNECTOR_WEBHOOK_HOSTS ?? '')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const connectionSecrets = IdentitySecrets.fromEnvironment(process.env);
const connectionService = new ConnectionService(
  db,
  connectionSecrets,
  connectorProvider(
    (process.env.CONNECTOR_DATABASE_HOSTS ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  ),
  async (provider, credential) => {
    const oauth = connectorOAuth[provider];
    if (!oauth) throw new Error('OAuth provider unavailable.');
    return oauth.refresh(credential);
  },
);
const processRole = process.env.PROCESS_ROLE ?? 'all';
if (!['api', 'worker', 'all'].includes(processRole))
  throw new Error('PROCESS_ROLE must be api, worker, or all.');
const startWorker = (worker: { start: () => () => Promise<void> }) =>
  processRole === 'api' ? async () => {} : worker.start();
const stopToolActions = startWorker(
  new ToolActionWorker(
    db,
    connectionSecrets,
    actionProvider(toolProviderHosts),
    process.env.TOOL_SANDBOX_PROVIDER === 'docker' && process.env.TOOL_SANDBOX_ENABLED === 'true'
      ? dockerSandboxExecutor(process.env)
      : sandboxExecutor(process.env.TOOL_SANDBOX_ENABLED === 'true', sandboxCredentials),
    (code) => app.log.error({ code }, 'Tool action failed'),
    new NativeConnectorActions(db, connectionService),
    remoteMcp(
      (process.env.REMOTE_MCP_HOSTS ?? '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
    ),
  ),
);
const stopConnectionEvents = startWorker(
  new ConnectionEventWorker(
    db,
    connectionService,
    connectionSecrets,
    webhookSender(connectorWebhookHosts),
    (code) => app.log.error({ code }, 'Connector event failed'),
  ),
);
const stopEmbeddings = retrievalEmbeddings
  ? startWorker(
      new EmbeddingWorker(db, retrievalEmbeddings, (code) =>
        app.log.error({ code }, 'Embedding job failed'),
      ),
    )
  : async () => {};
const stopRetrieval = startWorker(
  new RetrievalWorker(db, (code) => app.log.error({ code }, 'Retrieval indexing failed')),
);
const stopKnowledge = startWorker(
  new KnowledgeWorker(db, (code) => app.log.error({ code }, 'Knowledge maintenance failed')),
);
const stopWorker = startWorker(
  new ExecutionWorker(
    db,
    runtime,
    (error) => app.log.error({ err: error }, 'Execution worker failed'),
    IdentitySecrets.fromEnvironment(process.env),
  ),
);
const stopAgentDelivery = startWorker(
  new AgentDeliveryWorker(
    db,
    IdentitySecrets.fromEnvironment(process.env),
    webhookSender(agentWebhookHosts),
    (code) => app.log.error({ code }, 'Agent delivery failed'),
  ),
);
const stopEmail = startWorker(
  new EmailWorker(db, email, (code) => app.log.error({ code }, 'Email delivery failed')),
);
const stopCalls = startWorker(
  new CallWorker(
    db,
    media,
    process.env.CALL_RECORDING_DIRECTORY
      ? resolve(process.env.CALL_RECORDING_DIRECTORY)
      : undefined,
    (code) => app.log.error({ code }, 'Call maintenance failed'),
  ),
);
const stopNotificationDelivery = startWorker(
  new NotificationDeliveryWorker(
    db,
    IdentitySecrets.fromEnvironment(process.env),
    email,
    push,
    (code) => app.log.error({ code }, 'Notification delivery failed'),
  ),
);
const stopFiles = startWorker(
  new FileCleanupWorker(
    db,
    files.store,
    (error) => app.log.error({ err: error }, 'File cleanup failed'),
    files.stagingDirectory,
  ),
);
const stopBilling = startWorker(
  new BillingWorker(db, commerce, (code) =>
    app.log.error({ code }, 'Billing reconciliation failed'),
  ),
);
const stopFileGovernance = startWorker(
  new FileGovernanceWorker(db, files, (code) => app.log.error({ code }, 'File governance failed')),
);
const stopActivity = startWorker(
  new ActivityCleanupWorker(db, (error) =>
    app.log.error({ err: error }, 'Activity cleanup failed'),
  ),
);
const stopIdentity = startWorker(
  new IdentityCleanupWorker(db, (code) => app.log.error({ code }, 'Identity cleanup failed')),
);
const stopMessageDelivery = startWorker(
  new MessageDeliveryWorker(db, (code) => app.log.error({ code }, 'Message delivery failed')),
);
const stopScheduling = startWorker(
  new TaskSchedulingWorker(db, (error) => app.log.error({ err: error }, 'Task scheduler failed')),
);
const stopDeveloperWebhooks = startWorker(
  new DeveloperWebhookWorker(
    db,
    connectionSecrets,
    webhookSender(
      (process.env.DEVELOPER_WEBHOOK_HOSTS ?? '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
    ),
    (code) => app.log.error({ code }, 'Developer webhook failed'),
  ),
);
const stopSharedRetention = startWorker(
  new SharedRetentionWorker(db, (code) => app.log.error({ code }, 'Shared retention failed')),
);
const stopMigrations = startWorker(
  new MigrationWorker(db, (code) => app.log.error({ code }, 'Migration worker failed')),
);
const stopAutomations = startWorker(
  new AutomationWorker(
    db,
    (code) => app.log.error({ code }, 'Automation failed'),
    runtime.configured,
  ),
);
const stopWorkflows = startWorker(
  new WorkflowWorker(
    db,
    (error) => app.log.error({ err: error }, 'Workflow worker failed'),
    runtime.configured,
  ),
);
const stopCalendar = startWorker(
  new CalendarSyncWorker(
    db,
    calendar ?? null,
    IdentitySecrets.fromEnvironment(process.env),
    (code) => app.log.error({ code }, 'Calendar sync failed'),
  ),
);
const stopLifecycle = startWorker(
  new LifecycleWorker(db, (code) => app.log.error({ code }, 'Lifecycle job failed')),
);
app.addHook('onClose', async () => {
  await Promise.all([
    stopLifecycle(),
    stopWorker(),
    stopToolActions(),
    stopKnowledge(),
    stopRetrieval(),
    stopEmbeddings(),
    stopConnectionEvents(),
    stopAgentDelivery(),
    stopEmail(),
    stopCalls(),
    stopNotificationDelivery(),
    stopFiles(),
    stopFileGovernance(),
    stopBilling(),
    stopActivity(),
    stopIdentity(),
    stopScheduling(),
    stopWorkflows(),
    stopAutomations(),
    stopMigrations(),
    stopSharedRetention(),
    stopDeveloperWebhooks(),
    stopCalendar(),
    stopMessageDelivery(),
  ]);
});
if (processRole === 'worker')
  await writeFile('/tmp/orbit-worker-heartbeat', String(Date.now()), { mode: 0o600 });
const keepAlive =
  processRole === 'worker'
    ? setInterval(() => {
        void writeFile('/tmp/orbit-worker-heartbeat', String(Date.now()), { mode: 0o600 }).catch(
          () => app.log.error({ code: 'WORKER_HEARTBEAT_FAILED' }, 'Worker heartbeat failed'),
        );
      }, 15000)
    : undefined;
app.addHook('onClose', async () => {
  if (keepAlive) clearInterval(keepAlive);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
await app.ready();
if (processRole !== 'worker')
  await app.listen({
    port: Number(process.env.API_PORT ?? 4000),
    host: process.env.API_HOST ?? '127.0.0.1',
  });
