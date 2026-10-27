import { ingestOrganizationReceipt } from '../../apps/api/src/governance/organization-erasure.js';
import { readFile } from 'node:fs/promises';
import { database } from '@ao/database';
import { ingestDeletionReceipt } from '../../apps/api/src/governance/lifecycle.js';
const [file, signatureFile, keyFile] = process.argv.slice(2);
if (!file || !signatureFile || !keyFile || !process.env.OPERATOR_DATABASE_URL)
  throw new Error(
    'Provide receipt, detached signature, public verification key and OPERATOR_DATABASE_URL.',
  );
const db = await database({ url: process.env.OPERATOR_DATABASE_URL });
try {
  const payload = await readFile(file);
  const receive =
    JSON.parse(payload.toString()).scope === 'organization'
      ? ingestOrganizationReceipt
      : ingestDeletionReceipt;
  const result = await receive(
    db,
    payload,
    (await readFile(signatureFile, 'utf8')).trim(),
    await readFile(keyFile, 'utf8'),
  );
  console.log(
    result.replayed ? 'Receipt already recorded.' : 'Verified deletion evidence recorded.',
  );
} finally {
  await db.close();
}
