export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const notFound = () =>
  new AppError(404, 'NOT_FOUND', 'The requested resource is unavailable.');
