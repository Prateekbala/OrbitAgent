import { createHmac, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../apps/api/src/lib/canonical-json.js';
export function signRelay(
  secret: string,
  workspaceId: string,
  sourceId: string,
  operation: 'claim' | 'batches' | 'complete',
  body: unknown,
) {
  const timestamp = Date.now().toString(),
    path = '/v1/migration-relay/' + sourceId + '/' + operation;
  return {
    path,
    headers: {
      'content-type': 'application/json',
      'x-orbit-workspace': workspaceId,
      'x-orbit-timestamp': timestamp,
      'x-orbit-signature':
        'v1=' +
        createHmac('sha256', secret)
          .update(timestamp + '\nPOST\n' + path + '\n' + canonicalJson(body))
          .digest('hex'),
    },
    body: JSON.stringify(body),
  };
}
export const newClaim = () => ({ clientId: randomUUID() });
