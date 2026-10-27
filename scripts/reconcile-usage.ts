import { readFile } from 'node:fs/promises';
import { database } from '@ao/database';
import { usageReceipt, reconcileUsage } from '../apps/api/src/billing/reconciliation.js';
const file = process.argv[2];
if (!file || !process.env.BILLING_OPERATOR_DATABASE_URL)
  throw new Error(
    'Provide a receipt JSON file and BILLING_OPERATOR_DATABASE_URL using the migration/operator login.',
  );
const receipt = usageReceipt.parse(JSON.parse(await readFile(file, 'utf8'))),
  db = await database({ url: process.env.BILLING_OPERATOR_DATABASE_URL });
try {
  const result = await reconcileUsage(db, receipt);
  console.log(result.replayed ? 'Receipt already reconciled.' : 'Usage reconciliation appended.');
} finally {
  await db.close();
}
