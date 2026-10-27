import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { migrate } from '@ao/database';
import { testDatabase } from '../apps/api/test/database.js';
import { buildApp } from '../apps/api/src/app.js';
import { RetrievalWorker } from '../apps/api/src/retrieval/worker.js';
import { testEmail, verifyFixtureAccount } from '../apps/api/test/email.js';
import type { RetrievalResult } from '@ao/contracts/retrieval';
import { configuredEmbeddings } from '../apps/api/src/retrieval/embeddings.js';
const model = process.env.RETRIEVAL_EVALUATION_EMBEDDING_MODEL;
if (model && process.env.RETRIEVAL_EVALUATION_ALLOW_INFERENCE !== 'true')
  throw new Error(
    'Synthetic model qualification requires RETRIEVAL_EVALUATION_ALLOW_INFERENCE=true; provider inference may be billed.',
  );
const embeddings = configuredEmbeddings(model);
const concurrency = Number(process.env.RETRIEVAL_EVALUATION_CONCURRENCY ?? 1);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
  throw new Error('Use evaluation concurrency 1–8.');
const db = await testDatabase();
await migrate(db);
const app = await buildApp(db, { email: testEmail(), ...(embeddings ? { embeddings } : {}) });
try {
  const signup = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      name: 'Evaluator',
      email: 'retrieval@evaluation.test',
      password: 'synthetic-evaluation-password',
      workspace: 'Synthetic evaluation',
    },
  });
  if (signup.statusCode !== 201) throw new Error('Evaluation setup failed.');
  await verifyFixtureAccount(db, 'retrieval@evaluation.test');
  const cookie = 'ao_session=' + signup.cookies[0]!.value;
  const boot = (await app.inject({ url: '/v1/bootstrap', headers: { cookie } })).json();
  const workspace = boot.workspace.id,
    member = boot.me.id,
    channel = boot.channels[0].id;
  const corpus = Number(process.env.RETRIEVAL_EVALUATION_DOCUMENTS ?? 1000);
  if (!Number.isInteger(corpus) || corpus < 100 || corpus > 10000)
    throw new Error('Use 100–10000 synthetic documents.');
  await db.query('UPDATE conversations SET next_sequence=$2 WHERE id=$1', [channel, corpus + 100]);
  await db.query(
    "INSERT INTO messages(id,workspace_id,conversation_id,author_id,body,client_id,sequence) SELECT gen_random_uuid(),$1,$2,$3,'Synthetic unrelated incident '||n,gen_random_uuid(),n FROM generate_series(1,$4::integer) n",
    [workspace, channel, member, corpus],
  );
  const cases = embeddings
    ? [
        [
          'restore deleted login access',
          'An account recovery guide helps users regain access after losing credentials.',
        ],
        [
          'how to undo an unsuccessful deployment',
          'Deployment rollback restores the previously healthy release.',
        ],
        [
          'meeting follow-up responsibilities',
          'Meeting minutes record action items, their owners and deadlines.',
        ],
        ['日本の首都に関する資料', 'Tokyo is the capital city of Japan.'],
        ['भारत की राजधानी क्या है', 'New Delhi is the capital of India.'],
        [
          'Comment récupérer un compte bloqué',
          'Locked account recovery uses identity verification to restore access.',
        ],
        [
          'encryption key replacement policy',
          'Rotate credentials regularly and revoke the old secrets after deployment.',
        ],
        [
          'database service outage fallback',
          'Database failover switches applications to a healthy standby replica.',
        ],
      ]
    : [
        ['failover', 'Database failover instructions'],
        ['recovery', 'Account recovery instructions'],
        ['rollback', 'Deployment rollback checklist'],
        ['minutes', 'Meeting minutes action items'],
        ['東京', '東京 検索 資料'],
        ['नमस्ते', 'नमस्ते खोज प्रमाण'],
        ['café', 'Café launch notes'],
        ['code', 'ＣＯＤＥ migration notes'],
      ];
  const expected = new Map<string, string>();
  for (const [i, [query, body]] of cases.entries()) {
    const id = randomUUID();
    await db.query(
      'INSERT INTO messages(id,workspace_id,conversation_id,author_id,body,client_id,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, workspace, channel, member, body, randomUUID(), corpus + i + 1],
    );
    expected.set(query!, id);
  }
  const worker = new RetrievalWorker(db),
    indexStart = performance.now();
  for (let round = 0; round < Math.ceil((corpus + cases.length) / 20) + 2; round++)
    await worker.tick();
  const indexMs = performance.now() - indexStart,
    latencies: number[] = [];
  let hits = 0,
    reciprocalRank = 0;
  const tasks = Array.from({ length: 3 }, () => cases).flat(),
    started = performance.now();
  let cursor = 0,
    saturated = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor++;
        const item = tasks[index];
        if (!item) break;
        const [query] = item;
        const start = performance.now();
        const response = await app.inject({
          method: 'POST',
          url: '/v1/search/retrieve',
          headers: { cookie },
          payload: { q: query, limit: 5, semantic: Boolean(embeddings) },
        });
        latencies.push(performance.now() - start);
        if (response.statusCode !== 200)
          throw new Error('Evaluation search failed: ' + response.statusCode);
        const result = response.json<RetrievalResult>(),
          rank = result.items.findIndex((item) => item.id === expected.get(query!));
        if (rank >= 0) {
          hits++;
          reciprocalRank += 1 / (rank + 1);
        }
        if (result.truncated) saturated++;
      }
    }),
  );
  const retrievalMs = performance.now() - started;
  latencies.sort((a, b) => a - b);
  const queries = cases.length * 3;
  const report = {
    environment:
      (process.env.TEST_DATABASE_URL ? 'synthetic PostgreSQL' : 'synthetic PGlite') +
      (embeddings
        ? '; explicitly enabled embedding model; synthetic source text only'
        : '; no external models or providers'),
    documents: corpus + cases.length,
    indexMs: Math.round(indexMs),
    indexDocumentsPerSecond: Math.round((corpus + cases.length) / (indexMs / 1000)),
    queries,
    concurrency,
    queriesPerSecond: Math.round((queries / (retrievalMs / 1000)) * 100) / 100,
    saturatedQueries: saturated,
    recallAt5: hits / queries,
    meanReciprocalRank: reciprocalRank / queries,
    p50Ms: Math.round(latencies[Math.floor(latencies.length * 0.5)]!),
    p95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)]!),
    candidateLimit: 300,
    semanticQuality: model
      ? {
          model,
          scope:
            'small synthetic cross-language relevance smoke test; not production semantic qualification',
        }
      : 'not evaluated',
    separateSearchService:
      'not selected; qualify production corpus, concurrency and recall before changing storage',
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.recallAt5 < (embeddings ? 0.9 : 1)) process.exitCode = 1;
} finally {
  await app.close();
  await db.close();
}
