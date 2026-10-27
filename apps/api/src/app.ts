import { randomBytes } from 'node:crypto';
import { postgresRateStore } from './operations/limiter.js';
import { operationTelemetry } from './operations/metrics.js';
import { operationRoutes } from './modules/operations.js';
import { governanceRoutes } from './modules/governance.js';
import { interoperabilityRoutes } from './modules/interoperability.js';
import { clientPreferenceRoutes } from './modules/client-preferences.js';
import { billingRoutes } from './modules/billing.js';
import type { CommerceProvider } from './billing/stripe.js';
import { fileGovernanceRoutes } from './modules/file-governance.js';
import { callRoutes } from './modules/calls.js';
import type { CallMedia } from './calls/provider.js';
import { notificationDeliveryRoutes } from './modules/notification-delivery.js';
import type { PushProvider } from './notifications/delivery-providers.js';
import { developerCors, publicDeveloperPath } from './developer/cors.js';
import { remoteMcp, type RemoteMcp } from './developer/remote-mcp.js';
import { remoteMcpRoutes } from './modules/remote-mcp.js';
import { developerWebhookRoutes } from './developer/webhooks.js';
import { developerRoutes } from './modules/developer.js';
import { developerOAuthRoutes } from './developer/oauth.js';
import { publicApiRoutes } from './developer/public-api.js';
import { mcpRoutes } from './developer/mcp.js';
import { automationRoutes } from './modules/automations.js';
import { connectionEventRoutes } from './modules/connection-events.js';
import { ConnectionService } from './connections/service.js';
import { memoryConsentRoutes } from './modules/memory-consent.js';
import { connectionNativeEventRoutes } from './modules/connection-native-events.js';
import type { AnswerSynthesizer } from './retrieval/answers.js';
import { connectorProvider } from './connections/provider.js';
import { connectorOAuthRoutes } from './modules/connection-oauth.js';
import type { ConnectorOAuthProviders } from './connections/oauth.js';
import { connectionRoutes } from './modules/connections.js';
import type { ConnectorProvider } from './connections/provider.js';
import { retrievalRoutes, type TextExtractor } from './modules/retrieval.js';
import type { Embeddings } from './retrieval/service.js';
import { toolReconciliationRoutes } from './modules/tool-reconciliation.js';
import { knowledgeHistoryRoutes } from './modules/knowledge-history.js';
import { toolRoutes } from './modules/tools.js';
import { knowledgeAuthoringRoutes } from './modules/knowledge-authoring.js';
import { calendarRoutes } from './modules/calendar.js';
import type { CalendarProvider } from './calendar/google.js';
import { workflowRoutes } from './modules/workflows.js';
import { projectReportingRoutes } from './modules/project-reporting.js';
import { taskWorkRoutes } from './modules/task-work.js';
import { collectionPageRoutes } from './modules/collection-pages.js';
import { channelManagementRoutes } from './modules/channel-management.js';
import { personalMessagingRoutes } from './modules/personal-messaging.js';
import { projectRoutes } from './modules/projects.js';
import { schedulingRoutes } from './modules/scheduling.js';
import { taskRoutes } from './modules/tasks.js';
import { activityRoutes } from './modules/activity.js';
import { searchRoutes } from './modules/search.js';
import { knowledgeRoutes } from './modules/knowledge.js';
import { notificationRoutes } from './modules/notifications.js';
import multipart from '@fastify/multipart';
import { fileRoutes } from './modules/files.js';
import type { FileDependencies } from './files/config.js';
import { conversationRoutes } from './modules/conversations.js';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { scopedDatabase, requestScope, type Database } from '@ao/database';
import { accountRoutes } from './modules/account.js';
import { messagingRoutes } from './modules/messaging.js';
import { realtimeRoutes } from './modules/realtime.js';
import { EmailService } from './email/service.js';
import { AppError } from './lib/errors.js';
import { teamRoutes } from './modules/team.js';
import { authRoutes } from './modules/auth.js';
import { collaborationRoutes } from './modules/collaboration.js';
import { workRoutes } from './modules/work.js';
import { executionRoutes } from './modules/execution.js';
import { EveRuntime } from './execution/runtime.js';
import { IdentitySecrets } from './identity/secrets.js';
import { AccountSecurity } from './identity/security.js';
import { accountManagementRoutes } from './modules/account-management.js';
import { organizationRoutes, type OrganizationOptions } from './modules/organizations.js';
import { memberAccessRoutes } from './modules/member-access.js';
import { FederationService, type FederationOptions } from './identity/federation.js';
import { federationRoutes } from './modules/federation.js';
import { scimRoutes } from './modules/scim.js';
import type { HostedRuntime } from './execution/types.js';
import { agentControlRoutes } from './modules/agent-control.js';
import { executionControlRoutes } from './modules/execution-control.js';
export async function buildApp(
  db: Database,
  options: {
    production?: boolean;
    sharedRateLimits?: boolean;
    metricsToken?: string;
    trustedProxies?: string[];
    commerce?: CommerceProvider;
    media?: CallMedia;
    recordingDirectory?: string;
    push?: PushProvider;
    origin?: string;
    logger?: boolean;
    runtime?: HostedRuntime;
    email?: EmailService;
    realtimeKey?: string;
    files?: FileDependencies;
    identityKey?: string;
    byokPublicKey?: string;
    identityPreviousKeys?: string[];
    organization?: OrganizationOptions;
    federation?: FederationOptions;
    calendar?: CalendarProvider;
    connectors?: ConnectorProvider;
    connectorOAuth?: ConnectorOAuthProviders;
    connectorWebhookHosts?: string[];
    connectorDatabaseHosts?: string[];
    embeddings?: Embeddings;
    textExtractor?: TextExtractor;
    answers?: AnswerSynthesizer;
    agentWebhookHosts?: string[];
    toolProviderHosts?: string[];
    remoteMcp?: RemoteMcp;
    remoteMcpHosts?: string[];
    developerWebhookHosts?: string[];
    publicApiOrigins?: string[];
  } = {},
) {
  if (options.production && options.email?.provider?.id === 'mailpit')
    throw new Error('Mailpit cannot be used in production.');
  if (options.production && !options.realtimeKey)
    throw new Error('A stable realtime cursor key is required in production.');
  if (options.production && options.federation?.allowLoopback)
    throw new Error('Loopback identity providers cannot be enabled in production.');
  if (!['global', 'us', 'eu', 'in', 'ap'].includes(options.organization?.region ?? 'global'))
    throw new Error('DEPLOYMENT_REGION must be global, us, eu, in, or ap.');
  for (const value of options.publicApiOrigins ?? []) {
    const u = new URL(value);
    if (
      u.origin !== value ||
      !(
        u.protocol === 'https:' ||
        (!options.production &&
          u.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      )
    )
      throw new Error(
        'PUBLIC_API_ORIGINS must contain exact HTTPS origins (loopback HTTP is development-only).',
      );
  }
  db = scopedDatabase(db);
  if (options.trustedProxies?.some((v) => ['*', '0.0.0.0/0', '::/0'].includes(v)))
    throw new Error('Trust only the explicit proxy addresses.');
  const app = Fastify({
    genReqId: () => randomBytes(16).toString('hex'),
    ...(options.trustedProxies?.length ? { trustProxy: options.trustedProxies } : {}),
    logger: options.logger
      ? {
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
          serializers: {
            err(error: unknown) {
              const value = error as { name?: string; code?: string };
              return {
                type: value.name ?? 'Error',
                message: 'Internal operation failed',
                stack: '',
                code:
                  value.code && /^[A-Z0-9_]{1,60}$/.test(value.code)
                    ? value.code
                    : 'UNEXPECTED_ERROR',
              };
            },
            req(request: FastifyRequest) {
              return {
                method: request.method,
                url: request.url.split('?')[0]!,
                hostname: request.hostname,
                remoteAddress: request.ip,
              };
            },
          },
        }
      : false,
    bodyLimit: 400000,
    requestTimeout: 125000,
  });
  app.addHook('onRequest', (_request, reply, done) => {
    reply.header('cache-control', 'no-store');
    requestScope(done);
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    ...((options.sharedRateLimits ?? options.production)
      ? {
          store: postgresRateStore(
            db,
            options.realtimeKey ?? 'development-shared-limiter-fixture-key',
          ),
        }
      : {}),
    skipOnError: false,
  });
  operationTelemetry(app, db, options.metricsToken);
  operationRoutes(app, db);
  developerCors(app, options.origin ?? 'http://localhost:3000', options.publicApiOrigins ?? []);
  app.addHook('onRequest', async (req) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== (options.origin ?? 'http://localhost:3000') &&
      !publicDeveloperPath(req.url) &&
      !(req.method === 'POST' && /^\/v1\/auth\/federation\/[0-9a-f-]{36}\/callback$/.test(req.url))
    )
      throw new AppError(403, 'INVALID_ORIGIN', 'This request origin is not allowed.');
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          requestId: req.id,
        },
      });
    if (error instanceof AppError)
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error instanceof Error ? error.message : 'Invalid request.',
          requestId: req.id,
        },
      });
    const dbCode = (error as { code?: string }).code;
    if (dbCode === 'AOG01' || dbCode === 'AOG02')
      return reply.code(409).send({
        error: {
          code: dbCode === 'AOG01' ? 'GOVERNANCE_DENIED' : 'LEGAL_HOLD',
          message:
            dbCode === 'AOG01'
              ? 'The organization policy does not allow this operation.'
              : 'This content is protected by a legal hold.',
          requestId: req.id,
        },
      });
    if (dbCode === '42501')
      return reply.code(403).send({
        error: {
          code: 'PERMISSION_DENIED',
          message: 'This account cannot access or modify this resource.',
          requestId: req.id,
        },
      });
    const taskErrors: Record<string, [string, string]> = {
      AOB01: ['HUMAN_SEAT_LIMIT', 'This organization has reached its human-seat allowance.'],
      AOB02: [
        'COMMERCIAL_LIMIT',
        'The organization usage allowance or hard budget has been reached.',
      ],
      AOB03: ['RESERVATION_CONFLICT', 'This usage reservation has different parameters.'],
      AOM11: [
        'SOURCE_OWNS_CONTENT',
        'Use the migration conflict controls to change a source-owned message.',
      ],
      AOM01: [
        'GROUP_MANAGEMENT_REQUIRED',
        'Use group participant management to expand an existing private group.',
      ],
      AOM02: [
        'HISTORY_CONSENT_REQUIRED',
        'Existing participants must approve sharing earlier private group history.',
      ],
      AOP01: [
        'PROJECT_SCOPE_MISMATCH',
        'The milestone, project and task must have matching scopes.',
      ],
      AOP02: ['PROJECT_CLOSED', 'Reopen the project before assigning new work.'],
      AOP03: ['MILESTONE_CLOSED', 'Reopen the milestone before assigning new work.'],
      AOP04: ['PROJECT_HAS_OPEN_TASKS', 'Close all project tasks before completing the project.'],
      AOP05: [
        'MILESTONE_HAS_OPEN_TASKS',
        'Close all milestone tasks before completing the milestone.',
      ],
      AOP06: ['LABEL_ARCHIVED', 'An archived label cannot be assigned.'],
      AOP07: ['LABEL_LIMIT', 'A task supports up to 20 labels.'],
      AOT05: [
        'ACCEPTANCE_REQUIRED',
        'Verify every required acceptance criterion before completion.',
      ],
      AOT01: ['TASK_CYCLE', 'This relationship would create a task cycle.'],
      AOT02: ['TASK_SCOPE_MISMATCH', 'Related tasks must share the same audience.'],
      AOT03: [
        'DEPENDENCIES_UNRESOLVED',
        'Finish prerequisites before starting or completing dependent work.',
      ],
      AOT04: ['SUBTASKS_OPEN', 'Close all subtasks before completing or cancelling their parent.'],
    };
    if (dbCode && taskErrors[dbCode]) {
      const [code, message] = taskErrors[dbCode];
      return reply.code(409).send({ error: { code, message, requestId: req.id } });
    }
    if (dbCode === '23505')
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: 'This record already exists.', requestId: req.id },
      });
    if (dbCode === '23503')
      return reply.code(400).send({
        error: {
          code: 'INVALID_REFERENCE',
          message: 'A referenced resource is unavailable.',
          requestId: req.id,
        },
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.code(status).send({
        error: {
          code: 'INVALID_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid request.',
          requestId: req.id,
        },
      });
    req.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
        requestId: req.id,
      },
    });
  });
  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });
  const email =
    options.email ??
    new EmailService(null, undefined, undefined, options.origin ?? 'http://localhost:3000');
  accountRoutes(app, db, email);
  governanceRoutes(app, db, options.files, options.byokPublicKey);
  clientPreferenceRoutes(app, db);
  const security = new AccountSecurity(
    db,
    new IdentitySecrets(options.identityKey, options.identityPreviousKeys),
  );
  accountManagementRoutes(app, db, security, email, options.production ?? false);
  organizationRoutes(app, db, options.organization);
  billingRoutes(app, db, options.commerce);
  memberAccessRoutes(app, db);
  scimRoutes(app, db, options.origin ?? 'http://localhost:3000');
  federationRoutes(
    app,
    db,
    new FederationService(
      db,
      security,
      options.origin ?? 'http://localhost:3000',
      options.federation,
    ),
    options.production ?? false,
  );
  authRoutes(
    app,
    db,
    options.production ?? false,
    email,
    security,
    options.organization?.region ?? 'global',
  );
  teamRoutes(app, db, options.production ?? false, email);
  collaborationRoutes(app, db);
  conversationRoutes(app, db);
  fileRoutes(app, db, options.files);
  fileGovernanceRoutes(app, db, options.files);
  messagingRoutes(app, db);
  collectionPageRoutes(app, db);
  personalMessagingRoutes(app, db);
  channelManagementRoutes(app, db);
  notificationRoutes(app, db);
  notificationDeliveryRoutes(
    app,
    db,
    new IdentitySecrets(options.identityKey, options.identityPreviousKeys),
    options.push,
  );
  callRoutes(app, db, options.media, options.recordingDirectory);
  activityRoutes(app, db);
  realtimeRoutes(
    app,
    db,
    options.origin ?? 'http://localhost:3000',
    options.realtimeKey,
    options.publicApiOrigins,
  );
  workRoutes(app, db);
  taskRoutes(app, db, options.realtimeKey);
  taskWorkRoutes(app, db, options.runtime?.configured ?? false);
  workflowRoutes(app, db);
  automationRoutes(app, db);
  developerRoutes(app, db);
  remoteMcpRoutes(
    app,
    db,
    new IdentitySecrets(options.identityKey, options.identityPreviousKeys),
    options.remoteMcp ?? remoteMcp(options.remoteMcpHosts ?? []),
  );
  developerWebhookRoutes(
    app,
    db,
    new IdentitySecrets(options.identityKey, options.identityPreviousKeys),
    options.developerWebhookHosts ?? [],
  );
  developerOAuthRoutes(app, db, options.origin ?? 'http://localhost:3000');
  publicApiRoutes(app);
  mcpRoutes(app, db, options.origin ?? 'http://localhost:3000', options.publicApiOrigins);
  interoperabilityRoutes(
    app,
    db,
    new IdentitySecrets(options.identityKey, options.identityPreviousKeys),
    options.files,
  );
  projectReportingRoutes(app, db);
  projectRoutes(app, db);
  schedulingRoutes(app, db);
  calendarRoutes(
    app,
    db,
    options.calendar ?? null,
    new IdentitySecrets(options.identityKey, options.identityPreviousKeys),
    options.origin ?? 'http://localhost:3000',
  );
  searchRoutes(app, db, options.realtimeKey);
  memoryConsentRoutes(app, db);
  retrievalRoutes(app, db, {
    ...(options.answers ? { answers: options.answers } : {}),
    ...(options.embeddings ? { embeddings: options.embeddings } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.textExtractor ? { extractor: options.textExtractor } : {}),
  });
  const connectorSecrets = new IdentitySecrets(options.identityKey, options.identityPreviousKeys);
  const connectionService = new ConnectionService(
    db,
    connectorSecrets,
    options.connectors ?? connectorProvider(options.connectorDatabaseHosts),
    async (provider, credential) => {
      const oauth = options.connectorOAuth?.[provider];
      if (!oauth)
        throw new AppError(
          503,
          'CONNECTOR_OAUTH_UNAVAILABLE',
          'This OAuth provider is not configured.',
        );
      return oauth.refresh(credential);
    },
  );
  connectionRoutes(app, db, connectorSecrets, options.connectors, connectionService);
  connectionEventRoutes(app, db, connectorSecrets, options.connectorWebhookHosts);
  connectionNativeEventRoutes(app, db, connectorSecrets);
  connectorOAuthRoutes(
    app,
    db,
    connectorSecrets,
    options.connectorOAuth ?? {},
    connectionService,
    options.origin ?? 'http://localhost:3000',
  );
  toolReconciliationRoutes(app, db);
  knowledgeRoutes(app, db);
  knowledgeAuthoringRoutes(app, db);
  knowledgeHistoryRoutes(app, db);
  toolRoutes(
    app,
    db,
    new IdentitySecrets(options.identityKey, options.identityPreviousKeys),
    options.toolProviderHosts,
  );
  executionRoutes(app, db, options.runtime ?? new EveRuntime(undefined, undefined));
  const hostedRuntime = options.runtime ?? new EveRuntime(undefined, undefined);
  agentControlRoutes(
    app,
    db,
    hostedRuntime,
    new IdentitySecrets(options.identityKey, options.identityPreviousKeys),
    options.agentWebhookHosts,
  );
  executionControlRoutes(app, db, hostedRuntime);
  return app;
}
