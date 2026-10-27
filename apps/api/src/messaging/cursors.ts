import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { RealtimeBatch } from '@ao/contracts';
import { eventCursor } from '@ao/contracts';
import { AppError } from '../lib/errors.js';
import type { Identity } from '../lib/policy.js';

export class EventCursors {
  private readonly cipherKey: Buffer;
  private readonly eventKey: Buffer;
  constructor(secret: string) {
    const key = Buffer.from(secret, 'base64');
    if (key.length !== 32 || key.toString('base64') !== secret)
      throw new Error('Realtime cursor key must be a canonical base64-encoded 32-byte key.');
    this.cipherKey = Buffer.from(
      hkdfSync('sha256', key, Buffer.alloc(0), 'orbit-realtime-cursors-v1', 32),
    );
    this.eventKey = Buffer.from(
      hkdfSync('sha256', key, Buffer.alloc(0), 'orbit-realtime-events-v1', 32),
    );
  }
  private audience(p: Identity) {
    return `${p.workspaceId}:${p.membershipId}:${p.platformCredentialId ?? p.credentialId ?? 'session'}`;
  }
  encode(sequence: string, p: Identity) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.cipherKey, nonce),
      plain = Buffer.alloc(8);
    plain.writeBigUInt64BE(BigInt(sequence));
    cipher.setAAD(Buffer.from(this.audience(p)));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return 'v1.' + Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
  }
  decode(value: unknown, p: Identity) {
    const token = eventCursor.parse(value);
    if (token === '0') return '0';
    try {
      const body = Buffer.from(token.slice(3), 'base64url');
      if (body.toString('base64url') !== token.slice(3)) throw new Error('Non-canonical cursor');
      const cipher = createDecipheriv('aes-256-gcm', this.cipherKey, body.subarray(0, 12));
      cipher.setAAD(Buffer.from(this.audience(p)));
      cipher.setAuthTag(body.subarray(20));
      const plain = Buffer.concat([cipher.update(body.subarray(12, 20)), cipher.final()]);
      const sequence = plain.readBigUInt64BE();
      if (sequence > 9223372036854775807n) throw new Error('Invalid position');
      return sequence.toString();
    } catch {
      throw new AppError(
        400,
        'INVALID_CURSOR',
        'This event cursor is invalid for your workspace session. Reconnect from the beginning.',
      );
    }
  }
  batch(page: RealtimeBatch, p: Identity): RealtimeBatch {
    return {
      ...page,
      cursor: this.encode(page.cursor, p),
      events: page.events.map((event) => ({
        ...event,
        id: createHmac('sha256', this.eventKey)
          .update(`${this.audience(p)}:${event.id}`)
          .digest('base64url'),
      })),
    };
  }
}
