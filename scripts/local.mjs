import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod, open, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import webPush from 'web-push';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
const exec = promisify(execFile),
  root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, '.data/local'),
  stateFile = resolve(directory, 'processes.json');
await mkdir(directory, { recursive: true, mode: 0o700 });
async function optional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}
const profilePath = resolve(directory, 'environment');
const prior = parseEnv(await optional(profilePath));
const rootEnv = parseEnv(await optional(resolve(root, '.env')));
const vapid =
  prior.WEB_PUSH_PUBLIC_KEY && prior.WEB_PUSH_PRIVATE_KEY
    ? { publicKey: prior.WEB_PUSH_PUBLIC_KEY, privateKey: prior.WEB_PUSH_PRIVATE_KEY }
    : webPush.generateVAPIDKeys();
const profile = {
  NODE_ENV: 'development',
  API_HOST: '127.0.0.1',
  API_PORT: '4000',
  WEB_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: '',
  EMAIL_PROVIDER: 'mailpit',
  FILE_STORAGE_PROVIDER: 'local',
  CLAMAV_HOST: '127.0.0.1',
  CLAMAV_PORT: '3310',
  EVE_RUNTIME_URL: 'http://127.0.0.1:4100',
  EVE_SERVICE_TOKEN: prior.EVE_SERVICE_TOKEN || randomBytes(32).toString('base64url'),
  OLLAMA_BASE_URL: 'http://127.0.0.1:11435/v1',
  AGENT_MODEL: 'ollama/orbit-chat',
  AGENT_APPROVED_MODELS: 'ollama/orbit-chat',
  AGENT_MODEL_PRICING_JSON: JSON.stringify({
    'ollama/orbit-chat': { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  }),
  EVE_DURABILITY_QUALIFIED: 'false',
  AI_GATEWAY_API_KEY: '',
  VERCEL_OIDC_TOKEN: '',
  TOOL_SANDBOX_ENABLED: 'true',
  TOOL_SANDBOX_PROVIDER: 'docker',
  RETRIEVAL_EMBEDDING_MODEL: 'ollama/orbit-embeddings',
  RETRIEVAL_ANSWER_MODEL: 'ollama/orbit-chat',
  RETRIEVAL_OCR_MODEL: '',
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'orbit-local',
  LIVEKIT_API_SECRET: 'local-development-only-do-not-use-in-production-32',
  CALL_RECORDING_DIRECTORY: resolve(root, '.data/call-recordings'),
  WEB_PUSH_PUBLIC_KEY: vapid.publicKey,
  WEB_PUSH_PRIVATE_KEY: vapid.privateKey,
  WEB_PUSH_SUBJECT: 'mailto:development@orbit.test',
  ...(rootEnv.EMAIL_ENCRYPTION_KEY
    ? {}
    : { EMAIL_ENCRYPTION_KEY: prior.EMAIL_ENCRYPTION_KEY || randomBytes(32).toString('base64') }),
};
const env = { ...process.env, ...rootEnv, ...prior, ...profile };
const definitions = {
  runtime: {
    entry: resolve(root, 'node_modules/eve/bin/eve.js'),
    args: ['start', '--host', '127.0.0.1', '--port', '4100'],
    cwd: resolve(root, 'apps/managed-agents'),
    port: 4100,
    url: 'http://127.0.0.1:4100/eve/v1/health',
  },
  api: {
    entry: resolve(root, 'apps/api/src/server.ts'),
    args: [],
    cwd: root,
    port: 4000,
    url: 'http://127.0.0.1:4000/health',
    loader: true,
  },
  web: {
    entry: resolve(root, 'node_modules/next/dist/bin/next'),
    args: ['dev', '--hostname', '127.0.0.1', '--port', '3000'],
    cwd: resolve(root, 'apps/web'),
    port: 3000,
    url: 'http://localhost:3000',
  },
};
let state = JSON.parse((await optional(stateFile)) || '{}');
async function save() {
  const temp = stateFile + '.tmp';
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, stateFile);
}
async function owned(name) {
  const record = state[name];
  if (!Number.isSafeInteger(record?.pid) || record.pid < 2) return false;
  try {
    const { stdout } = await exec('ps', ['-p', String(record.pid), '-o', 'command=']);
    return stdout.includes(definitions[name].entry);
  } catch {
    return false;
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(url, seconds = 120) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const result = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      if (result.ok) return;
    } catch {}
    await delay(750);
  }
  throw new Error('Service did not become ready: ' + url + '. Inspect .data/local logs.');
}
async function run(binary, args, cwd = root, log) {
  if (!log) {
    const child = spawn(binary, args, { cwd, env, stdio: 'inherit' });
    await new Promise((yes, no) => {
      child.on('error', no);
      child.on('exit', (code) =>
        code === 0 ? yes() : no(new Error(binary + ' exited with ' + code)),
      );
    });
    return;
  }
  const handle = await open(resolve(directory, log), 'a', 0o600);
  try {
    const child = spawn(binary, args, { cwd, env, stdio: ['ignore', handle.fd, handle.fd] });
    await new Promise((yes, no) => {
      child.on('error', no);
      child.on('exit', (code) =>
        code === 0 ? yes() : no(new Error(binary + ' failed; inspect .data/local/' + log)),
      );
    });
  } finally {
    await handle.close();
  }
}
async function available(port) {
  const server = createServer();
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', () => server.close(yes));
  });
}
async function start(name) {
  if (await owned(name)) {
    await wait(definitions[name].url);
    return;
  }
  const d = definitions[name];
  await available(d.port);
  const handle = await open(resolve(directory, name + '.log'), 'a', 0o600);
  try {
    const child = spawn(
      process.execPath,
      [...(d.loader ? ['--import', 'tsx'] : []), d.entry, ...d.args],
      { cwd: d.cwd, env, detached: true, stdio: ['ignore', handle.fd, handle.fd] },
    );
    await new Promise((yes, no) => {
      child.once('spawn', yes);
      child.once('error', no);
    });
    state[name] = { pid: child.pid, startedAt: new Date().toISOString() };
    await save();
    child.unref();
  } finally {
    await handle.close();
  }
  await wait(d.url);
  console.log(name + ' ready: ' + d.url);
}
async function stop(name) {
  if (!(await owned(name))) {
    delete state[name];
    return;
  }
  const pid = state[name].pid;
  process.kill(-pid, 'SIGTERM');
  for (let i = 0; i < 60; i++) {
    if (!(await owned(name))) {
      delete state[name];
      await save();
      return;
    }
    await delay(500);
  }
  throw new Error(name + ' is still shutting down; data was not forcibly terminated.');
}
const operation = process.argv[2] ?? 'status';
if (['up', 'prepare'].includes(operation)) {
  const { stdout: dockerHost } = await exec('docker', [
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]);
  profile.DOCKER_TOOL_HOST = dockerHost.trim();
  for (const [variable, image] of [
    ['DOCKER_TOOL_NODE_IMAGE', 'node:24-alpine'],
    ['DOCKER_TOOL_PYTHON_IMAGE', 'python:3.13-alpine'],
  ]) {
    try {
      const result = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
      profile[variable] = result.stdout.trim();
    } catch {
      await run('docker', ['pull', image], root, 'sandbox-images.log');
      const result = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
      profile[variable] = result.stdout.trim();
    }
  }
  Object.assign(env, profile);
  await writeFile(
    profilePath,
    Object.entries(profile)
      .map(([k, v]) => {
        if (v.includes("'") || v.includes('\n'))
          throw new Error('Invalid local environment value.');
        return k + "='" + v + "'";
      })
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}
if (operation === 'prepare') {
  console.log('Prepared private local environment and sandbox images.');
} else if (operation === 'up') {
  await mkdir(resolve(root, '.data/call-recordings'), { recursive: true, mode: 0o700 });
  await chmod(resolve(root, '.data/call-recordings'), 0o700);
  for (const file of ['compose.mail.yaml', 'compose.local.yaml', 'compose.calls.yaml'])
    await run('docker', ['compose', '-f', file, 'up', '-d', '--wait', '--wait-timeout', '300']);
  await wait('http://127.0.0.1:11435/api/tags');
  console.log('Preparing local model weights; the first run downloads approximately 2.2 GB.');
  const tags = await (await fetch('http://127.0.0.1:11435/api/tags')).json();
  for (const model of ['qwen2.5:3b', 'nomic-embed-text:v1.5'])
    if (!tags.models.some((m) => m.name === model))
      await run(
        'docker',
        ['compose', '-f', 'compose.local.yaml', 'exec', '-T', 'ollama', 'ollama', 'pull', model],
        root,
        'models.log',
      );
  for (const [name, file] of [
    ['orbit-chat', 'Modelfile'],
    ['orbit-embeddings', 'EmbeddingModelfile'],
  ])
    await run(
      'docker',
      [
        'compose',
        '-f',
        'compose.local.yaml',
        'exec',
        '-T',
        'ollama',
        'ollama',
        'create',
        name,
        '-f',
        '/config/' + file,
      ],
      root,
      'models.log',
    );
  if (!(await owned('runtime'))) {
    console.log('Building local agent runtime.');
    await run(
      process.execPath,
      [definitions.runtime.entry, 'build'],
      definitions.runtime.cwd,
      'runtime-build.log',
    );
  }
  await start('runtime');
  await start('api');
  await start('web');
  console.log(
    'Orbit: http://localhost:3000\nEmail inbox: http://localhost:8025\nStatus/stop: npm run local:status / npm run local:down',
  );
} else if (operation === 'restart') {
  const name = process.argv[3];
  if (!Object.hasOwn(definitions, name ?? ''))
    throw new Error('Choose a local service to restart: api, web, or runtime.');
  await stop(name);
  await start(name);
} else if (operation === 'down') {
  for (const name of ['web', 'api', 'runtime']) await stop(name);
  await save();
  await run('docker', ['compose', '-f', 'compose.local.yaml', 'stop']);
  await run('docker', ['compose', '-f', 'compose.mail.yaml', 'stop']);
  await run('docker', ['compose', '-f', 'compose.calls.yaml', 'stop']);
  console.log('Stopped. Database, files, mail and model volumes are preserved.');
} else if (operation === 'verify') {
  await run(process.execPath, ['--import', 'tsx', 'tests/runtime/smoke.ts']);
  await run(process.execPath, ['--import', 'tsx', 'tests/runtime/local-email.ts']);
  await run(process.execPath, ['--import', 'tsx', 'tests/runtime/local-sandbox.ts']);
  await run(process.execPath, ['--import', 'tsx', 'tests/runtime/local-models.ts']);
} else if (operation === 'status') {
  for (const name of Object.keys(definitions))
    console.log(
      name + ': ' + ((await owned(name)) ? 'running' : 'stopped') + ' · ' + definitions[name].url,
    );
  await run('docker', ['compose', '-f', 'compose.local.yaml', 'ps']);
  await run('docker', ['compose', '-f', 'compose.mail.yaml', 'ps']);
  await run('docker', ['compose', '-f', 'compose.calls.yaml', 'ps']);
} else throw new Error('Use up, down, status, verify, or restart <api|web|runtime>.');
