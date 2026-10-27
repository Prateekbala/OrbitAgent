import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const mobile = createRequire(new URL('../../apps/mobile/package.json', import.meta.url)),
  expo = createRequire(mobile.resolve('expo/package.json')),
  cli = createRequire(expo.resolve('@expo/cli/package.json')),
  signingRequire = createRequire(cli.resolve('@expo/code-signing-certificates/package.json'));
test('patched Expo schemas validate plugin and MCP command boundaries', () => {
  assert.ok(Number(cli('zod/package.json').version.split('.')[0]) >= 4);
  const { PluginSchema, DevToolsPluginOutputSchema } = cli(
    './build/src/start/server/DevToolsPlugin.schema.js',
  );
  const { createMCPDevToolsExtensionSchema } = cli(
    './build/src/start/server/createMCPDevToolsExtensionSchema.js',
  );
  const plugin = PluginSchema.parse({
    packageName: 'orbit-test',
    packageRoot: '/synthetic',
    cliExtensions: {
      description: 'Synthetic commands',
      entryPoint: 'cli.js',
      commands: [
        {
          name: 'inspect',
          title: 'Inspect fixture',
          environments: ['cli', 'mcp'],
          parameters: [
            { name: 'limit', type: 'number' },
            { name: 'confirm', type: 'confirm' },
            { name: 'query', type: 'text' },
          ],
        },
      ],
    },
  });
  const schema = createMCPDevToolsExtensionSchema(plugin);
  assert.equal(
    schema.safeParse({ command: 'inspect', limit: 5, confirm: true, query: 'test' }).success,
    true,
  );
  for (const value of [
    { command: 'other' },
    { command: 'inspect', limit: 'five' },
    { command: 'inspect', unexpected: 'injected' },
  ])
    assert.equal(schema.safeParse(value).success, false);
  assert.equal(
    DevToolsPluginOutputSchema.safeParse([
      { type: 'text', level: 'info', text: 'Result' },
      { type: 'image', url: 'https://example.com/fixture.png' },
    ]).success,
    true,
  );
  assert.equal(
    DevToolsPluginOutputSchema.safeParse([{ type: 'audio', url: 'invalid' }]).success,
    false,
  );
});
test('patched Forge preserves Expo signing and rejects malformed DigestAlgorithm elements', () => {
  const forge = signingRequire('node-forge'),
    signing = cli('@expo/code-signing-certificates');
  const [major, minor, patch] = signingRequire('node-forge/package.json')
    .version.split('.')
    .map(Number);
  assert.ok(major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 1))));
  const pair = signing.generateKeyPair(),
    certificate = signing.generateSelfSignedCodeSigningCertificate({
      keyPair: pair,
      validityNotBefore: new Date(Date.now() - 1000),
      validityNotAfter: new Date(Date.now() + 86400000),
      commonName: 'Orbit synthetic test',
    });
  signing.validateSelfSignedCertificate(certificate, pair);
  const digest = forge.md.sha256.create();
  digest.update('synthetic payload');
  const signature = pair.privateKey.sign(digest);
  assert.equal(pair.publicKey.verify(digest.digest().bytes(), signature), true);
  const a = forge.asn1,
    u = a.Class.UNIVERSAL;
  const info = a.create(u, a.Type.SEQUENCE, true, [
    a.create(u, a.Type.SEQUENCE, true, [
      a.create(u, a.Type.OID, false, a.oidToDer(forge.pki.oids.sha256).getBytes()),
      a.create(u, a.Type.NULL, false, ''),
      a.create(u, a.Type.NULL, false, ''),
    ]),
    a.create(u, a.Type.OCTETSTRING, false, digest.digest().bytes()),
  ]);
  const bad = pair.privateKey.sign({ getBytes: () => a.toDer(info).getBytes() }, 'NONE');
  assert.throws(() => pair.publicKey.verify(digest.digest().bytes(), bad));
});
