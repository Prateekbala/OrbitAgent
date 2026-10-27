import { createPublicKey, verify, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export async function verifyReleaseEvidence(path, key, expected, now = Date.now()) {
  const bytes = await readFile(path);
  if (bytes.length > 16384) throw new Error('Evidence envelope too large.');
  const envelope = JSON.parse(bytes);
  const payload = Buffer.from(envelope.payload ?? '', 'base64');
  if (
    createPublicKey(key).asymmetricKeyType !== 'ed25519' ||
    !verify(null, payload, key, Buffer.from(envelope.signature ?? '', 'base64'))
  )
    throw new Error('Invalid qualification signature.');
  const evidence = JSON.parse(payload.toString('utf8'));
  if (
    evidence.kind !== expected.kind ||
    evidence.revision !== expected.revision ||
    evidence.result !== 'passed' ||
    typeof evidence.reviewer !== 'string' ||
    evidence.reviewer.trim().length < 3 ||
    !Number.isFinite(Date.parse(evidence.expiresAt)) ||
    Date.parse(evidence.expiresAt) <= now ||
    !Number.isFinite(Date.parse(evidence.assessedAt)) ||
    Date.parse(evidence.assessedAt) > now ||
    Date.parse(evidence.assessedAt) >= Date.parse(evidence.expiresAt)
  )
    throw new Error('Stale or mismatched qualification.');
  for (const [name, digest] of Object.entries(expected.images))
    if (evidence.images?.[name] !== digest) throw new Error('Qualification names another image.');
  const artifact = await readFile(path + '.artifact');
  if (
    artifact.length === 0 ||
    createHash('sha256').update(artifact).digest('hex') !== evidence.artifactHash
  )
    throw new Error('Qualification artifact missing or changed.');
  return { kind: evidence.kind, reviewer: evidence.reviewer, expiresAt: evidence.expiresAt };
}
