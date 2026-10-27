import type { operations as Contract } from './schema.js';
import { operations } from './operations.js';
export type * from './schema.js';
type Operation = keyof typeof operations & keyof Contract;
type ParametersOf<K extends Operation> = Contract[K] extends { parameters: infer P } ? P : never;
type PathOf<K extends Operation> =
  ParametersOf<K> extends { path: infer P } ? P : Record<string, never>;
type QueryOf<K extends Operation> =
  ParametersOf<K> extends { query?: infer Q } ? Q : Record<string, never>;
type BodyOf<K extends Operation> = Contract[K] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;
export type OperationInput<K extends Operation> = (ParametersOf<K> extends { path: unknown }
  ? { path: PathOf<K> }
  : { path?: never }) & { query?: QueryOf<K>; signal?: AbortSignal } & ([BodyOf<K>] extends [never]
    ? { body?: never }
    : { body: BodyOf<K> });
type Responses<K extends Operation> = Contract[K] extends { responses: infer R } ? R : never;
export type OperationResult<K extends Operation> =
  Responses<K> extends { 200: { content: { 'application/json': infer R } } } ? R : unknown;
export class OrbitError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'OrbitError';
  }
}
export class OrbitClient {
  private readonly base: URL;
  constructor(
    baseUrl: string,
    private readonly token: () => string | Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    if (
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      !(
        this.base.protocol === 'https:' ||
        (this.base.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname))
      )
    )
      throw new Error('Use an HTTPS API base URL, or loopback HTTP for local development.');
  }
  async request<K extends Operation>(
    operation: K,
    input: OperationInput<K>,
  ): Promise<OperationResult<K>> {
    const definition = operations[operation];
    let path: string = definition.path;
    for (const [key, value] of Object.entries(input.path ?? {}))
      path = path.replace('{' + key + '}', encodeURIComponent(String(value)));
    if (path.includes('{')) throw new Error('Missing API path parameter.');
    const url = new URL(path.slice(1), this.base);
    for (const [key, value] of Object.entries(input.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await this.fetcher(url, {
      method: definition.method,
      headers: {
        authorization: 'Bearer ' + (await this.token()),
        accept: 'application/json',
        ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      redirect: 'error',
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
    const data = (await response.json()) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    if (!response.ok)
      throw new OrbitError(
        response.status,
        data.error?.code ?? 'REQUEST_FAILED',
        data.error?.message ?? 'The API request failed.',
        data.error?.requestId,
      );
    return data as OperationResult<K>;
  }
}
