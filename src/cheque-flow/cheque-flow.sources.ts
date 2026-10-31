import {
  ChequeFlowDirection,
  ChequeFlowEntry,
  ChequeFlowStatus,
  ChequeStatus,
  Prisma,
} from '@prisma/client';
import { businessDateOf } from '../common/utils/business-date';
import {
  CHEQUE_TRANSITIONS,
  ChequeKind,
  REVERT_WINDOW_MS,
} from '../common/utils/cheque-transitions';
import { chequeKeyOf, cleanText, nameKey } from './cheque-flow.utils';

/**
 * Cheques shown in Cheque Flow come from four places. Only MANUAL rows live in
 * the register; the rest are read straight from the ERP tables on every
 * request — never copied — so they can't drift from Payments / Credits /
 * Refunds, and Cheque Flow never writes those tables itself.
 */
export type ChequeFlowSource = 'MANUAL' | 'PAYMENT' | 'SETTLEMENT' | 'REFUND';

export const SOURCE_LABEL: Record<ChequeFlowSource, string> = {
  MANUAL: 'Manual',
  PAYMENT: 'Payments',
  SETTLEMENT: 'Credits',
  REFUND: 'Refunds',
};

const ID_PREFIX: Record<Exclude<ChequeFlowSource, 'MANUAL'>, string> = {
  PAYMENT: 'pay_',
  SETTLEMENT: 'set_',
  REFUND: 'ref_',
};

/** One cheque from any source, in the register's own shape. */
export interface FlowRow {
  /** MANUAL: the entry id. Others: a prefixed id, e.g. "pay_<payment id>". */
  id: string;
  source: ChequeFlowSource;
  /** The id in its own table. */
  sourceId: string;
  direction: ChequeFlowDirection;
  chequeNumber: string | null;
  chequeKey: string;
  /** '' when the source didn't record a bank. */
  bankName: string;
  bankKey: string;
  /** Calendar date as a UTC-midnight Date (same as @db.Date). */
  chequeDate: Date;
  partyName: string;
  partyKey: string;
  invoiceRef: string | null;
  amount: Prisma.Decimal;
  status: ChequeFlowStatus;
  clearedDate: Date | null;
  remarks: string | null;
  importBatchId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Where to edit it (linked rows). */
  link: string | null;
  /** Statuses this cheque may move to right now, by its source's rules. */
  allowedStatuses: ChequeFlowStatus[];
  /** Linked rows: a short note on what it is, e.g. "Refund to customer". */
  kindLabel: string | null;
  /** A manual row for a cheque that is also recorded in Payments/Credits/Refunds. Left out of totals. */
  duplicateOf: { source: ChequeFlowSource; id: string } | null;
}

/** Inclusive-exclusive range of cheque dates (UTC-midnight Dates). */
export interface DayRange {
  gte?: Date;
  lt?: Date;
}

const DAY_MS = 86_400_000;

/** A stored DateTime → its Colombo calendar day as a UTC-midnight Date. */
export function calendarDay(value: Date): Date {
  return new Date(`${businessDateOf(value)}T00:00:00.000Z`);
}

/**
 * ERP dates are timestamps (UTC midnight or Colombo midnight depending on how
 * they were entered), so the database filter is widened by a day each side and
 * the exact calendar-day check is done afterwards.
 */
function widened(range: DayRange): Prisma.DateTimeFilter | undefined {
  if (!range.gte && !range.lt) return undefined;
  return {
    ...(range.gte && { gte: new Date(range.gte.getTime() - DAY_MS) }),
    ...(range.lt && { lt: new Date(range.lt.getTime() + DAY_MS) }),
  };
}

export function inRange(day: Date, range: DayRange): boolean {
  return (!range.gte || day >= range.gte) && (!range.lt || day < range.lt);
}

const STATUS_OF: Record<ChequeStatus, ChequeFlowStatus> = {
  PENDING: 'PENDING',
  CLEARED: 'CLEARED',
  RETURNED: 'BOUNCED',
};
export const ERP_STATUS: Partial<Record<ChequeFlowStatus, ChequeStatus>> = {
  PENDING: 'PENDING',
  CLEARED: 'CLEARED',
  BOUNCED: 'RETURNED',
};

/** The same rules the source page enforces, so only workable actions are offered. */
function allowed(
  kind: ChequeKind,
  from: ChequeStatus | null,
  changedAt: Date | null,
  now: Date,
): ChequeFlowStatus[] {
  if (!from) return [];
  const window = REVERT_WINDOW_MS[kind];
  return CHEQUE_TRANSITIONS[kind][from]
    .filter(
      (to) =>
        to !== 'PENDING' ||
        window === undefined ||
        (!!changedAt && now.getTime() - changedAt.getTime() <= window),
    )
    .map((to) => STATUS_OF[to]);
}

function base(
  partial: Omit<
    FlowRow,
    'chequeKey' | 'bankKey' | 'partyKey' | 'duplicateOf' | 'importBatchId'
  >,
): FlowRow {
  const chequeNumber = cleanText(partial.chequeNumber).replace(/^#\s*/, '');
  return {
    ...partial,
    chequeNumber: chequeNumber || null,
    chequeKey: chequeKeyOf(chequeNumber),
    bankName: cleanText(partial.bankName),
    bankKey: nameKey(partial.bankName),
    partyName: cleanText(partial.partyName) || '—',
    partyKey: nameKey(partial.partyName),
    importBatchId: null,
    duplicateOf: null,
  };
}

export function fromEntry(row: ChequeFlowEntry): FlowRow {
  return {
    id: row.id,
    source: 'MANUAL',
    sourceId: row.id,
    direction: row.direction,
    chequeNumber: row.chequeNumber,
    chequeKey: row.chequeKey,
    bankName: row.bankName,
    bankKey: row.bankKey,
    chequeDate: row.chequeDate,
    partyName: row.partyName,
    partyKey: row.partyKey,
    invoiceRef: row.invoiceRef,
    amount: row.amount,
    status: row.status,
    clearedDate: row.clearedDate,
    remarks: row.remarks,
    importBatchId: row.importBatchId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    link: null,
    allowedStatuses: (
      ['PENDING', 'CLEARED', 'BOUNCED', 'CANCELLED'] as const
    ).filter((s) => s !== row.status),
    kindLabel: null,
    duplicateOf: null,
  };
}

type Client = Prisma.TransactionClient;

/** Customer cheque payments (Payments page and approved rep collections). */
export async function loadPayments(
  db: Client,
  range: DayRange,
  now: Date,
): Promise<FlowRow[]> {
  const window = widened(range);
  const rows = await db.payment.findMany({
    where: {
      mode: 'CHEQUE',
      ...(window && {
        OR: [{ chequeDate: window }, { chequeDate: null, paymentDate: window }],
      }),
    },
    include: {
      dealer: { select: { businessName: true } },
      invoice: { select: { invoiceNumber: true } },
    },
  });
  return rows.map((p) => {
    // Cheques recorded before the cheque lifecycle existed have no status and
    // were always counted as received.
    const status = p.chequeStatus ? STATUS_OF[p.chequeStatus] : 'CLEARED';
    return base({
      id: ID_PREFIX.PAYMENT + p.id,
      source: 'PAYMENT',
      sourceId: p.id,
      direction: 'RECEIVABLE',
      chequeNumber: p.chequeNumber,
      bankName: p.bankName ?? '',
      chequeDate: calendarDay(p.chequeDate ?? p.paymentDate),
      partyName: p.dealer.businessName,
      invoiceRef: p.invoice?.invoiceNumber ?? null,
      amount: p.amount,
      status,
      clearedDate:
        p.chequeStatus === 'CLEARED' && p.chequeStatusUpdatedAt
          ? calendarDay(p.chequeStatusUpdatedAt)
          : null,
      remarks: p.remarks,
      createdAt: p.createdAt,
      updatedAt: p.chequeStatusUpdatedAt ?? p.createdAt,
      link: '/admin/payments',
      // A payment not tied to an invoice can't change cheque status (Payments rule).
      allowedStatuses: p.invoiceId
        ? allowed('DEALER', p.chequeStatus, p.chequeStatusUpdatedAt, now)
        : [],
      kindLabel: p.invoiceId ? null : 'Advance payment',
    });
  });
}

/** Supplier cheque settlements (Credits page). */
export async function loadSettlements(
  db: Client,
  range: DayRange,
  now: Date,
): Promise<FlowRow[]> {
  const window = widened(range);
  const rows = await db.supplierPayment.findMany({
    where: {
      mode: 'CHEQUE',
      ...(window && {
        OR: [
          { chequeDepositDate: window },
          { chequeDepositDate: null, paymentDate: window },
        ],
      }),
    },
    include: { supplier: { select: { name: true } } },
  });
  return rows.map((s) =>
    base({
      id: ID_PREFIX.SETTLEMENT + s.id,
      source: 'SETTLEMENT',
      sourceId: s.id,
      direction: 'PAYABLE',
      // The settlement form stores the cheque number as its reference.
      chequeNumber: s.reference,
      bankName: s.bankName ?? '',
      chequeDate: calendarDay(s.chequeDepositDate ?? s.paymentDate),
      partyName: s.supplier.name,
      invoiceRef: null,
      amount: s.amount,
      status: s.chequeStatus ? STATUS_OF[s.chequeStatus] : 'CLEARED',
      clearedDate:
        s.chequeStatus === 'CLEARED' && s.chequeStatusUpdatedAt
          ? calendarDay(s.chequeStatusUpdatedAt)
          : null,
      remarks: s.remarks,
      createdAt: s.createdAt,
      updatedAt: s.chequeStatusUpdatedAt ?? s.createdAt,
      link: `/admin/credits/${s.supplierId}`,
      allowedStatuses: allowed(
        'SUPPLIER',
        s.chequeStatus,
        s.chequeStatusUpdatedAt,
        now,
      ),
      kindLabel: null,
    }),
  );
}

/** Refund cheques: to a customer = money out, from a supplier = money in. */
export async function loadRefunds(
  db: Client,
  range: DayRange,
  now: Date,
): Promise<FlowRow[]> {
  const window = widened(range);
  const rows = await db.refund.findMany({
    where: {
      mode: 'CHEQUE',
      ...(window && {
        OR: [{ chequeDate: window }, { chequeDate: null, refundDate: window }],
      }),
    },
    include: {
      dealer: { select: { businessName: true } },
      supplier: { select: { name: true } },
    },
  });
  return rows.map((r) => {
    const toCustomer = r.party === 'DEALER';
    const cancelled = !!r.cancelledAt;
    return base({
      id: ID_PREFIX.REFUND + r.id,
      source: 'REFUND',
      sourceId: r.id,
      direction: toCustomer ? 'PAYABLE' : 'RECEIVABLE',
      chequeNumber: r.chequeNumber,
      bankName: r.bankName ?? '',
      chequeDate: calendarDay(r.chequeDate ?? r.refundDate),
      partyName:
        (toCustomer ? r.dealer?.businessName : r.supplier?.name) ?? '—',
      invoiceRef: r.refundNumber,
      amount: r.amount,
      status: cancelled
        ? 'CANCELLED'
        : r.chequeStatus
          ? STATUS_OF[r.chequeStatus]
          : 'CLEARED',
      clearedDate:
        !cancelled && r.chequeStatus === 'CLEARED' && r.chequeStatusUpdatedAt
          ? calendarDay(r.chequeStatusUpdatedAt)
          : null,
      remarks: r.reason,
      createdAt: r.createdAt,
      updatedAt: r.chequeStatusUpdatedAt ?? r.createdAt,
      link: '/admin/refunds',
      allowedStatuses: cancelled
        ? []
        : allowed(
            toCustomer ? 'REFUND_PAID' : 'REFUND_RECEIVED',
            r.chequeStatus,
            r.chequeStatusUpdatedAt,
            now,
          ),
      kindLabel: toCustomer ? 'Refund to customer' : 'Refund from supplier',
    });
  });
}

export async function loadLinked(
  db: Client,
  range: DayRange,
  now: Date,
): Promise<FlowRow[]> {
  const [payments, settlements, refunds] = await Promise.all([
    loadPayments(db, range, now),
    loadSettlements(db, range, now),
    loadRefunds(db, range, now),
  ]);
  return [...payments, ...settlements, ...refunds].filter((r) =>
    inRange(r.chequeDate, range),
  );
}

/** A cheque recorded in the ERP, reduced to what identifies it. */
export interface LinkedKey {
  source: ChequeFlowSource;
  id: string;
  direction: ChequeFlowDirection;
  chequeKey: string;
  bankKey: string;
  partyName: string;
  chequeDate: Date;
}

/** Every ERP cheque that has a number — used to spot manual copies of the same cheque. */
export async function loadLinkedKeys(db: Client): Promise<LinkedKey[]> {
  const [payments, settlements, refunds] = await Promise.all([
    db.payment.findMany({
      where: { mode: 'CHEQUE', chequeNumber: { not: null } },
      select: {
        id: true,
        chequeNumber: true,
        bankName: true,
        chequeDate: true,
        paymentDate: true,
        dealer: { select: { businessName: true } },
      },
    }),
    db.supplierPayment.findMany({
      where: { mode: 'CHEQUE', reference: { not: null } },
      select: {
        id: true,
        reference: true,
        bankName: true,
        chequeDepositDate: true,
        paymentDate: true,
        supplier: { select: { name: true } },
      },
    }),
    db.refund.findMany({
      where: { mode: 'CHEQUE', chequeNumber: { not: null }, cancelledAt: null },
      select: {
        id: true,
        party: true,
        chequeNumber: true,
        bankName: true,
        chequeDate: true,
        refundDate: true,
        dealer: { select: { businessName: true } },
        supplier: { select: { name: true } },
      },
    }),
  ]);
  const keys: LinkedKey[] = [
    ...payments.map((p) => ({
      source: 'PAYMENT' as const,
      id: ID_PREFIX.PAYMENT + p.id,
      direction: 'RECEIVABLE' as const,
      chequeKey: chequeKeyOf(p.chequeNumber),
      bankKey: nameKey(p.bankName ?? ''),
      partyName: p.dealer.businessName,
      chequeDate: calendarDay(p.chequeDate ?? p.paymentDate),
    })),
    ...settlements.map((s) => ({
      source: 'SETTLEMENT' as const,
      id: ID_PREFIX.SETTLEMENT + s.id,
      direction: 'PAYABLE' as const,
      chequeKey: chequeKeyOf(s.reference),
      bankKey: nameKey(s.bankName ?? ''),
      partyName: s.supplier.name,
      chequeDate: calendarDay(s.chequeDepositDate ?? s.paymentDate),
    })),
    ...refunds.map((r) => ({
      source: 'REFUND' as const,
      id: ID_PREFIX.REFUND + r.id,
      direction:
        r.party === 'DEALER' ? ('PAYABLE' as const) : ('RECEIVABLE' as const),
      chequeKey: chequeKeyOf(r.chequeNumber),
      bankKey: nameKey(r.bankName ?? ''),
      partyName: r.dealer?.businessName ?? r.supplier?.name ?? '—',
      chequeDate: calendarDay(r.chequeDate ?? r.refundDate),
    })),
  ];
  return keys.filter((k) => k.chequeKey);
}

/**
 * Finds the ERP cheque a manual cheque duplicates: same side and cheque
 * number, and the same bank when both sides recorded one.
 */
export function findLinked(
  keys: LinkedKey[],
  e: { direction: ChequeFlowDirection; chequeKey: string; bankKey: string },
): LinkedKey | undefined {
  if (!e.chequeKey) return undefined;
  return keys.find(
    (k) =>
      k.direction === e.direction &&
      k.chequeKey === e.chequeKey &&
      (!k.bankKey || !e.bankKey || k.bankKey === e.bankKey),
  );
}
