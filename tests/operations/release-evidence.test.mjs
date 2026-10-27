import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReleaseEvidence } from '../../scripts/operations/release-evidence.mjs';
test('rejects forged, stale, different-build, and changed-artifact qualification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-release-')),
    path = join(dir, 'evidence.json'),
    keys = generateKeyPairSync('ed25519');
  const key = keys.publicKey.export({ type: 'spki', format: 'pem' }),
    artifact = randomBytes(50),
    expected = {
      kind: 'FAILOVER_EVIDENCE',
      revision: 'a'.repeat(40),
      images: { API_IMAGE: 'app@sha256:' + 'b'.repeat(64) },
    };
  const data = {
    ...expected,
    result: 'passed',
    reviewer: 'Recovery operator',
    assessedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    artifactHash: createHash('sha256').update(artifact).digest('hex'),
  };
  const save = async (value) => {
    const payload = Buffer.from(JSON.stringify(value));
    await writeFile(
      path,
      JSON.stringify({
        payload: payload.toString('base64'),
        signature: sign(null, payload, keys.privateKey).toString('base64'),
      }),
    );
  };
  try {
    await writeFile(path + '.artifact', artifact);
    await save(data);
    assert.equal((await verifyReleaseEvidence(path, key, expected)).kind, expected.kind);
    await assert.rejects(() =>
      verifyReleaseEvidence(path, key, { ...expected, revision: 'c'.repeat(40) }),
    );
    await assert.rejects(() =>
      verifyReleaseEvidence(path, key, { ...expected, images: { API_IMAGE: 'other' } }),
    );
    await save({ ...data, expiresAt: new Date(Date.now() - 500).toISOString() });
    await assert.rejects(() => verifyReleaseEvidence(path, key, expected));
    await save(data);
    await writeFile(path + '.artifact', 'altered');
    await assert.rejects(() => verifyReleaseEvidence(path, key, expected));
    await writeFile(
      path,
      JSON.stringify({ payload: 'Zm9yZ2Vk', signature: randomBytes(64).toString('base64') }),
    );
    await assert.rejects(() => verifyReleaseEvidence(path, key, expected));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
