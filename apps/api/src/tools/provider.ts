import { Agent, request } from 'undici';
import { z } from 'zod';
import { validatePublicEndpoint } from '../lib/safe-endpoint.js';

const providerReceipt = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), receipt: z.string().min(1).max(500) }).strict(),
  z.object({ status: z.literal('not_applied'), receipt: z.string().min(1).max(500) }).strict(),
  z.object({ status: z.literal('unknown') }).strict(),
]);
export type ProviderReceipt = z.infer<typeof providerReceipt>;
export interface ProviderRequest {
  endpoint: string;
  secret: string;
  key: string;
  operation: string;
  payload: string;
  reconcile: boolean;
}
export type ActionProvider = (input: ProviderRequest) => Promise<ProviderReceipt>;
export function actionProvider(hosts: string[]): ActionProvider {
  return async (input) => {
    const { url, address } = await validatePublicEndpoint(input.endpoint, hosts, 'TOOL_PROVIDER');
    url.pathname = url.pathname.replace(/\/$/, '') + '/actions/' + input.key;
    const dispatcher = new Agent({
      connect: {
        lookup: (_host, options, callback) =>
          options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      },
    });
    try {
      const response = await request(url, {
        dispatcher,
        method: input.reconcile ? 'GET' : 'POST',
        headers: {
          authorization: 'Bearer ' + input.secret,
          'idempotency-key': input.key,
          'content-type': 'application/json',
        },
        ...(input.reconcile
          ? {}
          : {
              body: JSON.stringify({
                operation: input.operation,
                payload: JSON.parse(input.payload),
              }),
            }),
        signal: AbortSignal.timeout(15000),
        headersTimeout: 15000,
        bodyTimeout: 15000,
      });
      if (response.statusCode !== 200) {
        response.body.destroy();
        return { status: 'unknown' };
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 4096) {
          response.body.destroy();
          throw new Error('Provider receipt too large');
        }
        chunks.push(data);
      }
      return providerReceipt.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally {
      await dispatcher.close();
    }
  };
}
