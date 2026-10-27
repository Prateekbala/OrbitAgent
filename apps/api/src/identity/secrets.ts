import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../lib/errors.js';
export class IdentitySecrets {
  private readonly active: Buffer | null;
  private readonly keys = new Map<string, Buffer>();
  constructor(value?: string, previous: readonly string[] = []) {
    if (previous.length > 8) throw new Error('Retain at most eight prior identity keys.');
    const decode = (input: string) => {
      const key = Buffer.from(input, 'base64');
      if (key.length !== 32 || key.toString('base64') !== input)
        throw new Error('Identity keys must be canonical base64 32-byte keys.');
      return key;
    };
    this.active = value ? decode(value) : null;
    for (const input of [value, ...previous])
      if (input) {
        const key = decode(input);
        this.keys.set(this.id(key), key);
      }
  }
  static fromEnvironment(env: NodeJS.ProcessEnv) {
    return new IdentitySecrets(
      env.IDENTITY_ENCRYPTION_KEY ?? env.EMAIL_ENCRYPTION_KEY,
      parsePreviousIdentityKeys(env.IDENTITY_PREVIOUS_KEYS_JSON),
    );
  }
  private id(key: Buffer) {
    return createHash('sha256').update(key).digest('hex').slice(0, 24);
  }
  get writePrefix() {
    if (!this.active) throw new Error('An active write key is required.');
    return 'v2.' + this.id(this.active) + '.';
  }
  needsRewrap(value: string) {
    return !this.active || !value.startsWith('v2.' + this.id(this.active) + '.');
  }
  seal(context: string, value: string) {
    if (!this.active)
      throw new AppError(503, 'IDENTITY_KEY_UNAVAILABLE', 'Identity encryption is unavailable.');
    const id = this.id(this.active),
      iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.active, iv);
    cipher.setAAD(Buffer.from('v2:' + id + ':' + context));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v2',
      id,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      data.toString('base64url'),
    ].join('.');
  }
  open(context: string, value: string) {
    if (!this.active)
      throw new AppError(503, 'IDENTITY_KEY_UNAVAILABLE', 'Identity encryption is unavailable.');
    const parts = value.split('.');
    const version = parts[0],
      id = version === 'v2' ? parts[1] : undefined,
      [iv, tag, data] = parts.slice(version === 'v2' ? 2 : 1);
    if (
      !['v1', 'v2'].includes(version ?? '') ||
      !iv ||
      !tag ||
      data === undefined ||
      Buffer.from(iv, 'base64url').length !== 12 ||
      Buffer.from(tag, 'base64url').length !== 16
    )
      throw new Error('Invalid encrypted identity secret.');
    const candidates =
      version === 'v2'
        ? [this.keys.get(id!)].filter((v): v is Buffer => Boolean(v))
        : [...this.keys.values()];
    for (const key of candidates)
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(version === 'v2' ? 'v2:' + id + ':' + context : context));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(data, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {}
    throw new Error('The encrypted secret cannot be opened with the configured keyring.');
  }
}

export function parsePreviousIdentityKeys(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const input: unknown = JSON.parse(value);
    if (!Array.isArray(input) || input.length > 8 || input.some((v) => typeof v !== 'string'))
      throw new Error();
    return input;
  } catch {
    throw new Error('IDENTITY_PREVIOUS_KEYS_JSON must contain at most eight decrypt-only keys.');
  }
}
