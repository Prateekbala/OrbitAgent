import { decodeDatabaseCertificate } from '@ao/database';
import { defaultAgentModel, defaultAgentPricing } from '@ao/models/configuration';

export class DeploymentConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'DeploymentConfigurationError';
  }
}

type DeploymentRole = 'api' | 'worker';
const privilegedCredentials = [
  'MIGRATION_DATABASE_URL',
  'ERASURE_DATABASE_URL',
  'MODEL_BROKER_DATABASE_URL',
  'BYOK_WRAPPING_PRIVATE_KEY_FILES',
];
const required = [
  'WEB_ORIGIN',
  'DEPLOYMENT_REGION',
  'IDENTITY_ENCRYPTION_KEY',
  'EMAIL_ENCRYPTION_KEY',
  'REALTIME_CURSOR_KEY',
  'OPERATIONS_METRICS_TOKEN',
  'EMAIL_PROVIDER',
  'EMAIL_FROM',
  'FILE_STORAGE_PROVIDER',
] as const;

export function deploymentEnvironment(role: DeploymentRole, source: Partial<NodeJS.ProcessEnv>) {
  const env: NodeJS.ProcessEnv = {
    DEPLOYMENT_REGION: 'in',
    EMAIL_PROVIDER: 'gmail',
    FILE_STORAGE_PROVIDER: 'cloudinary',
    AGENT_MODEL: defaultAgentModel,
    AGENT_MODEL_PRICING_JSON: defaultAgentPricing,
    RETRIEVAL_ANSWER_MODEL: defaultAgentModel,
    ...source,
    NODE_ENV: 'production',
  };
  env.AGENT_APPROVED_MODELS ??= env.AGENT_MODEL;
  if (env.EMAIL_PROVIDER === 'gmail') env.EMAIL_FROM ||= env.GMAIL_USER;
  const issues: string[] = [];
  const shared = Boolean(env.DATABASE_URL?.trim());
  const databaseKey =
    shared || (!env.API_DATABASE_URL && !env.WORKER_DATABASE_URL)
      ? 'DATABASE_URL'
      : role === 'api'
        ? 'API_DATABASE_URL'
        : 'WORKER_DATABASE_URL';
  for (const key of [databaseKey, ...required])
    if (!env[key]?.trim()) issues.push(`${key} is required`);
  if (env.DEPLOYMENT_REGION && !['global', 'us', 'eu', 'in', 'ap'].includes(env.DEPLOYMENT_REGION))
    issues.push('DEPLOYMENT_REGION must be global, us, eu, in, or ap');
  for (const key of privilegedCredentials)
    if (env[key]?.trim() || env[key + '_FILE']?.trim())
      issues.push(`${key} must not be included in the application project's environment`);
  if (shared && (env.API_DATABASE_URL?.trim() || env.WORKER_DATABASE_URL?.trim()))
    issues.push(
      'Use DATABASE_URL alone or separate API_DATABASE_URL and WORKER_DATABASE_URL values',
    );
  const poolKey = role === 'api' ? 'API_DATABASE_POOL_MAX' : 'WORKER_DATABASE_POOL_MAX';
  const poolSize = Number(env[poolKey] || 1);
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 50)
    issues.push(`${poolKey} must be an integer from 1 to 50`);
  if (env.DATABASE_CA_CERT_BASE64) {
    try {
      decodeDatabaseCertificate(env.DATABASE_CA_CERT_BASE64);
    } catch {
      issues.push(
        'DATABASE_CA_CERT_BASE64 must contain the base64-encoded database CA certificate',
      );
    }
  }
  const connection = env[databaseKey];
  if (connection) {
    try {
      const url = new URL(connection);
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !url.hostname ||
        !url.username ||
        !url.password
      )
        throw new Error();
      if (!shared && /^(postgres|supabase_admin)(\.|$)/i.test(decodeURIComponent(url.username)))
        issues.push(`${databaseKey} must use a dedicated non-owner NOINHERIT login`);
      if (url.searchParams.get('sslmode') !== 'verify-full')
        issues.push(`${databaseKey} must use sslmode=verify-full`);
    } catch {
      issues.push(`${databaseKey} must be a valid PostgreSQL connection URL`);
    }
  }
  if (env.WEB_ORIGIN) {
    try {
      const url = new URL(env.WEB_ORIGIN);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      issues.push(
        'WEB_ORIGIN must be an HTTPS origin without a path, credentials, query or fragment',
      );
    }
  }
  for (const key of ['IDENTITY_ENCRYPTION_KEY', 'EMAIL_ENCRYPTION_KEY', 'REALTIME_CURSOR_KEY']) {
    const value = env[key];
    if (!value) continue;
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== value)
      issues.push(`${key} must be a canonical base64-encoded 32-byte key`);
  }
  if (env.OPERATIONS_METRICS_TOKEN && env.OPERATIONS_METRICS_TOKEN.length < 32)
    issues.push('OPERATIONS_METRICS_TOKEN must have at least 32 characters');
  if (env.EMAIL_PROVIDER === 'resend') {
    if (!env.RESEND_API_KEY?.trim()) issues.push('RESEND_API_KEY is required');
  } else if (env.EMAIL_PROVIDER === 'gmail') {
    for (const key of ['GMAIL_USER', 'GMAIL_APP_PASSWORD'])
      if (!env[key]?.trim()) issues.push(`${key} is required`);
  } else if (env.EMAIL_PROVIDER) issues.push('EMAIL_PROVIDER must be resend or gmail');
  if (env.FILE_STORAGE_PROVIDER === 's3') {
    for (const key of ['S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])
      if (!env[key]?.trim()) issues.push(`${key} is required for S3 storage`);
  } else if (env.FILE_STORAGE_PROVIDER === 'cloudinary') {
    for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'])
      if (!env[key]?.trim()) issues.push(`${key} is required for Cloudinary storage`);
    if (env.CLOUDINARY_CLOUD_NAME && !/^[a-zA-Z0-9_-]{1,100}$/.test(env.CLOUDINARY_CLOUD_NAME))
      issues.push('CLOUDINARY_CLOUD_NAME must be a valid cloud name');
    if (env.CLOUDINARY_API_KEY && !/^[0-9]{1,100}$/.test(env.CLOUDINARY_API_KEY))
      issues.push('CLOUDINARY_API_KEY must be a numeric API key');
    if (
      env.CLOUDINARY_API_SECRET &&
      (env.CLOUDINARY_API_SECRET.length < 16 || env.CLOUDINARY_API_SECRET.length > 200)
    )
      issues.push('CLOUDINARY_API_SECRET must contain 16 to 200 characters');
    if (
      env.CLOUDINARY_FOLDER &&
      (env.CLOUDINARY_FOLDER.length > 120 ||
        !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(env.CLOUDINARY_FOLDER))
    )
      issues.push('CLOUDINARY_FOLDER must be a valid storage namespace');
  } else if (env.FILE_STORAGE_PROVIDER)
    issues.push('FILE_STORAGE_PROVIDER must be cloudinary or s3');
  if (env.FILE_STORAGE_PROVIDER === 's3' && env.S3_ENDPOINT) {
    try {
      const url = new URL(env.S3_ENDPOINT);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch {
      issues.push('S3_ENDPOINT must be an HTTPS endpoint without credentials, query or fragment');
    }
  }
  if (Boolean(env.EVE_RUNTIME_URL) !== Boolean(env.EVE_SERVICE_TOKEN))
    issues.push('Configure EVE_RUNTIME_URL and EVE_SERVICE_TOKEN together');
  if (env.EVE_SERVICE_TOKEN && env.EVE_SERVICE_TOKEN.length < 32)
    issues.push('EVE_SERVICE_TOKEN must have at least 32 characters');
  if (env.EVE_RUNTIME_URL) {
    try {
      const url = new URL(env.EVE_RUNTIME_URL);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch {
      issues.push(
        'EVE_RUNTIME_URL must be an HTTPS endpoint without credentials, query or fragment',
      );
    }
    for (const key of ['AGENT_MODEL', 'AGENT_APPROVED_MODELS', 'AGENT_MODEL_PRICING_JSON'])
      if (!env[key]?.trim()) issues.push(`${key} is required when hosted agents are configured`);
    if (
      env.AGENT_MODEL &&
      !(env.AGENT_APPROVED_MODELS ?? '')
        .split(',')
        .map((value) => value.trim())
        .includes(env.AGENT_MODEL)
    )
      issues.push('AGENT_APPROVED_MODELS must include AGENT_MODEL');
    if (env.AGENT_MODEL_PRICING_JSON) {
      try {
        const pricing = JSON.parse(env.AGENT_MODEL_PRICING_JSON) as Record<
          string,
          { inputMicrosPerMillion?: number; outputMicrosPerMillion?: number }
        >;
        const rate = env.AGENT_MODEL ? pricing[env.AGENT_MODEL] : undefined;
        if (
          !rate ||
          ![rate.inputMicrosPerMillion, rate.outputMicrosPerMillion].every(
            (value) => Number.isSafeInteger(value) && value! >= 0 && value! <= 1000000000,
          )
        )
          throw new Error();
      } catch {
        issues.push(
          'AGENT_MODEL_PRICING_JSON must contain valid integer input/output rates for AGENT_MODEL',
        );
      }
    }
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    issues.push('PORT must be an integer from 1 to 65535');
  if (env.TOOL_SANDBOX_PROVIDER === 'docker')
    issues.push('TOOL_SANDBOX_PROVIDER=docker is only supported locally');
  if (
    (env.RETRIEVAL_ANSWER_MODEL?.startsWith('groq/') || env.TRANSCRIPTION_ENABLED === 'true') &&
    !env.GROQ_API_KEY?.trim()
  )
    issues.push('GROQ_API_KEY is required for configured Groq API features');
  if (env.RETRIEVAL_EMBEDDING_MODEL?.startsWith('groq/'))
    issues.push('RETRIEVAL_EMBEDDING_MODEL must use a dedicated embedding provider');
  if (env.RETRIEVAL_OCR_MODEL?.startsWith('groq/'))
    issues.push('RETRIEVAL_OCR_MODEL must use a separate image/PDF provider');
  if (issues.length) throw new DeploymentConfigurationError(issues);

  env.DATABASE_URL = connection!;
  env.DATABASE_CONNECTION_MODE = shared ? 'shared' : 'restricted';
  delete env.API_DATABASE_URL;
  delete env.WORKER_DATABASE_URL;
  env.DATABASE_POOL_MAX = String(poolSize);
  env.PROCESS_ROLE = role;
  env.BACKGROUND_MODE = 'on-demand';
  env.FILE_STAGING_DIRECTORY = '/tmp/orbit-uploads';
  env.API_HOST = '0.0.0.0';
  env.API_PORT = env.PORT || '3000';
  return env;
}
