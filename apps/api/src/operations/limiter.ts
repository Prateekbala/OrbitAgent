import { createHmac } from 'node:crypto';
import type { Database } from '@ao/database';
interface Options {
  timeWindow?: number;
  routeInfo?: { url?: string; method?: string | string[] };
}
export function postgresRateStore(db: Database, secret: string) {
  if (secret.length < 32)
    throw new Error('Shared rate limiting requires a stable key of at least 32 characters.');
  return class PostgresRateStore {
    private readonly options: Options;
    constructor(options: unknown = {}) {
      this.options = options as Options;
    }
    incr(
      key: string,
      callback: (error: Error | null, value?: { current: number; ttl: number }) => void,
      timeWindow?: number,
    ) {
      const route = this.options.routeInfo,
        scope = route ? JSON.stringify([route.method, route.url]) : 'global';
      const hash = createHmac('sha256', secret)
        .update(scope + '\0' + key)
        .digest('hex');
      void db
        .query('SELECT * FROM consume_rate_limit($1,$2)', [
          hash,
          timeWindow ?? this.options.timeWindow ?? 60000,
        ])
        .then(
          ([row]) => callback(null, { current: Number(row!.current), ttl: Number(row!.ttl) }),
          () => callback(new Error('Shared rate limiter is unavailable.')),
        );
    }
    child(options: unknown) {
      return new PostgresRateStore(options);
    }
  };
}
