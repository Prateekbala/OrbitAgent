import { it, expect } from 'vitest';
import { database } from '@ao/database';
it.skipIf(!process.env.TEST_DATABASE_URL)(
  'handles an idle PostgreSQL disconnect without leaking the client and reconnects',
  async () => {
    const codes: string[] = [];
    const connection = await database({
      url: process.env.TEST_DATABASE_URL!,
      onPoolError: (code) => codes.push(code),
    });
    const administrator = await database({ url: process.env.TEST_DATABASE_URL! });
    try {
      const [backend] = await connection.query('SELECT pg_backend_pid() id');
      await administrator.query('SELECT pg_terminate_backend($1)', [backend!.id]);
      await expect.poll(() => codes).toEqual(['57P01']);
      expect((await connection.query('SELECT 42 value'))[0]!.value).toBe(42);
      expect(codes.every((code) => /^[A-Z0-9]{5}$/.test(code))).toBe(true);
    } finally {
      await connection.close();
      await administrator.close();
    }
  },
);
