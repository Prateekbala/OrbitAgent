import { createPublicKey, verify, createHash } from 'node:crypto';
export function trustedOrigin(value: string, development = false) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        development &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error('Configure a trusted HTTPS app origin.');
  return url.origin;
}
export function sameOrigin(value: string, origin: string) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function externalLink(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
interface UpdateManifest {
  version: string;
  platform: string;
  architecture: string;
  expiresAt: string;
  artifact: string;
  sha512: string;
}
function parts(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Release versions must be stable semantic versions.');
  return version.split('.').map(Number);
}
function newer(version: string, current: string) {
  const a = parts(version),
    b = parts(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}
export function verifyManifest(
  payload: Buffer,
  signature: string,
  key: string,
  current: string,
  origin: string,
  platform = process.platform,
  architecture = process.arch,
) {
  if (
    payload.length > 16384 ||
    !verify(null, payload, createPublicKey(key), Buffer.from(signature, 'base64'))
  )
    throw new Error('Invalid update signature.');
  const input = JSON.parse(payload.toString('utf8')) as UpdateManifest;
  if (
    !input ||
    !newer(input.version, current) ||
    input.platform !== platform ||
    input.architecture !== architecture ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    Date.parse(input.expiresAt) <= Date.now() ||
    Date.parse(input.expiresAt) > Date.now() + 7 * 86400000 ||
    !sameOrigin(input.artifact, origin) ||
    !/^[A-Za-z0-9+/]{86}==$/.test(input.sha512)
  )
    throw new Error('Update manifest is not applicable or expired.');
  return input;
}
export function digestArtifact(bytes: Buffer) {
  return createHash('sha512').update(bytes).digest('base64');
}
