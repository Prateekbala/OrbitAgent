import type { FastifyInstance } from 'fastify';
import type { Database } from '@ao/database';
import { timingSafeEqual, createHash } from 'node:crypto';
import { AppError } from '../lib/errors.js';
export function operationTelemetry(app: FastifyInstance, db: Database, token?: string) {
  const buckets = new Map<
    string,
    { route: string; status: number; requests: number; duration: number }
  >();
  let pending: Promise<void> | undefined,
    dropped = 0;
  function flush() {
    if (pending) return pending;
    if (!buckets.size) return Promise.resolve();
    const rows = [...buckets.values()];
    buckets.clear();
    pending = db
      .query('SELECT record_operation_metrics($1::jsonb)', [JSON.stringify(rows)])
      .then(
        () => {},
        () => {
          dropped += rows.reduce((sum, r) => sum + r.requests, 0);
          app.log.error({ code: 'METRIC_FLUSH_FAILED' }, 'Operation metric flush failed');
        },
      )
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const code = reply.statusCode,
      key = route + '\0' + code;
    if (buckets.size >= 1000 && !buckets.has(key)) {
      dropped++;
      return;
    }
    const row = buckets.get(key) ?? { route, status: code, requests: 0, duration: 0 };
    row.requests++;
    row.duration += Math.max(0, Math.ceil(reply.elapsedTime));
    buckets.set(key, row);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-orbit-trace-id', req.id);
    return payload;
  });
  const timer = setInterval(() => void flush(), 1000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await pending;
    await flush();
  });
  app.get('/internal/metrics', async (req, reply) => {
    const candidate = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (
      !token ||
      !timingSafeEqual(
        createHash('sha256').update(candidate).digest(),
        createHash('sha256').update(token).digest(),
      )
    )
      throw new AppError(401, 'OPERATOR_REQUIRED', 'An operator metrics credential is required.');
    await flush();
    const rows = await db.query('SELECT * FROM operation_metrics_snapshot()');
    const escape = (v: unknown) => JSON.stringify(String(v));
    return reply
      .type('text/plain; version=0.0.4')
      .send(
        '# TYPE orbit_http_requests_total counter\n' +
          rows
            .map(
              (r) =>
                `orbit_http_requests_total{route=${escape(r.route)},status=${escape(r.status)}} ${r.requests}\norbit_http_duration_ms_total{route=${escape(r.route)},status=${escape(r.status)}} ${r.duration_ms}`,
            )
            .join('\n') +
          `\norbit_metric_drops_total ${dropped}\n`,
      );
  });
}
