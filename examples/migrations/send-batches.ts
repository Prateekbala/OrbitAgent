import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';
import { migrationBatch } from '@ao/contracts/interoperability';
import { canonicalJson } from '../../apps/api/src/lib/canonical-json.js';
const origin = new URL(process.env.MIGRATION_API_ORIGIN ?? 'http://localhost:4000');
if (
  origin.protocol !== 'https:' &&
  !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))
)
  throw new Error('An HTTPS API origin is required outside literal loopback.');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
  throw new Error('Use an origin without credentials or a path.');
const source = process.env.MIGRATION_SOURCE_ID,
  workspace = process.env.MIGRATION_WORKSPACE_ID,
  secret = process.env.MIGRATION_RELAY_SECRET;
if (!source || !workspace || !secret)
  throw new Error(
    'Set MIGRATION_SOURCE_ID, MIGRATION_WORKSPACE_ID and MIGRATION_RELAY_SECRET outside source control.',
  );
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  if (Buffer.byteLength(line) > 390000)
    throw new Error('Split this page below the API body limit.');
  const body = migrationBatch.parse(JSON.parse(line)),
    path = '/v1/migration-relay/' + source + '/batches',
    timestamp = Date.now().toString(),
    signature = createHmac('sha256', secret)
      .update(timestamp + '\nPOST\n' + path + '\n' + canonicalJson(body))
      .digest('hex');
  const response = await fetch(new URL(path, origin), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      'content-type': 'application/json',
      'x-orbit-workspace': workspace,
      'x-orbit-timestamp': timestamp,
      'x-orbit-signature': 'v1=' + signature,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      'Batch rejected with HTTP ' +
        response.status +
        '. Inspect the migration report; provider payloads and secrets are not logged.',
    );
  process.stderr.write('Accepted batch ' + body.clientId + '\n');
}
