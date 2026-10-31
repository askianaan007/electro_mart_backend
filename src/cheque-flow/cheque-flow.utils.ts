import { BadRequestException } from '@nestjs/common';
import { ChequeFlowDirection, ChequeFlowStatus, Prisma } from '@prisma/client';
import { businessDateOf } from '../common/utils/business-date';

const ZERO = new Prisma.Decimal(0);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Collapses whitespace; '' for nothing. */
export function cleanText(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Case/space-insensitive key for banks and party names ("Commercial " = "commercial"). */
export function nameKey(value: string): string {
  return cleanText(value).toLowerCase();
}

/**
 * Duplicate key for a cheque number: letters and digits only, upper-case,
 * leading zeros dropped — so "#091942 ", "091942" and a spreadsheet's
 * zero-stripped 91942 all match. '' when there is no number.
 */
export function chequeKeyOf(chequeNumber: string | null | undefined): string {
  return String(chequeNumber ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/^0+(?=.)/, '');
}

/** The cheque number as entered, minus a leading '#' and stray spaces; null when blank. */
export function displayChequeNumber(
  chequeNumber: string | null | undefined,
): string | null {
  const cleaned = cleanText(chequeNumber).replace(/^#\s*/, '');
  return cleaned || null;
}

/** "YYYY-MM-DD" (Colombo calendar date) → the @db.Date value Prisma stores. */
export function toDateOnly(input: string, label: string): Date {
  let day: string;
  try {
    day = businessDateOf(input);
  } catch {
    throw new BadRequestException(`${label} is not a valid date`);
  }
  if (!DATE_ONLY.test(day)) {
    throw new BadRequestException(`${label} is not a valid date`);
  }
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new BadRequestException(`${label} is not a valid date`);
  }
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) {
    throw new BadRequestException(`${label} must be between 2000 and 2100`);
  }
  return date;
}

/** A @db.Date value back to "YYYY-MM-DD". */
export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's Colombo date as a @db.Date value. */
export function today(): Date {
  return new Date(`${businessDateOf(new Date())}T00:00:00.000Z`);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** [first day of month, first day of next month) for "YYYY-MM". */
export function monthRange(month: string): { gte: Date; lt: Date } {
  if (!MONTH.test(month)) {
    throw new BadRequestException('Month must look like 2026-10');
  }
  const [y, m] = month.split('-').map(Number);
  return {
    gte: new Date(Date.UTC(y, m - 1, 1)),
    lt: new Date(Date.UTC(y, m, 1)),
  };
}

export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** The months from `from` to `to` inclusive ("YYYY-MM"). */
export function monthsBetween(from: string, to: string): string[] {
  const start = monthRange(from).gte;
  const end = monthRange(to).gte;
  const out: string[] = [];
  for (
    let d = start;
    d <= end;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  ) {
    out.push(monthOf(d));
  }
  return out;
}

export interface SideTotals {
  /** Pending + cleared — bounced and cancelled are kept out. */
  total: number;
  pending: number;
  cleared: number;
  bounced: number;
  cancelled: number;
  count: number;
  pendingCount: number;
  clearedCount: number;
  bouncedCount: number;
  cancelledCount: number;
}

export interface ChequeFlowSummary {
  receivable: SideTotals;
  payable: SideTotals;
  /** Pending customer cheques − pending supplier cheques. Negative = additional funds required. */
  netPending: number;
}

type GroupRow = {
  direction: ChequeFlowDirection;
  status: ChequeFlowStatus;
  _sum: { amount: Prisma.Decimal | null };
  _count: { _all: number };
};

const emptySide = (): SideTotals => ({
  total: 0,
  pending: 0,
  cleared: 0,
  bounced: 0,
  cancelled: 0,
  count: 0,
  pendingCount: 0,
  clearedCount: 0,
  bouncedCount: 0,
  cancelledCount: 0,
});

/** Builds the summary from a groupBy(direction, status); sums in Decimal, rounded once. */
export function summarise(rows: GroupRow[]): ChequeFlowSummary {
  const sums = new Map<string, Prisma.Decimal>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.direction}:${row.status}`;
    sums.set(key, (sums.get(key) ?? ZERO).add(row._sum.amount ?? ZERO));
    counts.set(key, (counts.get(key) ?? 0) + row._count._all);
  }
  const side = (direction: ChequeFlowDirection): SideTotals => {
    const amount = (status: ChequeFlowStatus) =>
      sums.get(`${direction}:${status}`) ?? ZERO;
    const count = (status: ChequeFlowStatus) =>
      counts.get(`${direction}:${status}`) ?? 0;
    const out = emptySide();
    out.pending = amount('PENDING').toNumber();
    out.cleared = amount('CLEARED').toNumber();
    out.bounced = amount('BOUNCED').toNumber();
    out.cancelled = amount('CANCELLED').toNumber();
    out.total = amount('PENDING').add(amount('CLEARED')).toNumber();
    out.pendingCount = count('PENDING');
    out.clearedCount = count('CLEARED');
    out.bouncedCount = count('BOUNCED');
    out.cancelledCount = count('CANCELLED');
    out.count = out.pendingCount + out.clearedCount;
    return out;
  };
  const receivable = side('RECEIVABLE');
  const payable = side('PAYABLE');
  return {
    receivable,
    payable,
    netPending: new Prisma.Decimal(receivable.pending)
      .sub(payable.pending)
      .toNumber(),
  };
}

export interface TimelineDay {
  date: string;
  receipts: number;
  payments: number;
  net: number;
  /** Running net of pending cheques from the 1st of the month. */
  cumulative: number;
  /** Payments fall before enough receipts: the running net is below zero on a payment day. */
  shortfall: boolean;
}

/** Date-wise expected receipts/payments (pending cheques) for one month. */
export function buildTimeline(
  rows: {
    direction: ChequeFlowDirection;
    chequeDate: Date;
    _sum: { amount: Prisma.Decimal | null };
  }[],
): TimelineDay[] {
  const byDay = new Map<
    string,
    { receipts: Prisma.Decimal; payments: Prisma.Decimal }
  >();
  for (const row of rows) {
    const day = dayOf(row.chequeDate);
    const entry = byDay.get(day) ?? { receipts: ZERO, payments: ZERO };
    if (row.direction === 'RECEIVABLE') {
      entry.receipts = entry.receipts.add(row._sum.amount ?? ZERO);
    } else {
      entry.payments = entry.payments.add(row._sum.amount ?? ZERO);
    }
    byDay.set(day, entry);
  }
  let running = ZERO;
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { receipts, payments }]) => {
      const net = receipts.sub(payments);
      running = running.add(net);
      return {
        date,
        receipts: receipts.toNumber(),
        payments: payments.toNumber(),
        net: net.toNumber(),
        cumulative: running.toNumber(),
        shortfall: payments.greaterThan(0) && running.isNegative(),
      };
    });
}
