import { performance } from 'node:perf_hooks';
import { messagingFixture } from '../../apps/api/test/messaging-fixture.js';
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 10),
  requests = Number(process.env.LOAD_REQUESTS ?? 100);
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 100 ||
  !Number.isInteger(requests) ||
  requests < 1 ||
  requests > 10000
)
  throw new Error('Use 1–100 clients and 1–10000 requests.');
const f = await messagingFixture();
try {
  const latencies: number[] = [];
  let next = 0,
    failed = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < requests) {
        const start = performance.now(),
          r = await f.call(f.owner, 'GET', '/v1/bootstrap');
        latencies.push(performance.now() - start);
        if (r.statusCode !== 200) failed++;
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      environment: 'isolated-embedded-fixture',
      concurrency,
      requests,
      failed,
      p50Ms: latencies[Math.floor(latencies.length * 0.5)],
      p95Ms: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))],
      productionCapacityQualified: false,
    }),
  );
  if (failed) process.exitCode = 1;
} finally {
  await f.close();
}
