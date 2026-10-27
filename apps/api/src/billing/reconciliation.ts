import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '@ao/database';
import { digest } from '../lib/security.js';
export const usageReceipt = z
  .object({
    id: z.string().min(1).max(200),
    workspaceId: z.uuid(),
    category: z.enum(['models', 'tools', 'runtime', 'media']),
    reference: z.uuid(),
    expectedVersion: z.number().int().positive(),
    units: z.string().regex(/^\d{1,15}$/),
    costMicros: z.string().regex(/^\d{1,15}$/),
  })
  .strict();
export async function reconcileUsage(db: Database, input: z.infer<typeof usageReceipt>) {
  const receipt = usageReceipt.parse(input),
    hash = digest(JSON.stringify(receipt));
  return db.transaction(async (tx) => {
    const [account] = await tx.query(
      'SELECT a.organization_id FROM billing_accounts a JOIN workspaces w ON w.organization_id=a.organization_id WHERE w.id=$1 FOR UPDATE OF a',
      [receipt.workspaceId],
    );
    if (!account) throw new Error('Unknown billing account.');
    const [prior] = await tx.query('SELECT body_hash FROM billing_receipts WHERE id=$1', [
      receipt.id,
    ]);
    if (prior) {
      if (prior.body_hash !== hash) throw new Error('Receipt identity conflict.');
      return { replayed: true };
    }
    const [reservation] = await tx.query(
      'SELECT * FROM billing_reservations WHERE workspace_id=$1 AND category=$2 AND reference=$3 FOR UPDATE',
      [receipt.workspaceId, receipt.category, receipt.reference],
    );
    if (!reservation || Number(reservation.reconciliation_version) !== receipt.expectedVersion)
      throw new Error('Reservation or reconciliation version changed.');
    const [posted] = await tx.query(
      'SELECT coalesce(sum(units_delta),0)::text units,coalesce(sum(cost_micros),0)::text cost FROM usage_ledger WHERE workspace_id=$1 AND category=$2 AND (reference=$3 OR reference IN(SELECT adjustment_id FROM billing_receipts WHERE workspace_id=$1 AND category=$2 AND reference=$3))',
      [receipt.workspaceId, receipt.category, receipt.reference],
    );
    const adjustment = randomUUID();
    await tx.query(
      'INSERT INTO billing_receipts(id,workspace_id,category,reference,body_hash,adjustment_id) VALUES($1,$2,$3,$4,$5,$6)',
      [receipt.id, receipt.workspaceId, receipt.category, receipt.reference, hash, adjustment],
    );
    await tx.query(
      "INSERT INTO usage_ledger(workspace_id,organization_id,category,reference,units_delta,cost_micros,confidence) VALUES($1,$2,$3,$4,$5,$6,'operator_provider_receipt')",
      [
        receipt.workspaceId,
        account.organization_id,
        receipt.category,
        adjustment,
        (BigInt(receipt.units) - BigInt(String(posted!.units))).toString(),
        (BigInt(receipt.costMicros) - BigInt(String(posted!.cost))).toString(),
      ],
    );
    await tx.query(
      "UPDATE billing_reservations SET state='settled',actual_units=$4,actual_cost_micros=$5,confidence='operator_provider_receipt',reconciliation_version=reconciliation_version+1,settled_at=now() WHERE workspace_id=$1 AND category=$2 AND reference=$3",
      [receipt.workspaceId, receipt.category, receipt.reference, receipt.units, receipt.costMicros],
    );
    return { replayed: false };
  });
}
