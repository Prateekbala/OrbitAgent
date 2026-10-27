import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { Identity } from './policy.js';
import { AppError } from './errors.js';

export class PageCursors {
  private readonly key: Buffer;
  constructor(secret: string, purpose: 'search' | 'tasks' = 'search') {
    const key = Buffer.from(secret, 'base64');
    if (key.length !== 32 || key.toString('base64') !== secret)
      throw new Error('Invalid cursor key.');
    this.key = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `orbit-${purpose}-v1`, 32));
  }
  private audience(p: Identity, filters: string) {
    return Buffer.from(
      `${p.workspaceId}:${p.membershipId}:${p.platformCredentialId ?? p.credentialId ?? 'session'}:${createHash('sha256').update(filters).digest('hex')}`,
    );
  }
  encode(position: unknown, p: Identity, filters: string) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(this.audience(p, filters));
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ position, expires: Date.now() + 86400000 })),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
  }
  decode(value: string, p: Identity, filters: string): unknown {
    try {
      const data = Buffer.from(value, 'base64url');
      if (data.length < 29 || data.toString('base64url') !== value) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      cipher.setAAD(this.audience(p, filters));
      cipher.setAuthTag(data.subarray(12, 28));
      const result = JSON.parse(
        Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(),
      ) as { position: unknown; expires: number };
      if (!Number.isFinite(result.expires) || result.expires < Date.now()) throw new Error();
      return result.position;
    } catch {
      throw new AppError(
        400,
        'INVALID_CURSOR',
        'This page position expired or belongs to different filters. Reload from the beginning.',
      );
    }
  }
}
