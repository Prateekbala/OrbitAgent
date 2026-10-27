import {
  createHash,
  createPublicKey,
  createPrivateKey,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  constants,
  sign,
  verify,
} from 'node:crypto';
import { z } from 'zod';
const box = z
  .object({
    v: z.literal(1),
    kid: z.string().regex(/^[a-f0-9]{24}$/),
    wrapped: z.string(),
    iv: z.string(),
    tag: z.string(),
    data: z.string(),
  })
  .strict();
export const keyContext = (org: string, id: string, generation: number) =>
  `orbit:byok:${org}:${id}:${generation}`;
export function wrappingKeyId(pem: string) {
  return createHash('sha256')
    .update(createPublicKey(pem).export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 24);
}
export function sealModelKey(pem: string, context: string, value: string) {
  const publicKey = createPublicKey(pem);
  if (
    publicKey.asymmetricKeyType !== 'rsa' ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  )
    throw new Error('Use a dedicated RSA wrapping key of at least 3072 bits.');
  const key = randomBytes(32),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  try {
    return JSON.stringify({
      v: 1,
      kid: wrappingKeyId(pem),
      wrapped: publicEncrypt(
        { key: publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
        key,
      ).toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
  } finally {
    key.fill(0);
  }
}
export function openModelKey(privatePem: string, context: string, value: string) {
  const b = box.parse(JSON.parse(value)),
    privateKey = createPrivateKey(privatePem);
  if (b.kid !== wrappingKeyId(privatePem)) throw new Error('Wrapping key is unavailable.');
  const key = privateDecrypt(
    { key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(b.wrapped, 'base64'),
  );
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(b.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(b.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } finally {
    key.fill(0);
  }
}
const claims = z
  .object({
    aud: z.literal('orbit-model-broker'),
    workspaceId: z.uuid(),
    runId: z.uuid(),
    keyId: z.uuid(),
    generation: z.number().int().positive(),
    exp: z.number().int().positive(),
  })
  .strict();
export type ModelCapability = z.infer<typeof claims>;
export function modelCapability(privatePem: string, input: Omit<ModelCapability, 'aud' | 'exp'>) {
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error('Use a dedicated Ed25519 capability key.');
  const payload = Buffer.from(
    JSON.stringify({
      ...input,
      aud: 'orbit-model-broker',
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  ).toString('base64url');
  return payload + '.' + sign(null, Buffer.from(payload), key).toString('base64url');
}
export function verifyModelCapability(publicPem: string, token: string): ModelCapability {
  const [payload, signature, extra] = token.split('.');
  const key = createPublicKey(publicPem);
  if (
    token.length > 2048 ||
    !payload ||
    !signature ||
    extra ||
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'))
  )
    throw new Error('Invalid model capability.');
  const c = claims.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  const now = Math.floor(Date.now() / 1000);
  if (c.exp <= now || c.exp > now + 65) throw new Error('Model capability expired.');
  return c;
}
