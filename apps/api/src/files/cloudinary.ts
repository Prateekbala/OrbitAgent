import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { z } from 'zod';
import type { FileStore } from './storage.js';
import type { ByteRange } from './ranges.js';

const credentials = z.object({
  cloudName: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  apiKey: z.string().regex(/^[0-9]{1,100}$/),
  apiSecret: z.string().min(16).max(200),
  folder: z
    .string()
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/),
});
const uploadedAsset = z.object({
  public_id: z.string(),
  resource_type: z.literal('raw'),
  type: z.literal('authenticated'),
  bytes: z.number().int().nonnegative(),
});
const resourcePage = z.object({
  resources: z.array(z.object({ public_id: z.string() })).max(100),
});

export class CloudinaryFileStore implements FileStore {
  readonly id = 'cloudinary' as const;
  private readonly config: z.infer<typeof credentials>;
  private readonly origin: string;
  constructor(
    config: z.infer<typeof credentials>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const parsed = credentials.safeParse(config);
    if (!parsed.success) throw new Error('Invalid Cloudinary storage configuration.');
    this.config = parsed.data;
    this.origin = `https://api.cloudinary.com/v1_1/${this.config.cloudName}`;
  }

  private publicId(key: string) {
    if (key.length > 500 || !/^[a-f0-9-]{36}\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)*$/.test(key))
      throw new Error('Invalid storage key.');
    return `${this.config.folder}/${key}`;
  }

  private signed(fields: Record<string, string>) {
    const values = { ...fields, timestamp: String(Math.floor(Date.now() / 1000)) };
    const canonical = Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return {
      ...values,
      api_key: this.config.apiKey,
      signature: createHash('sha256')
        .update(canonical + this.config.apiSecret)
        .digest('hex'),
    };
  }

  private async request(path: string, options: RequestInit) {
    try {
      const response = await this.fetcher(this.origin + path, {
        ...options,
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      return response;
    } catch {
      throw new Error('Cloudinary storage request failed.');
    }
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new Error('Invalid Cloudinary storage response.');
    }
  }

  async put(key: string, path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const publicId = this.publicId(key);
    const file = await openAsBlob(path);
    const body = new FormData();
    for (const [name, value] of Object.entries(
      this.signed({
        public_id: publicId,
        type: 'authenticated',
        overwrite: 'true',
        backup: 'false',
        invalidate: 'true',
      }),
    ))
      body.set(name, value);
    body.set('file', file, 'object');
    const response = await this.request('/raw/upload', { method: 'POST', body, signal });
    const asset = uploadedAsset.safeParse(await this.json(response));
    if (!asset.success || asset.data.public_id !== publicId || asset.data.bytes !== file.size)
      throw new Error('Cloudinary did not confirm the private upload.');
  }

  async get(key: string, range?: ByteRange) {
    const fields = this.signed({
      public_id: this.publicId(key),
      type: 'authenticated',
      expires_at: String(Math.floor(Date.now() / 1000) + 60),
    });
    const response = await this.request('/raw/download?' + new URLSearchParams(fields), {
      method: 'GET',
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error('Cloudinary returned no readable original.');
    }
    const source = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
    if (!range) return source;
    const output = Readable.from(
      (async function* () {
        let offset = 0;
        try {
          for await (const chunk of source) {
            const bytes = Buffer.from(chunk);
            const start = Math.max(0, range.start - offset);
            const end = Math.min(bytes.length, range.end + 1 - offset);
            offset += bytes.length;
            if (end > start) yield bytes.subarray(start, end);
            if (offset > range.end) return;
          }
          throw new Error('Cloudinary returned an incomplete byte range.');
        } finally {
          source.destroy();
        }
      })(),
    );
    output.once('close', () => source.destroy());
    return output;
  }

  async delete(key: string) {
    const response = await this.request('/raw/destroy', {
      method: 'POST',
      body: new URLSearchParams(
        this.signed({ public_id: this.publicId(key), type: 'authenticated', invalidate: 'true' }),
      ),
    });
    const result = z
      .object({ result: z.enum(['ok', 'not found']) })
      .safeParse(await this.json(response));
    if (!result.success) throw new Error('Cloudinary did not confirm deletion.');
  }

  async purgeWorkspace(workspaceId: string, heartbeat: () => Promise<void>) {
    const prefix = this.publicId(`${workspaceId}/namespace`).replace(/namespace$/, '');
    let prior = '';
    for (let batch = 0; batch < 100; batch++) {
      await heartbeat();
      const response = await this.request(
        '/resources/raw/authenticated?' + new URLSearchParams({ prefix, max_results: '100' }),
        {
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString('base64'),
          },
        },
      );
      const page = resourcePage.safeParse(await this.json(response));
      if (!page.success) throw new Error('Invalid Cloudinary storage inventory.');
      const resources = page.data.resources.map((resource) => resource.public_id);
      if (!resources.length) return;
      if (resources.some((id) => !id.startsWith(prefix)))
        throw new Error('Cloudinary returned a foreign workspace namespace.');
      const signature = [...resources].sort().join('\n');
      if (prior === signature) throw new Error('Cloudinary storage deletion did not progress.');
      prior = signature;
      for (const id of resources) {
        await heartbeat();
        await this.delete(id.slice(this.config.folder.length + 1));
      }
    }
    throw new Error('Cloudinary storage erasure must continue in the next attempt.');
  }
}
