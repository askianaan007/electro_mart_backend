import { BadRequestException } from '@nestjs/common';
import { ChequeStatus } from '@prisma/client';

/**
 * The one place each cheque kind's legal status changes are defined. A
 * change not listed here is rejected before anything is written.
 *
 * - DEALER (cheques received for invoices): any change, so a bank reversal
 *   (CLEARED → RETURNED) or a re-presented cheque (RETURNED → PENDING/CLEARED)
 *   can be recorded as it happened. Leaving RETURNED re-counts the money
 *   against the invoice, so PaymentsService re-checks the invoice balance.
 * - SUPPLIER (cheques we issued): forward from PENDING, plus a 1-day revert
 *   to PENDING for a mis-click. A RETURNED → PENDING revert re-counts the
 *   payment, so CreditsService re-checks the supplier balance (LC-03).
 * - SETTLEMENT / REFUND: forward from PENDING only — final once decided.
 * - INVESTMENT: same as SUPPLIER.
 */
export type ChequeKind =
  'DEALER' | 'SUPPLIER' | 'SETTLEMENT' | 'REFUND' | 'INVESTMENT';

const { PENDING, CLEARED, RETURNED } = ChequeStatus;

export const CHEQUE_TRANSITIONS: Record<
  ChequeKind,
  Record<ChequeStatus, readonly ChequeStatus[]>
> = {
  DEALER: {
    PENDING: [CLEARED, RETURNED],
    CLEARED: [RETURNED, PENDING],
    RETURNED: [PENDING, CLEARED],
  },
  SUPPLIER: {
    PENDING: [CLEARED, RETURNED],
    CLEARED: [PENDING],
    RETURNED: [PENDING],
  },
  INVESTMENT: {
    PENDING: [CLEARED, RETURNED],
    CLEARED: [PENDING],
    RETURNED: [PENDING],
  },
  SETTLEMENT: { PENDING: [CLEARED, RETURNED], CLEARED: [], RETURNED: [] },
  REFUND: { PENDING: [CLEARED, RETURNED], CLEARED: [], RETURNED: [] },
};

/** Kinds whose revert to PENDING is only a short mistake-correction window. */
const REVERT_WINDOW_MS: Partial<Record<ChequeKind, number>> = {
  SUPPLIER: 24 * 60 * 60 * 1000,
  INVESTMENT: 24 * 60 * 60 * 1000,
};

export function assertChequeTransition(
  kind: ChequeKind,
  from: ChequeStatus | null,
  to: ChequeStatus,
  statusChangedAt: Date | null,
  now: Date = new Date(),
) {
  if (!from) {
    throw new BadRequestException('This payment has no cheque status');
  }
  if (from === to) {
    throw new BadRequestException(`This cheque is already marked ${to}`);
  }
  if (!CHEQUE_TRANSITIONS[kind][from].includes(to)) {
    throw new BadRequestException(
      `A ${from} cheque cannot be changed to ${to}`,
    );
  }
  const window = REVERT_WINDOW_MS[kind];
  if (to === PENDING && window !== undefined) {
    if (
      !statusChangedAt ||
      now.getTime() - statusChangedAt.getTime() > window
    ) {
      throw new BadRequestException(
        `This cheque can only be reverted to pending within 1 day of being marked ${from}`,
      );
    }
  }
}
