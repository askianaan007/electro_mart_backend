import { Prisma } from '@prisma/client';

/**
 * An investment (or withdrawal) has actually moved money — and so counts in
 * Liquid Cash, equity and the balance sheet — when it wasn't a cheque, when
 * its cheque CLEARED, or when it was recorded before cheque tracking existed
 * (chequeStatus NULL: those always counted and still do). A PENDING or
 * RETURNED cheque doesn't (LC-09).
 */
export const EFFECTIVE_INVESTMENT_FILTER: Prisma.InvestmentWhereInput = {
  OR: [
    { mode: { not: 'CHEQUE' } },
    { chequeStatus: null },
    { chequeStatus: 'CLEARED' },
  ],
};
