import { identityScope, type Database } from '@ao/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentSession } from '../identity/security.js';
import { AppError } from '../lib/errors.js';
const input = z
  .object({
    version: z.number().int().positive(),
    steps: z
      .array(z.enum(['profile', 'conversation', 'task', 'knowledge', 'notifications']))
      .max(5)
      .refine((v) => new Set(v).size === v.length),
    dismissed: z.boolean(),
  })
  .strict();
export function clientPreferenceRoutes(app: FastifyInstance, db: Database) {
  app.get('/v1/account/onboarding', async (req) => {
    const session = await currentSession(db, req);
    return identityScope(async () => {
      const [row] = await db.query(
        'SELECT onboarding_version version,onboarding_steps steps,onboarding_dismissed dismissed,locale FROM accounts WHERE id=$1',
        [session.account_id],
      );
      return row;
    });
  });
  app.put('/v1/account/onboarding', async (req) => {
    const session = await currentSession(db, req),
      data = input.parse(req.body);
    return identityScope(async () => {
      const [row] = await db.query(
        'UPDATE accounts SET onboarding_steps=$3,onboarding_dismissed=$4,onboarding_version=onboarding_version+1 WHERE id=$1 AND onboarding_version=$2 RETURNING onboarding_version version,onboarding_steps steps,onboarding_dismissed dismissed,locale',
        [session.account_id, data.version, data.steps, data.dismissed],
      );
      if (!row)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Refresh the getting-started guide before saving.',
        );
      return row;
    });
  });
}
