import { z } from 'zod';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
const cursor = z
  .object({ scope: z.string().max(500), at: z.iso.datetime({ offset: true }), id: z.uuid() })
  .strict();
export function pageBoundary(p: Identity, kind: string, value?: string) {
  if (!value) return null;
  try {
    const parsed = cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (parsed.scope !== `${p.workspaceId}:${p.membershipId}:${kind}`) throw new Error();
    return parsed;
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'Use a cursor from this view and workspace.');
  }
}
export function pageResult<T extends Record<string, unknown>>(
  p: Identity,
  kind: string,
  rows: T[],
  limit: number,
  timeKey = 'created_at',
  idKey = 'id',
) {
  const items = rows.slice(0, limit),
    last = items.at(-1);
  return {
    items,
    next:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              scope: `${p.workspaceId}:${p.membershipId}:${kind}`,
              at: last.position_time ?? last[timeKey],
              id: last[idKey],
            }),
          ).toString('base64url')
        : null,
  };
}
