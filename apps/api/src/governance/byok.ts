import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { identityScope, type Database } from '@ao/database';
import { organizationActor, organizationAudit } from '../identity/organizations.js';
import { AppError } from '../lib/errors.js';
import { sealModelKey, keyContext, wrappingKeyId } from './byok-crypto.js';
export const modelKeyInput = z
  .object({
    version: z.number().int().nonnegative(),
    label: z.string().trim().min(2).max(100),
    provider: z.literal('openai'),
    secret: z.string().trim().min(16).max(512),
    models: z
      .array(z.string().regex(/^openai\/[a-zA-Z0-9._-]{1,100}$/))
      .min(1)
      .max(100),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export class ByokService {
  constructor(
    private db: Database,
    private publicKey?: string,
  ) {}
  async list(org: string, account: string) {
    return identityScope(async () => {
      await organizationActor(this.db, org, account, true);
      return {
        configured: Boolean(this.publicKey),
        keys: await this.db.query(
          'SELECT id,provider,label,generation,models,expires_at,revoked_at,created_at,updated_at FROM organization_model_keys WHERE organization_id=$1',
          [org],
        ),
      };
    });
  }
  async save(org: string, account: string, input: z.infer<typeof modelKeyInput>) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, account, true, true);
        if (actor.role !== 'owner')
          throw new AppError(403, 'OWNER_REQUIRED', 'An owner must manage model credentials.');
        if (!this.publicKey)
          throw new AppError(
            503,
            'BYOK_UNAVAILABLE',
            'The isolated model broker has not been configured.',
          );
        if (
          (await tx.query('SELECT id FROM organization_erasures WHERE organization_id=$1', [org]))
            .length
        )
          throw new AppError(
            409,
            'ORGANIZATION_ERASING',
            'Model credentials cannot be added during organization deletion.',
          );
        const expires = Date.parse(input.expiresAt);
        if (expires <= Date.now() || expires > Date.now() + 366 * 86400000)
          throw new AppError(400, 'INVALID_EXPIRY', 'Choose an expiry within one year.');
        const [prior] = await tx.query(
          'SELECT id,generation FROM organization_model_keys WHERE organization_id=$1 AND provider=$2 FOR UPDATE',
          [org, input.provider],
        );
        if (Number(prior?.generation ?? 0) !== input.version)
          throw new AppError(409, 'VERSION_CONFLICT', 'Refresh the model key before rotating it.');
        await tx.query('SELECT id FROM lock_governance_workspaces($1)', [org]);
        const id = String(prior?.id ?? randomUUID()),
          generation = Number(prior?.generation ?? 0) + 1;
        const encrypted = sealModelKey(
          this.publicKey,
          keyContext(org, id, generation),
          input.secret,
        );
        await tx.query(
          'INSERT INTO organization_model_keys(id,organization_id,provider,label,generation,models,sealed_key,wrapping_key_id,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organization_id,provider) DO UPDATE SET label=EXCLUDED.label,generation=EXCLUDED.generation,models=EXCLUDED.models,sealed_key=EXCLUDED.sealed_key,wrapping_key_id=EXCLUDED.wrapping_key_id,expires_at=EXCLUDED.expires_at,revoked_at=NULL,updated_at=now()',
          [
            id,
            org,
            input.provider,
            input.label,
            generation,
            [...new Set(input.models)],
            encrypted,
            wrappingKeyId(this.publicKey),
            input.expiresAt,
            account,
          ],
        );
        await tx.query('UPDATE organizations SET version=version+1 WHERE id=$1', [org]);
        await organizationAudit(tx, org, account, 'byok.rotated', id);
        return { id, generation };
      }),
    );
  }
  async revoke(org: string, account: string, id: string) {
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const actor = await organizationActor(tx, org, account, true, true);
        if (actor.role !== 'owner')
          throw new AppError(403, 'OWNER_REQUIRED', 'An owner must revoke model credentials.');
        await tx.query('SELECT id FROM lock_governance_workspaces($1)', [org]);
        const [row] = await tx.query(
          "UPDATE organization_model_keys SET revoked_at=now(),sealed_key='',generation=generation+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id",
          [org, id],
        );
        if (!row) throw new AppError(404, 'NOT_FOUND', 'The model credential is unavailable.');
        await tx.query('UPDATE organizations SET version=version+1 WHERE id=$1', [org]);
        await organizationAudit(tx, org, account, 'byok.revoked', id);
        return { ok: true };
      }),
    );
  }
}
