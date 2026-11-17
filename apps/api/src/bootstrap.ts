import { backgroundDatabase } from './background/database.js';
import { backgroundWakeups } from './background/http.js';
import { BackgroundDispatcher, type BackgroundWorker } from './background/dispatcher.js';
import { vercelBackgroundQueue, type BackgroundPublisher } from './background/queue.js';
import { attachDatabasePool } from '@vercel/functions';
import { defaultAgentModel, defaultAgentPricing } from '@ao/models/configuration';
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
import {
  database,
  migrate,
  assertRuntimeConnection,
  scopedDatabase,
  decodeDatabaseCertificate,
} from '@ao/database';
import { resolve } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { EveRuntime, parseModelPricing } from './execution/runtime.js';
import { configuredEmail } from './email/service.js';
import { EmailWorker } from './email/worker.js';
import { ExecutionWorker } from './execution/worker.js';
import { AgentDeliveryWorker, webhookSender } from './agents/webhooks.js';
export async function createApplication(
  env: NodeJS.ProcessEnv = process.env,
  options: { backgroundPublisher?: BackgroundPublisher } = {},
) {
  const production = env.NODE_ENV === 'production';
  if (production && env.TOOL_SANDBOX_PROVIDER === 'docker')
    throw new Error('Local Docker sandboxes cannot be selected in production.');
  if (production && !env.DATABASE_URL) throw new Error('DATABASE_URL is required in production.');
  if (production && !env.WEB_ORIGIN?.startsWith('https://'))
    throw new Error('An HTTPS WEB_ORIGIN is required in production.');
  const connection = await database(
    env.DATABASE_URL
      ? {
          url: env.DATABASE_URL,
          ...(env.VERCEL === '1' ? { onPoolCreated: attachDatabasePool } : {}),
          ...(env.DATABASE_POOL_MAX ? { maxConnections: Number(env.DATABASE_POOL_MAX) } : {}),
          ...(env.DATABASE_CA_CERT_BASE64
            ? { caCertificate: decodeDatabaseCertificate(env.DATABASE_CA_CERT_BASE64) }
            : {}),
          onPoolError: (code) =>
            process.stderr.write(
              JSON.stringify({ level: 'error', code, message: 'Idle database connection failed' }) +
                '\n',
            ),
        }
      : {
          directory: resolve(
            fileURLToPath(new URL('../../../', import.meta.url)),
            '.data/postgres',
          ),
        },
  );
  try {
    if (production) {
      await assertRuntimeConnection(connection, {
        sharedLogin: env.DATABASE_CONNECTION_MODE === 'shared',
      });
      if (env.DATABASE_CONNECTION_MODE === 'shared')
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            code: 'SHARED_DATABASE_LOGIN',
            message:
              'API, worker and migrations share database authority. Queries remain role-scoped; credential isolation is reduced.',
          }) + '\n',
        );
    } else await migrate(connection);
    const db = scopedDatabase(connection);
    const platformRuntime = new EveRuntime(env.EVE_RUNTIME_URL, env.EVE_SERVICE_TOKEN, {
      durabilityQualified: env.EVE_DURABILITY_QUALIFIED === 'true',
      pricing: parseModelPricing(env.AGENT_MODEL_PRICING_JSON ?? defaultAgentPricing),
      defaultModel: env.AGENT_MODEL ?? defaultAgentModel,
      models: (env.AGENT_APPROVED_MODELS?.trim() || env.AGENT_MODEL || defaultAgentModel)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    });
    const byokPublicKey = env.BYOK_WRAPPING_PUBLIC_KEY_FILE
      ? await readFile(env.BYOK_WRAPPING_PUBLIC_KEY_FILE, 'utf8')
      : undefined;
    const signingKey = env.BYOK_CAPABILITY_SIGNING_KEY_FILE
      ? await readFile(env.BYOK_CAPABILITY_SIGNING_KEY_FILE, 'utf8')
      : undefined;
    const runtime = new RoutedRuntime(
      scopedDatabase(db),
      platformRuntime,
      env.MODEL_BROKER_URL
        ? { url: env.MODEL_BROKER_URL, ...(signingKey ? { signingKey } : {}) }
        : undefined,
    );
    const agentWebhookHosts = (env.AGENT_WEBHOOK_HOSTS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const email = configuredEmail(env, env.WEB_ORIGIN ?? 'http://localhost:3000');
    if (production) email.requireConfigured();
    const files = configuredFiles(
      env,
      resolve(fileURLToPath(new URL('../../../', import.meta.url))),
    );
    const calendar =
      env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET
        ? new GoogleCalendarProvider(
            env.GOOGLE_CALENDAR_CLIENT_ID,
            env.GOOGLE_CALENDAR_CLIENT_SECRET,
            (env.WEB_ORIGIN ?? 'http://localhost:3000') + '/api/v1/calendar/google/callback',
          )
        : undefined;
    const toolProviderHosts = (env.TOOL_PROVIDER_HOSTS ?? '')
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
      const clientId = env[prefix + '_CLIENT_ID'],
        secret = env[prefix + '_CLIENT_SECRET'];
      if (clientId && secret)
        connectorOAuth[provider] = new FixedConnectorOAuth(
          provider,
          clientId,
          secret,
          (env.WEB_ORIGIN ?? 'http://localhost:3000') +
            '/api/v1/connections/oauth/' +
            provider +
            '/callback',
        );
    }
    const textExtractor = configuredTextExtractor(env.RETRIEVAL_OCR_MODEL);
    const retrievalEmbeddings = configuredEmbeddings(env.RETRIEVAL_EMBEDDING_MODEL);
    const retrievalAnswers = configuredAnswerSynthesizer(
      env.RETRIEVAL_ANSWER_MODEL ?? (env.GROQ_API_KEY ? defaultAgentModel : undefined),
    );
    const media = configuredMedia(env),
      push = configuredPush(env);
    const commerce = configuredCommerce(env, env.WEB_ORIGIN ?? 'http://localhost:3000');
    const app = await buildApp(db, {
      ...(commerce ? { commerce } : {}),
      ...(media ? { media } : {}),
      ...(env.CALL_RECORDING_DIRECTORY
        ? { recordingDirectory: resolve(env.CALL_RECORDING_DIRECTORY) }
        : {}),
      push,
      ...(retrievalAnswers ? { answers: retrievalAnswers } : {}),
      ...(textExtractor ? { textExtractor } : {}),
      ...(retrievalEmbeddings ? { embeddings: retrievalEmbeddings } : {}),
      connectorOAuth,
      connectorDatabaseHosts: (env.CONNECTOR_DATABASE_HOSTS ?? '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
      connectorWebhookHosts: (env.CONNECTOR_WEBHOOK_HOSTS ?? '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
      publicApiOrigins: (env.PUBLIC_API_ORIGINS ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      remoteMcpHosts: (env.REMOTE_MCP_HOSTS ?? '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
      developerWebhookHosts: (env.DEVELOPER_WEBHOOK_HOSTS ?? '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
      toolProviderHosts,
      agentWebhookHosts,
      ...(calendar ? { calendar } : {}),
      federation: {
        allowedHosts: (env.IDENTITY_PROVIDER_HOSTS ?? '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      },
      organization: { region: env.DEPLOYMENT_REGION ?? 'global' },
      ...(env.IDENTITY_ENCRYPTION_KEY || env.EMAIL_ENCRYPTION_KEY
        ? { identityKey: env.IDENTITY_ENCRYPTION_KEY || env.EMAIL_ENCRYPTION_KEY! }
        : {}),
      email,
      files,
      ...(env.REALTIME_CURSOR_KEY || env.EMAIL_ENCRYPTION_KEY
        ? { realtimeKey: env.REALTIME_CURSOR_KEY || env.EMAIL_ENCRYPTION_KEY! }
        : {}),
      runtime,
      ...(byokPublicKey ? { byokPublicKey } : {}),
      ...(env.IDENTITY_PREVIOUS_KEYS_JSON
        ? { identityPreviousKeys: parsePreviousIdentityKeys(env.IDENTITY_PREVIOUS_KEYS_JSON) }
        : {}),
      ...(env.OPERATIONS_METRICS_TOKEN ? { metricsToken: env.OPERATIONS_METRICS_TOKEN } : {}),
      trustedProxies: (env.TRUSTED_PROXY_CIDRS ?? '').split(',').filter(Boolean),
      production,
      origin: env.WEB_ORIGIN ?? 'http://localhost:3000',
      logger: true,
    });
    const sandboxCredentials =
      env.TOOL_SANDBOX_TOKEN && env.TOOL_SANDBOX_TEAM_ID && env.TOOL_SANDBOX_PROJECT_ID
        ? {
            token: env.TOOL_SANDBOX_TOKEN,
            teamId: env.TOOL_SANDBOX_TEAM_ID,
            projectId: env.TOOL_SANDBOX_PROJECT_ID,
          }
        : undefined;
    const connectorWebhookHosts = (env.CONNECTOR_WEBHOOK_HOSTS ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    const connectionSecrets = IdentitySecrets.fromEnvironment(env);
    const connectionService = new ConnectionService(
      db,
      connectionSecrets,
      connectorProvider(
        (env.CONNECTOR_DATABASE_HOSTS ?? '')
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
    const processRole = env.PROCESS_ROLE ?? 'all';
    if (!['api', 'worker', 'all'].includes(processRole))
      throw new Error('PROCESS_ROLE must be api, worker, or all.');
    const onDemand = env.BACKGROUND_MODE === 'on-demand';
    const workers = new Map<string, BackgroundWorker>();
    const workerDb = (name: string) => (onDemand ? backgroundDatabase(connection, name) : db);
    const startWorker = (name: string, worker: BackgroundWorker) => {
      workers.set(name, worker);
      return processRole === 'api' || onDemand ? async () => {} : worker.start();
    };
    const stopToolActions = startWorker(
      'tools',
      new ToolActionWorker(
        workerDb('tools'),
        connectionSecrets,
        actionProvider(toolProviderHosts),
        env.TOOL_SANDBOX_PROVIDER === 'docker' && env.TOOL_SANDBOX_ENABLED === 'true'
          ? dockerSandboxExecutor(env)
          : sandboxExecutor(env.TOOL_SANDBOX_ENABLED === 'true', sandboxCredentials),
        (code) => app.log.error({ code }, 'Tool action failed'),
        new NativeConnectorActions(workerDb('tools'), connectionService),
        remoteMcp(
          (env.REMOTE_MCP_HOSTS ?? '')
            .split(',')
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean),
        ),
      ),
    );
    const stopConnectionEvents = startWorker(
      'connections',
      new ConnectionEventWorker(
        workerDb('connections'),
        connectionService,
        connectionSecrets,
        webhookSender(connectorWebhookHosts),
        (code) => app.log.error({ code }, 'Connector event failed'),
      ),
    );
    const stopEmbeddings = retrievalEmbeddings
      ? startWorker(
          'embeddings',
          new EmbeddingWorker(workerDb('embeddings'), retrievalEmbeddings, (code) =>
            app.log.error({ code }, 'Embedding job failed'),
          ),
        )
      : async () => {};
    const stopRetrieval = startWorker(
      'retrieval',
      new RetrievalWorker(workerDb('retrieval'), (code) =>
        app.log.error({ code }, 'Retrieval indexing failed'),
      ),
    );
    const stopKnowledge = startWorker(
      'knowledge',
      new KnowledgeWorker(workerDb('knowledge'), (code) =>
        app.log.error({ code }, 'Knowledge maintenance failed'),
      ),
    );
    const stopWorker = startWorker(
      'execution',
      new ExecutionWorker(
        workerDb('execution'),
        runtime,
        (error) => app.log.error({ err: error }, 'Execution worker failed'),
        IdentitySecrets.fromEnvironment(env),
        onDemand ? { maxConcurrent: 1, maxDispatchSeconds: 180 } : {},
      ),
    );
    const stopAgentDelivery = startWorker(
      'agent-delivery',
      new AgentDeliveryWorker(
        workerDb('agent-delivery'),
        IdentitySecrets.fromEnvironment(env),
        webhookSender(agentWebhookHosts),
        (code) => app.log.error({ code }, 'Agent delivery failed'),
      ),
    );
    const stopEmail = startWorker(
      'email',
      new EmailWorker(
        workerDb('email'),
        email,
        (code) => app.log.error({ code }, 'Email delivery failed'),
        onDemand ? 2 : 10,
      ),
    );
    const stopCalls = startWorker(
      'calls',
      new CallWorker(
        workerDb('calls'),
        media,
        env.CALL_RECORDING_DIRECTORY ? resolve(env.CALL_RECORDING_DIRECTORY) : undefined,
        (code) => app.log.error({ code }, 'Call maintenance failed'),
      ),
    );
    const stopNotificationDelivery = startWorker(
      'notifications',
      new NotificationDeliveryWorker(
        workerDb('notifications'),
        IdentitySecrets.fromEnvironment(env),
        email,
        push,
        (code) => app.log.error({ code }, 'Notification delivery failed'),
      ),
    );
    const stopFiles = startWorker(
      'files',
      new FileCleanupWorker(
        workerDb('files'),
        files.store,
        (error) => app.log.error({ err: error }, 'File cleanup failed'),
        files.stagingDirectory,
      ),
    );
    const stopBilling = startWorker(
      'billing',
      new BillingWorker(workerDb('billing'), commerce, (code) =>
        app.log.error({ code }, 'Billing reconciliation failed'),
      ),
    );
    const stopFileGovernance = startWorker(
      'file-governance',
      new FileGovernanceWorker(workerDb('file-governance'), files, (code) =>
        app.log.error({ code }, 'File governance failed'),
      ),
    );
    const stopActivity = startWorker(
      'activity',
      new ActivityCleanupWorker(workerDb('activity'), (error) =>
        app.log.error({ err: error }, 'Activity cleanup failed'),
      ),
    );
    const stopIdentity = startWorker(
      'identity',
      new IdentityCleanupWorker(workerDb('identity'), (code) =>
        app.log.error({ code }, 'Identity cleanup failed'),
      ),
    );
    const stopMessageDelivery = startWorker(
      'messages',
      new MessageDeliveryWorker(workerDb('messages'), (code) =>
        app.log.error({ code }, 'Message delivery failed'),
      ),
    );
    const stopScheduling = startWorker(
      'scheduling',
      new TaskSchedulingWorker(workerDb('scheduling'), (error) =>
        app.log.error({ err: error }, 'Task scheduler failed'),
      ),
    );
    const stopDeveloperWebhooks = startWorker(
      'developer-webhooks',
      new DeveloperWebhookWorker(
        workerDb('developer-webhooks'),
        connectionSecrets,
        webhookSender(
          (env.DEVELOPER_WEBHOOK_HOSTS ?? '')
            .split(',')
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean),
        ),
        (code) => app.log.error({ code }, 'Developer webhook failed'),
      ),
    );
    const stopSharedRetention = startWorker(
      'shared-retention',
      new SharedRetentionWorker(workerDb('shared-retention'), (code) =>
        app.log.error({ code }, 'Shared retention failed'),
      ),
    );
    const stopMigrations = startWorker(
      'migrations',
      new MigrationWorker(workerDb('migrations'), (code) =>
        app.log.error({ code }, 'Migration worker failed'),
      ),
    );
    const stopAutomations = startWorker(
      'automations',
      new AutomationWorker(
        workerDb('automations'),
        (code) => app.log.error({ code }, 'Automation failed'),
        runtime.configured,
      ),
    );
    const stopWorkflows = startWorker(
      'workflows',
      new WorkflowWorker(
        workerDb('workflows'),
        (error) => app.log.error({ err: error }, 'Workflow worker failed'),
        runtime.configured,
      ),
    );
    const stopCalendar = startWorker(
      'calendar',
      new CalendarSyncWorker(
        workerDb('calendar'),
        calendar ?? null,
        IdentitySecrets.fromEnvironment(env),
        (code) => app.log.error({ code }, 'Calendar sync failed'),
      ),
    );
    const stopLifecycle = startWorker(
      'lifecycle',
      new LifecycleWorker(workerDb('lifecycle'), (code) =>
        app.log.error({ code }, 'Lifecycle job failed'),
      ),
    );
    const background = onDemand
      ? new BackgroundDispatcher(
          db,
          workers,
          options.backgroundPublisher ?? vercelBackgroundQueue(),
        )
      : null;
    if (background && processRole === 'api') backgroundWakeups(app, background);
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
    if (processRole === 'worker' && !onDemand)
      await writeFile('/tmp/orbit-worker-heartbeat', String(Date.now()), { mode: 0o600 });
    const keepAlive =
      processRole === 'worker' && !onDemand
        ? setInterval(() => {
            void writeFile('/tmp/orbit-worker-heartbeat', String(Date.now()), {
              mode: 0o600,
            }).catch(() =>
              app.log.error({ code: 'WORKER_HEARTBEAT_FAILED' }, 'Worker heartbeat failed'),
            );
          }, 15000)
        : undefined;
    app.addHook('onClose', async () => {
      if (keepAlive) clearInterval(keepAlive);
    });
    await app.ready();
    return { app, db, background, processRole };
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}
