import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  trustedOrigin,
  sameOrigin,
  externalLink,
  verifyManifest,
  digestArtifact,
} from '../src/policy.ts';
test('pins app origins and denies unsafe external protocols', () => {
  assert.equal(trustedOrigin('https://orbit.example'), 'https://orbit.example');
  for (const value of [
    'http://orbit.example',
    'https://user@orbit.example',
    'file:///etc/passwd',
    'https://orbit.example/path',
  ])
    assert.throws(() => trustedOrigin(value));
  assert.equal(sameOrigin('https://orbit.example.evil', 'https://orbit.example'), false);
  assert.equal(externalLink('javascript:alert(1)'), false);
  assert.equal(externalLink('https://orbit.example'), true);
});
test('requires applicable, unexpired signed updates and prevents downgrade/tampering', () => {
  const keys = generateKeyPairSync('ed25519'),
    key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const manifest = {
    version: '1.1.0',
    platform: process.platform,
    architecture: process.arch,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    artifact: 'https://releases.example/Orbit.zip',
    sha512: digestArtifact(Buffer.from('artifact')),
  };
  const payload = Buffer.from(JSON.stringify(manifest)),
    signature = sign(null, payload, keys.privateKey).toString('base64');
  assert.equal(
    verifyManifest(payload, signature, key, '1.0.0', 'https://releases.example').version,
    '1.1.0',
  );
  assert.throws(() => verifyManifest(payload, signature, key, '2.0.0', 'https://releases.example'));
  assert.throws(() =>
    verifyManifest(payload, signature, key, '1.0.0', 'https://different.example'),
  );
  assert.throws(() =>
    verifyManifest(
      Buffer.concat([payload, Buffer.from(' ')]),
      signature,
      key,
      '1.0.0',
      'https://releases.example',
    ),
  );
});
