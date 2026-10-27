import { readFile, writeFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import { database } from '@ao/database';
import { z } from 'zod';
const org = z.uuid().parse(process.argv[2]),
  output = process.argv[3];
if (!output || !process.env.OPERATOR_DATABASE_URL || !process.env.AUDIT_SIGNING_KEY_FILE)
  throw new Error('Provide organization, output file, operator connection and audit signing key.');
const key = createPrivateKey(await readFile(process.env.AUDIT_SIGNING_KEY_FILE));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 audit key is required.');
const db = await database({ url: process.env.OPERATOR_DATABASE_URL });
try {
  const [head] = await db.query(
    'SELECT sequence::text,hash FROM security_audit_heads WHERE organization_id=$1',
    [org],
  );
  if (!head) throw new Error('No audit stream exists.');
  const payload = Buffer.from(
    JSON.stringify({
      organizationId: org,
      sequence: head.sequence,
      hash: head.hash,
      anchoredAt: new Date().toISOString(),
    }),
  );
  await writeFile(
    output,
    JSON.stringify({
      payload: payload.toString('base64'),
      signature: sign(null, payload, key).toString('base64'),
    }),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Signed audit head written. Publish to the independent append-only evidence store.');
} finally {
  await db.close();
}
