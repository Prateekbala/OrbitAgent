import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { normalizePage } from '../../apps/api/src/interoperability/adapters.js';
import type { MigrationRecord } from '@ao/contracts/interoperability';
const root = await realpath(process.argv[2] ?? ''),
  source = process.argv[3];
if (!source)
  throw new Error(
    'Usage: node --import tsx examples/migrations/slack-archive.ts EXTRACTED_DIRECTORY SOURCE_WORKSPACE_ID',
  );
async function json(path: string) {
  const canonical = await realpath(resolve(root, path));
  if (!canonical.startsWith(root + sep) || (await stat(canonical)).size > 20 * 1024 * 1024)
    throw new Error('Invalid or oversized export file.');
  return JSON.parse(await readFile(canonical, 'utf8')) as unknown;
}
const channels = z
  .array(z.object({ id: z.string().min(1).max(200), name: z.string().regex(/^[a-zA-Z0-9_-]+$/) }))
  .max(10000)
  .parse(await json('channels.json'));
const users = z
  .array(
    z.object({
      id: z.string(),
      real_name: z.string().optional(),
      profile: z
        .object({ display_name: z.string().optional(), real_name: z.string().optional() })
        .optional(),
    }),
  )
  .parse(await json('users.json'));
const names = new Map(
  users.map((u) => [u.id, u.profile?.display_name || u.profile?.real_name || u.real_name || u.id]),
);
let pending: {
  clientId: string;
  cursor: string;
  complete: boolean;
  records: MigrationRecord[];
} | null = null;
for (const channel of channels) {
  const files = (await readdir(resolve(root, channel.name)))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  for (const file of files) {
    const raw = z
      .array(z.record(z.string(), z.unknown()))
      .max(100000)
      .parse(await json(channel.name + '/' + file));
    for (let offset = 0; offset < raw.length; offset += 100) {
      const records = normalizePage(
        'slack',
        channel.id,
        raw.slice(offset, offset + 100).map((m) => ({
          ...m,
          username:
            typeof m.user === 'string'
              ? (names.get(m.user) ?? m.user)
              : typeof m.username === 'string'
                ? m.username
                : 'Unknown Slack author',
        })),
      );
      const bytes = createHash('sha256')
        .update(
          source + '\n' + channel.id + '\n' + file + '\n' + offset + '\n' + JSON.stringify(records),
        )
        .digest()
        .subarray(0, 16);
      bytes[6] = (bytes[6]! & 0x0f) | 0x50;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = bytes.toString('hex'),
        clientId = [
          hex.slice(0, 8),
          hex.slice(8, 12),
          hex.slice(12, 16),
          hex.slice(16, 20),
          hex.slice(20),
        ].join('-');
      if (pending) process.stdout.write(JSON.stringify(pending) + '\n');
      pending = {
        clientId,
        cursor: channel.id + '/' + file + '/' + offset,
        complete: false,
        records,
      };
    }
  }
}
if (pending) process.stdout.write(JSON.stringify({ ...pending, complete: true }) + '\n');
