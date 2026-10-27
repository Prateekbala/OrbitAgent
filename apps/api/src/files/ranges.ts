import { AppError } from '../lib/errors.js';
export interface ByteRange {
  start: number;
  end: number;
}
export function byteRange(value: string | undefined, size: number): ByteRange | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]))
    throw new AppError(416, 'INVALID_RANGE', 'Request one valid byte range.');
  const first = match[1] ? Number(match[1]) : null,
    last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    throw new AppError(416, 'INVALID_RANGE', 'The requested range is unavailable.');
  const start = first === null ? Math.max(0, size - last!) : first,
    end = first === null ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (start >= size || end < start || (last === 0 && first === null))
    throw new AppError(416, 'INVALID_RANGE', 'The requested range is unavailable.');
  return { start, end };
}
