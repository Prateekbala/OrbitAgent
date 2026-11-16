import { createServer } from 'node:http';
import { createServer as createPortServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EveRuntime } from '../../apps/api/src/execution/runtime.js';

export async function managedRuntimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-release-runtime-'));
  const requests: Array<Record<string, unknown>> = [];
  const token = 'synthetic-release-runtime-service-token-32-characters';
  const key = 'synthetic-release-groq-api-key';
  const provider = createServer(async (request, response) => {
    try {
      if (
        request.method !== 'POST' ||
        request.url !== '/openai/v1/chat/completions' ||
        request.headers.authorization !== 'Bearer ' + key
      )
        throw new Error('Unexpected provider request.');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 128000) throw new Error('Provider request exceeded the fixture bound.');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (body.model !== 'openai/gpt-oss-120b' || body.tools || body.stream)
        throw new Error('Unexpected provider execution mode.');
      requests.push(body);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'release-provider-fixture',
          created: 1,
          model: 'openai/gpt-oss-120b',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  reply: 'The release review task is proposed and requires approval.',
                  proposals: [
                    {
                      tool: 'create_task',
                      parameters: {
                        title: 'Review isolated release',
                        description: 'Verify the source evidence before acceptance.',
                        priority: 'high',
                      },
                    },
                  ],
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 240,
            total_tokens: 1440,
            completion_tokens_details: { reasoning_tokens: 40 },
          },
        }),
      );
    } catch {
      response
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'Invalid synthetic provider request.' } }));
    }
  });
  const closeProvider = async () => {
    provider.closeAllConnections();
    if (provider.listening)
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
  };
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let logs = '';
  const close = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 10000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    await closeProvider();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Provider fixture did not bind.');
    const probe = createPortServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const endpoint = probe.address();
    if (!endpoint || typeof endpoint === 'string')
      throw new Error('Runtime test port unavailable.');
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      PATH: process.env.PATH,
      CI: '1',
      GROQ_API_KEY: key,
      EVE_SERVICE_TOKEN: token,
      PORT: String(endpoint.port),
      NITRO_PORT: String(endpoint.port),
      NITRO_HOST: '127.0.0.1',
      ORBIT_TEST_PROVIDER_ORIGIN: `http://127.0.0.1:${address.port}`,
    };
    const root = fileURLToPath(new URL('../../', import.meta.url));
    await promisify(execFile)(
      process.execPath,
      [join(root, 'node_modules/eve/bin/eve.js'), 'build'],
      {
        cwd: join(root, 'apps/managed-agents'),
        env,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120000,
      },
    );
    const preload = join(directory, 'provider-boundary.mjs');
    await writeFile(
      preload,
      `
const original = globalThis.fetch;
const target = new URL(process.env.ORBIT_TEST_PROVIDER_ORIGIN);
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('Invalid test provider origin');
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.origin === 'https://api.groq.com') return original(new URL(url.pathname + url.search, target), options);
  if (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)) return original(input, options);
  throw new Error('External fetch is disabled in the release-flow fixture');
};
`,
      { mode: 0o600 },
    );
    child = spawn(
      process.execPath,
      ['--import', preload, join(root, 'apps/managed-agents/.output/server/index.mjs')],
      { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    exited = once(child, 'exit');
    const capture = (chunk: Buffer) => {
      logs = (logs + chunk.toString('utf8')).slice(-16000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const origin = `http://127.0.0.1:${endpoint.port}`;
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Managed runtime stopped: ' + logs);
      try {
        const response = await fetch(origin + '/eve/v1/health', {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Managed runtime did not become ready: ' + logs);
    return {
      requests,
      runtime: new EveRuntime(origin, token, {
        defaultModel: 'groq/openai/gpt-oss-120b',
        models: ['groq/openai/gpt-oss-120b'],
        pricing: {
          'groq/openai/gpt-oss-120b': {
            inputMicrosPerMillion: 150000,
            outputMicrosPerMillion: 600000,
          },
        },
      }),
      diagnostics: () => logs,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
