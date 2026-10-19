import { Prisma } from '@prisma/client';

export type LedgerEntityType =
  'SUPPLIER_PAYMENT' | 'INVESTMENT' | 'EXPENSE' | 'REFUND';

export type LedgerRevisionAction =
  'UPDATED' | 'CHEQUE_STATUS' | 'DELETED' | 'CANCELLED';

/**
 * Saves `row` as it is *before* a change, so Liquid Cash history can show the
 * original entry on its own date and the change as a separate dated
 * correction row (LiquidCashService). Must run in the same transaction as the
 * change. Decimal/Date values are stored as strings via their toJSON.
 */
export function recordLedgerRevision(
  tx: Prisma.TransactionClient,
  entityType: LedgerEntityType,
  row: { id: string },
  action: LedgerRevisionAction,
  adminId: string,
) {
  return tx.ledgerRevision.create({
    data: {
      entityType,
      entityId: row.id,
      action,
      adminId,
      snapshot: JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue,
    },
  });
}
