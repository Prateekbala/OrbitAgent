export class ProviderFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryAfter = 0,
  ) {
    super(code);
  }
}
