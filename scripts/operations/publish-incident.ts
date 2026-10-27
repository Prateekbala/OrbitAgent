import { readFile } from 'node:fs/promises';
import { database } from '@ao/database';
import { z } from 'zod';
const input = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(3).max(200),
    status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
    description: z.string().trim().min(1).max(5000),
  })
  .strict()
  .parse(JSON.parse(await readFile(process.argv[2] ?? '', 'utf8')));
if (!process.env.OPERATIONS_DATABASE_URL)
  throw new Error('Use the isolated incident operator connection.');
const db = await database({ url: process.env.OPERATIONS_DATABASE_URL });
try {
  await db.query(
    'INSERT INTO public_incidents(id,title,status,description) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,status=EXCLUDED.status,description=EXCLUDED.description,updated_at=now()',
    [input.id, input.title, input.status, input.description],
  );
  console.log('Incident published. Review /status from a public session.');
} finally {
  await db.close();
}
