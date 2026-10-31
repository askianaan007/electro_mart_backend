import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ChequeFlowDirection,
  ChequeFlowEntry,
  ChequeFlowStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { MAX_MONEY_AMOUNT } from '../common/decorators/is-money-amount.decorator';
import { CreateChequeFlowDto } from './dto/create-cheque-flow.dto';
import { UpdateChequeFlowDto } from './dto/update-cheque-flow.dto';
import { UpdateChequeFlowStatusDto } from './dto/update-cheque-flow-status.dto';
import {
  ChequeFlowFiltersDto,
  QueryChequeFlowDto,
  QueryChequeFlowMonthlyDto,
} from './dto/query-cheque-flow.dto';
import {
  ChequeFlowImportRowDto,
  CommitChequeFlowImportDto,
  PreviewChequeFlowImportDto,
} from './dto/import-cheque-flow.dto';
import {
  addDays,
  buildTimeline,
  chequeKeyOf,
  cleanText,
  dayOf,
  displayChequeNumber,
  monthOf,
  monthRange,
  monthsBetween,
  nameKey,
  summarise,
  toDateOnly,
  today,
} from './cheque-flow.utils';
import {
  ChequeFlowSource,
  DayRange,
  FlowRow,
  LinkedKey,
  SOURCE_LABEL,
  findLinked,
  fromEntry,
  loadLinked,
  loadLinkedKeys,
} from './cheque-flow.sources';

/** One row as a groupBy-shaped value for summarise() / buildTimeline(). */
const asGroup = (r: FlowRow) => ({
  direction: r.direction,
  status: r.status,
  chequeDate: r.chequeDate,
  _sum: { amount: r.amount },
  _count: { _all: 1 },
});

/** Every register write takes this lock, so two saves can't both pass the duplicate check. */
const WRITE_LOCK = 7_342_001;
/** A month holds a handful of cheques; this only guards the "All months" view. */
const MAX_LIST_ROWS = 5000;
const MAX_CHART_MONTHS = 36;
const SOON_DAYS = 7;

const SIDE_LABEL: Record<ChequeFlowDirection, string> = {
  RECEIVABLE: 'Customer',
  PAYABLE: 'Supplier',
};

export type DueState = 'overdue' | 'today' | 'soon' | null;

export interface ChequeFlowItem {
  id: string;
  source: ChequeFlowSource;
  /** The id in the source's own table (the entry id for MANUAL). */
  sourceId: string;
  sourceLabel: string;
  /** e.g. "Refund to customer", "Advance payment". */
  kindLabel: string | null;
  /** Page where a linked cheque is edited or deleted. */
  link: string | null;
  /** Statuses it may move to now, by its source's rules. */
  allowedStatuses: ChequeFlowStatus[];
  /** Manual row that is also recorded in Payments/Credits/Refunds — not counted. */
  duplicateOf: { source: ChequeFlowSource; id: string; label: string } | null;
  direction: ChequeFlowDirection;
  chequeNumber: string | null;
  bankName: string;
  chequeDate: string;
  partyName: string;
  invoiceRef: string | null;
  amount: number;
  status: ChequeFlowStatus;
  clearedDate: string | null;
  remarks: string | null;
  importBatchId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Only for PENDING cheques: past their date, due today, or due within 7 days. */
  dueState: DueState;
  /** Days past the cheque date (PENDING only), else 0. */
  daysOverdue: number;
}

/** The validated, normalised values of one cheque, ready to store. */
interface CleanEntry {
  direction: ChequeFlowDirection;
  chequeNumber: string | null;
  chequeKey: string;
  bankName: string;
  bankKey: string;
  chequeDate: Date;
  partyName: string;
  partyKey: string;
  invoiceRef: string | null;
  amount: Prisma.Decimal;
  status: ChequeFlowStatus;
  clearedDate: Date | null;
  remarks: string | null;
}

export interface ImportRowResult {
  index: number;
  sourceRow: number | null;
  result: 'ready' | 'duplicate' | 'error';
  errors: string[];
  warnings: string[];
  /** Where the duplicate already is. */
  duplicateOf?: 'register' | 'file' | 'linked';
  entry?: Omit<
    ChequeFlowItem,
    | 'id'
    | 'source'
    | 'sourceId'
    | 'sourceLabel'
    | 'kindLabel'
    | 'link'
    | 'allowedStatuses'
    | 'duplicateOf'
    | 'importBatchId'
    | 'createdAt'
    | 'updatedAt'
    | 'dueState'
    | 'daysOverdue'
  >;
}

const IMPORT_STATUS: Record<string, ChequeFlowStatus> = {
  '': 'PENDING',
  pending: 'PENDING',
  pend: 'PENDING',
  due: 'PENDING',
  pass: 'CLEARED',
  passed: 'CLEARED',
  clear: 'CLEARED',
  cleared: 'CLEARED',
  realised: 'CLEARED',
  realized: 'CLEARED',
  honoured: 'CLEARED',
  honored: 'CLEARED',
  paid: 'CLEARED',
  bounce: 'BOUNCED',
  bounced: 'BOUNCED',
  return: 'BOUNCED',
  returned: 'BOUNCED',
  dishonoured: 'BOUNCED',
  dishonored: 'BOUNCED',
  rd: 'BOUNCED',
  cancel: 'CANCELLED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  void: 'CANCELLED',
};

function money(value: Prisma.Decimal) {
  return value.toFixed(2);
}

@Injectable()
export class ChequeFlowService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /**
   * Every cheque with a date in `range`, from the register and from
   * Payments / Credits / Refunds, filtered and sorted by date. A manual row
   * that duplicates an ERP cheque is flagged (duplicateOf) and must be left
   * out of totals by the caller.
   */
  private async collect(
    range: DayRange,
    filters: ChequeFlowFiltersDto,
  ): Promise<FlowRow[]> {
    const db: Prisma.TransactionClient = this.prisma;
    const now = today();
    const wantManual = !filters.source || filters.source === 'MANUAL';
    const [entries, linked, keys] = await Promise.all([
      wantManual
        ? db.chequeFlowEntry.findMany({
            where: {
              deletedAt: null,
              ...((range.gte || range.lt) && { chequeDate: range }),
            },
          })
        : Promise.resolve<ChequeFlowEntry[]>([]),
      filters.source === 'MANUAL'
        ? Promise.resolve<FlowRow[]>([])
        : loadLinked(db, range, now),
      wantManual ? loadLinkedKeys(db) : Promise.resolve<LinkedKey[]>([]),
    ]);
    const manual = entries.map((entry) => {
      const row = fromEntry(entry);
      const twin = findLinked(keys, row);
      return twin
        ? { ...row, duplicateOf: { source: twin.source, id: twin.id } }
        : row;
    });
    return [...manual, ...linked]
      .filter((row) => this.matches(row, filters))
      .sort(
        (a, b) =>
          a.chequeDate.getTime() - b.chequeDate.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
  }

  /** Entries for a month (or all months) with their summary and, for a month, the date-wise timeline. */
  async list(query: QueryChequeFlowDto) {
    const rows = await this.collect(
      query.month ? monthRange(query.month) : {},
      query,
    );
    const counted = rows.filter((r) => !r.duplicateOf);
    const now = today();
    return {
      month: query.month ?? null,
      today: dayOf(now),
      filtered: this.isFiltered(query),
      truncated: rows.length > MAX_LIST_ROWS,
      duplicates: rows.length - counted.length,
      entries: rows.slice(0, MAX_LIST_ROWS).map((row) => this.toItem(row, now)),
      summary: summarise(counted.map(asGroup)),
      timeline: query.month
        ? buildTimeline(
            counted.filter((r) => r.status === 'PENDING').map(asGroup),
          )
        : [],
    };
  }

  /**
   * Pending cheques that are overdue, due today or due within 7 days — across
   * every month and every source, ignoring filters, so nothing late is hidden
   * by the month being looked at.
   */
  async alerts() {
    const now = today();
    const rows = await this.collect({ lt: addDays(now, SOON_DAYS + 1) }, {});
    const items = rows
      .filter((r) => r.status === 'PENDING' && !r.duplicateOf)
      .slice(0, 1000)
      .map((row) => this.toItem(row, now));
    const total = (state: DueState, direction: ChequeFlowDirection) =>
      items
        .filter((i) => i.dueState === state && i.direction === direction)
        .reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0))
        .toNumber();
    const group = (state: DueState) => ({
      entries: items.filter((i) => i.dueState === state),
      receivable: total(state, 'RECEIVABLE'),
      payable: total(state, 'PAYABLE'),
    });
    return {
      today: dayOf(now),
      overdue: group('overdue'),
      dueToday: group('today'),
      dueSoon: group('soon'),
    };
  }

  /** Receipts vs payments per month, for the chart. */
  async monthly(query: QueryChequeFlowMonthlyDto) {
    const current = monthOf(today());
    const shift = (month: string, by: number) => {
      const { gte } = monthRange(month);
      return monthOf(
        new Date(Date.UTC(gte.getUTCFullYear(), gte.getUTCMonth() + by, 1)),
      );
    };
    const from = query.from ?? shift(current, -5);
    const to = query.to ?? shift(current, 6);
    if (from > to) {
      throw new BadRequestException('"from" must not be after "to"');
    }
    const months = monthsBetween(from, to);
    if (months.length > MAX_CHART_MONTHS) {
      throw new BadRequestException(
        `Pick at most ${MAX_CHART_MONTHS} months for the chart`,
      );
    }
    const rows = await this.collect(
      { gte: monthRange(from).gte, lt: monthRange(to).lt },
      query,
    );
    const zero = () => new Prisma.Decimal(0);
    const byMonth = new Map(
      months.map((m) => [
        m,
        {
          receiptsPending: zero(),
          receiptsCleared: zero(),
          paymentsPending: zero(),
          paymentsCleared: zero(),
        },
      ]),
    );
    for (const row of rows) {
      if (row.duplicateOf) continue;
      if (row.status !== 'PENDING' && row.status !== 'CLEARED') continue;
      const bucket = byMonth.get(monthOf(row.chequeDate));
      if (!bucket) continue;
      const key =
        row.direction === 'RECEIVABLE'
          ? row.status === 'CLEARED'
            ? 'receiptsCleared'
            : 'receiptsPending'
          : row.status === 'CLEARED'
            ? 'paymentsCleared'
            : 'paymentsPending';
      bucket[key] = bucket[key].add(row.amount);
    }
    return {
      from,
      to,
      filtered: this.isFiltered(query),
      months: months.map((month) => {
        const b = byMonth.get(month)!;
        const receipts = b.receiptsPending.add(b.receiptsCleared);
        const payments = b.paymentsPending.add(b.paymentsCleared);
        return {
          month,
          receipts: receipts.toNumber(),
          receiptsPending: b.receiptsPending.toNumber(),
          receiptsCleared: b.receiptsCleared.toNumber(),
          payments: payments.toNumber(),
          paymentsPending: b.paymentsPending.toNumber(),
          paymentsCleared: b.paymentsCleared.toNumber(),
          net: receipts.sub(payments).toNumber(),
          netPending: b.receiptsPending.sub(b.paymentsPending).toNumber(),
        };
      }),
    };
  }

  /** Values for the filter and autocomplete lists, from every source. */
  async options() {
    const [rows, dealers, suppliers] = await Promise.all([
      this.collect({}, {}),
      this.prisma.dealer.findMany({
        select: { businessName: true },
        orderBy: { businessName: 'asc' },
        take: 2000,
      }),
      this.prisma.supplier.findMany({
        select: { name: true },
        orderBy: { name: 'asc' },
        take: 2000,
      }),
    ]);
    // One spelling per key — the one used most.
    const pick = (values: { key: string; name: string }[]) => {
      const counts = new Map<string, Map<string, number>>();
      for (const { key, name } of values) {
        if (!key) continue;
        const names = counts.get(key) ?? new Map<string, number>();
        names.set(name, (names.get(name) ?? 0) + 1);
        counts.set(key, names);
      }
      return [...counts.values()]
        .map((names) => [...names.entries()].sort((a, b) => b[1] - a[1])[0][0])
        .sort((a, b) => a.localeCompare(b));
    };
    const side = (direction: ChequeFlowDirection) =>
      pick(
        rows
          .filter((r) => r.direction === direction)
          .map((r) => ({ key: r.partyKey, name: r.partyName })),
      );
    const merge = (used: string[], known: string[]) => {
      const keys = new Set(used.map(nameKey));
      return [...used, ...known.filter((n) => !keys.has(nameKey(n)))];
    };
    const customers = side('RECEIVABLE');
    const payees = side('PAYABLE');
    return {
      banks: pick(rows.map((r) => ({ key: r.bankKey, name: r.bankName }))),
      customers,
      suppliers: payees,
      // For autocomplete only: names already used come first.
      customerSuggestions: merge(
        customers,
        dealers.map((d) => d.businessName),
      ),
      supplierSuggestions: merge(
        payees,
        suppliers.map((s) => s.name),
      ),
    };
  }

  async findOne(id: string) {
    const row = await this.prisma.chequeFlowEntry.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Cheque not found');
    return this.toItem(fromEntry(row), today());
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  async create(dto: CreateChequeFlowDto, adminId: string) {
    const clean = this.clean(dto, { requireClearedDate: true });
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      await this.assertNotDuplicate(tx, clean);
      const row = await tx.chequeFlowEntry.create({
        data: { ...clean, createdById: adminId },
      });
      await this.log(tx, adminId, 'CREATED_CHEQUE_FLOW', row, 'Added');
      return this.toItem(fromEntry(row), today());
    }, TRANSACTION_OPTIONS);
  }

  async update(id: string, dto: UpdateChequeFlowDto, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const existing = await this.findActive(tx, id);
      const status = dto.status ?? existing.status;
      const clean = this.clean(
        {
          direction: dto.direction ?? existing.direction,
          chequeNumber:
            dto.chequeNumber !== undefined
              ? dto.chequeNumber
              : (existing.chequeNumber ?? undefined),
          bankName: dto.bankName ?? existing.bankName,
          chequeDate: dto.chequeDate ?? dayOf(existing.chequeDate),
          partyName: dto.partyName ?? existing.partyName,
          invoiceRef:
            dto.invoiceRef !== undefined
              ? dto.invoiceRef
              : (existing.invoiceRef ?? undefined),
          amount: dto.amount ?? existing.amount.toNumber(),
          status,
          clearedDate:
            status !== 'CLEARED'
              ? undefined
              : dto.clearedDate !== undefined
                ? dto.clearedDate
                : existing.clearedDate
                  ? dayOf(existing.clearedDate)
                  : undefined,
          remarks:
            dto.remarks !== undefined
              ? dto.remarks
              : (existing.remarks ?? undefined),
        },
        // An imported cheque marked cleared without a date may stay that way;
        // newly clearing one needs the date.
        { requireClearedDate: existing.status !== 'CLEARED' },
      );
      await this.assertNotDuplicate(tx, clean, id);
      const row = await tx.chequeFlowEntry.update({
        where: { id },
        data: { ...clean, updatedById: adminId },
      });
      await this.log(tx, adminId, 'UPDATED_CHEQUE_FLOW', row, 'Edited');
      return this.toItem(fromEntry(row), today());
    }, TRANSACTION_OPTIONS);
  }

  /** Never automatic: a cheque is cleared only when someone says so. */
  async setStatus(id: string, dto: UpdateChequeFlowStatusDto, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const existing = await this.findActive(tx, id);
      let clearedDate: Date | null = null;
      if (dto.status === 'CLEARED') {
        if (!dto.clearedDate) {
          throw new BadRequestException(
            'Enter the date the bank cleared this cheque',
          );
        }
        clearedDate = this.checkClearedDate(
          dto.clearedDate,
          existing.chequeDate,
        );
      }
      const row = await tx.chequeFlowEntry.update({
        where: { id },
        data: { status: dto.status, clearedDate, updatedById: adminId },
      });
      await this.log(
        tx,
        adminId,
        'CHEQUE_FLOW_STATUS',
        row,
        `Status ${existing.status} → ${dto.status}`,
      );
      return this.toItem(fromEntry(row), today());
    }, TRANSACTION_OPTIONS);
  }

  /** Soft delete — restorable. */
  async remove(id: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const existing = await this.findActive(tx, id);
      await tx.chequeFlowEntry.update({
        where: { id },
        data: { deletedAt: new Date(), deletedById: adminId },
      });
      await this.log(tx, adminId, 'DELETED_CHEQUE_FLOW', existing, 'Deleted');
      return { id, message: 'Cheque deleted' };
    }, TRANSACTION_OPTIONS);
  }

  async restore(id: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const existing = await tx.chequeFlowEntry.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Cheque not found');
      if (!existing.deletedAt) {
        throw new BadRequestException('This cheque is not deleted');
      }
      await this.assertNotDuplicate(tx, existing, id);
      const row = await tx.chequeFlowEntry.update({
        where: { id },
        data: { deletedAt: null, deletedById: null, updatedById: adminId },
      });
      await this.log(tx, adminId, 'RESTORED_CHEQUE_FLOW', row, 'Restored');
      return this.toItem(fromEntry(row), today());
    }, TRANSACTION_OPTIONS);
  }

  // ---------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------

  /** Checks every row and reports it back. Writes nothing. */
  async previewImport(dto: PreviewChequeFlowImportDto) {
    const rows = await this.checkImportRows(
      this.prisma,
      dto.rows,
      !!dto.clearedOnChequeDate,
    );
    return { rows, ...this.importCounts(rows) };
  }

  /**
   * Saves the ready rows in one transaction; duplicates and invalid rows are
   * skipped, never overwritten. Resending the same importKey returns the
   * first result instead of importing again.
   */
  async commitImport(dto: CommitChequeFlowImportDto, adminId: string) {
    const replay = await this.prisma.chequeFlowImport.findUnique({
      where: { importKey: dto.importKey },
    });
    if (replay) {
      return {
        importId: replay.id,
        inserted: replay.inserted,
        skipped: replay.skipped,
        replayed: true,
      };
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lock(tx);
        // A simultaneous resend waited on the lock: answer with the first result.
        const first = await tx.chequeFlowImport.findUnique({
          where: { importKey: dto.importKey },
        });
        if (first) {
          return {
            importId: first.id,
            inserted: first.inserted,
            skipped: first.skipped,
            replayed: true,
          };
        }
        const checked = await this.checkImportRows(
          tx,
          dto.rows,
          !!dto.clearedOnChequeDate,
        );
        const ready = checked.filter((r) => r.result === 'ready');
        if (ready.length === 0) {
          throw new BadRequestException(
            'Nothing to import — every row is a duplicate or has an error',
          );
        }
        const batch = await tx.chequeFlowImport.create({
          data: {
            importKey: dto.importKey,
            fileName: cleanText(dto.fileName).slice(0, 200),
            adminId,
            mapping: (dto.mapping ?? {}) as Prisma.InputJsonValue,
            inserted: ready.length,
            skipped: checked.length - ready.length,
          },
        });
        await tx.chequeFlowEntry.createMany({
          data: ready.map((r) => {
            const e = r.entry!;
            return {
              direction: e.direction,
              chequeNumber: e.chequeNumber,
              chequeKey: chequeKeyOf(e.chequeNumber),
              bankName: e.bankName,
              bankKey: nameKey(e.bankName),
              chequeDate: new Date(`${e.chequeDate}T00:00:00.000Z`),
              partyName: e.partyName,
              partyKey: nameKey(e.partyName),
              invoiceRef: e.invoiceRef,
              amount: e.amount,
              status: e.status,
              clearedDate: e.clearedDate
                ? new Date(`${e.clearedDate}T00:00:00.000Z`)
                : null,
              remarks: e.remarks,
              importBatchId: batch.id,
              createdById: adminId,
            };
          }),
        });
        await this.activityLogService.log(tx, {
          adminId,
          action: 'IMPORTED_CHEQUE_FLOW',
          targetId: batch.id,
          details: `Imported ${ready.length} cheque(s) from "${batch.fileName}", skipped ${batch.skipped}`,
        });
        return {
          importId: batch.id,
          inserted: ready.length,
          skipped: batch.skipped,
          replayed: false,
        };
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      // Two identical submissions at once: the second hits the unique key.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const first = await this.prisma.chequeFlowImport.findUnique({
          where: { importKey: dto.importKey },
        });
        if (first) {
          return {
            importId: first.id,
            inserted: first.inserted,
            skipped: first.skipped,
            replayed: true,
          };
        }
      }
      throw error;
    }
  }

  listImports() {
    return this.prisma.chequeFlowImport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        fileName: true,
        inserted: true,
        skipped: true,
        undoneAt: true,
        createdAt: true,
      },
    });
  }

  /** Removes (soft-deletes) every cheque an import added that is still there. */
  async undoImport(id: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      const batch = await tx.chequeFlowImport.findUnique({ where: { id } });
      if (!batch) throw new NotFoundException('Import not found');
      if (batch.undoneAt) {
        throw new BadRequestException('This import was already undone');
      }
      const { count } = await tx.chequeFlowEntry.updateMany({
        where: { importBatchId: id, deletedAt: null },
        data: { deletedAt: new Date(), deletedById: adminId },
      });
      await tx.chequeFlowImport.update({
        where: { id },
        data: { undoneAt: new Date() },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'UNDID_CHEQUE_FLOW_IMPORT',
        targetId: id,
        details: `Undid import "${batch.fileName}" — removed ${count} cheque(s)`,
      });
      return { id, removed: count };
    }, TRANSACTION_OPTIONS);
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private async lock(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WRITE_LOCK})`;
  }

  private async findActive(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.chequeFlowEntry.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Cheque not found');
    return row;
  }

  /** The filters, applied the same way to every source. */
  private matches(row: FlowRow, filters: ChequeFlowFiltersDto): boolean {
    if (filters.source && row.source !== filters.source) return false;
    if (filters.status?.length && !filters.status.includes(row.status)) {
      return false;
    }
    if (filters.direction && row.direction !== filters.direction) return false;
    if (filters.bank?.trim() && row.bankKey !== nameKey(filters.bank)) {
      return false;
    }
    // Customer/supplier filters each narrow only their own side.
    const party =
      row.direction === 'RECEIVABLE' ? filters.customer : filters.supplier;
    if (party?.trim() && row.partyKey !== nameKey(party)) return false;
    const search = filters.search?.trim().toLowerCase();
    if (search) {
      const key = chequeKeyOf(search);
      const haystack = [
        row.chequeNumber,
        row.partyName,
        row.bankName,
        row.invoiceRef,
        row.remarks,
        row.kindLabel,
      ];
      const hit =
        haystack.some((v) => v?.toLowerCase().includes(search)) ||
        (!!key && row.chequeKey.includes(key));
      if (!hit) return false;
    }
    return true;
  }

  private isFiltered(filters: ChequeFlowFiltersDto) {
    return !!(
      filters.source ||
      filters.direction ||
      filters.status?.length ||
      filters.bank?.trim() ||
      filters.customer?.trim() ||
      filters.supplier?.trim() ||
      filters.search?.trim()
    );
  }

  /** Validates and normalises a cheque. Throws on the first problem. */
  private clean(
    dto: CreateChequeFlowDto,
    { requireClearedDate }: { requireClearedDate: boolean },
  ): CleanEntry {
    const bankName = cleanText(dto.bankName);
    const partyName = cleanText(dto.partyName);
    if (!bankName) throw new BadRequestException('Enter the bank');
    if (!partyName) {
      throw new BadRequestException(
        `Enter the ${SIDE_LABEL[dto.direction].toLowerCase()} name`,
      );
    }
    const chequeDate = toDateOnly(dto.chequeDate, 'Cheque date');
    const status = dto.status ?? 'PENDING';
    let clearedDate: Date | null = null;
    if (status === 'CLEARED') {
      if (dto.clearedDate) {
        clearedDate = this.checkClearedDate(dto.clearedDate, chequeDate);
      } else if (requireClearedDate) {
        throw new BadRequestException(
          'Enter the date the bank cleared this cheque',
        );
      }
    }
    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lte(0) || amount.gt(MAX_MONEY_AMOUNT)) {
      throw new BadRequestException('Enter an amount above 0');
    }
    const chequeNumber = displayChequeNumber(dto.chequeNumber);
    return {
      direction: dto.direction,
      chequeNumber,
      chequeKey: chequeKeyOf(chequeNumber),
      bankName,
      bankKey: nameKey(bankName),
      chequeDate,
      partyName,
      partyKey: nameKey(partyName),
      invoiceRef: cleanText(dto.invoiceRef) || null,
      amount: amount.toDecimalPlaces(2),
      status,
      clearedDate,
      remarks: cleanText(dto.remarks) || null,
    };
  }

  private checkClearedDate(input: string, chequeDate: Date): Date {
    const cleared = toDateOnly(input, 'Cleared date');
    if (cleared > today()) {
      throw new BadRequestException('The cleared date cannot be in the future');
    }
    if (cleared < chequeDate) {
      throw new BadRequestException(
        `The cleared date can't be before the cheque date (${dayOf(chequeDate)})`,
      );
    }
    return cleared;
  }

  /** Same cheque already in the register (not deleted)? */
  private async assertNotDuplicate(
    tx: Prisma.TransactionClient | PrismaService,
    e: Pick<
      CleanEntry,
      | 'direction'
      | 'chequeKey'
      | 'bankKey'
      | 'partyKey'
      | 'chequeDate'
      | 'amount'
    >,
    exceptId?: string,
  ) {
    const existing = await tx.chequeFlowEntry.findFirst({
      where: {
        deletedAt: null,
        direction: e.direction,
        ...(exceptId && { id: { not: exceptId } }),
        ...(e.chequeKey
          ? { bankKey: e.bankKey, chequeKey: e.chequeKey }
          : {
              chequeKey: '',
              partyKey: e.partyKey,
              chequeDate: e.chequeDate,
              amount: e.amount,
            }),
      },
    });
    const twin = findLinked(await loadLinkedKeys(tx), e);
    if (twin) {
      throw new ConflictException(
        `Cheque ${twin.chequeKey} is already recorded in ${SOURCE_LABEL[twin.source]} (${twin.partyName}, dated ${dayOf(twin.chequeDate)}) — it shows here automatically, no need to add it again`,
      );
    }
    if (existing) {
      throw new ConflictException(
        e.chequeKey
          ? `Cheque ${existing.chequeNumber} (${existing.bankName}) is already in the register, dated ${dayOf(existing.chequeDate)}`
          : `A ${SIDE_LABEL[e.direction].toLowerCase()} cheque for ${existing.partyName} of ${money(existing.amount)} on ${dayOf(existing.chequeDate)} is already in the register`,
      );
    }
  }

  private dupKey(
    e: Pick<
      CleanEntry,
      'direction' | 'chequeKey' | 'bankKey' | 'partyKey' | 'chequeDate'
    > & { amount: Prisma.Decimal | number },
  ) {
    return e.chequeKey
      ? `C|${e.direction}|${e.bankKey}|${e.chequeKey}`
      : `P|${e.direction}|${e.partyKey}|${dayOf(e.chequeDate)}|${new Prisma.Decimal(e.amount).toFixed(2)}`;
  }

  private async checkImportRows(
    client: Prisma.TransactionClient | PrismaService,
    rows: ChequeFlowImportRowDto[],
    clearedOnChequeDate: boolean,
  ): Promise<ImportRowResult[]> {
    const existing = await client.chequeFlowEntry.findMany({
      where: { deletedAt: null },
      select: {
        direction: true,
        chequeKey: true,
        bankKey: true,
        partyKey: true,
        chequeDate: true,
        amount: true,
      },
    });
    const inRegister = new Set(existing.map((e) => this.dupKey(e)));
    const linked = await loadLinkedKeys(client);
    const inFile = new Set<string>();
    return rows.map((raw, index) => {
      const res: ImportRowResult = {
        index,
        sourceRow: raw.sourceRow ?? null,
        result: 'error',
        errors: [],
        warnings: [],
      };
      const clean = this.cleanImportRow(raw, res, clearedOnChequeDate);
      if (!clean) return res;
      res.entry = {
        direction: clean.direction,
        chequeNumber: clean.chequeNumber,
        bankName: clean.bankName,
        chequeDate: dayOf(clean.chequeDate),
        partyName: clean.partyName,
        invoiceRef: clean.invoiceRef,
        amount: clean.amount.toNumber(),
        status: clean.status,
        clearedDate: clean.clearedDate ? dayOf(clean.clearedDate) : null,
        remarks: clean.remarks,
      };
      const key = this.dupKey(clean);
      const twin = findLinked(linked, clean);
      if (twin) {
        res.result = 'duplicate';
        res.duplicateOf = 'linked';
        res.warnings.push(
          `Already recorded in ${SOURCE_LABEL[twin.source]} — it shows automatically`,
        );
      } else if (inRegister.has(key)) {
        res.result = 'duplicate';
        res.duplicateOf = 'register';
      } else if (inFile.has(key)) {
        res.result = 'duplicate';
        res.duplicateOf = 'file';
      } else {
        inFile.add(key);
        res.result = 'ready';
      }
      return res;
    });
  }

  /** One row's checks; collects every problem instead of stopping at the first. */
  private cleanImportRow(
    raw: ChequeFlowImportRowDto,
    res: ImportRowResult,
    clearedOnChequeDate: boolean,
  ): CleanEntry | null {
    const text = (v: unknown, max: number, label: string) => {
      const value = cleanText(
        typeof v === 'number' || typeof v === 'string' ? v : '',
      );
      if (value.length > max) {
        res.errors.push(`${label} is longer than ${max} characters`);
      }
      return value;
    };
    const direction =
      raw.direction === 'RECEIVABLE' || raw.direction === 'PAYABLE'
        ? raw.direction
        : null;
    if (!direction) res.errors.push('Unknown side (customer or supplier)');

    const chequeNumber = displayChequeNumber(
      text(raw.chequeNumber, 40, 'Cheque number'),
    );
    if (!chequeNumber) res.warnings.push('No cheque number');
    else if (
      /^\d{1,5}$/.test(chequeNumber) &&
      typeof raw.chequeNumber === 'number'
    ) {
      res.warnings.push(
        'Cheque number is short — Excel may have dropped leading zeros',
      );
    }
    const bankName = text(raw.bankName, 80, 'Bank');
    if (!bankName) res.errors.push('Bank is missing');
    const partyName = text(raw.partyName, 120, 'Name');
    if (!partyName) res.errors.push('Customer/supplier name is missing');
    const invoiceRef = text(raw.invoiceRef, 120, 'Invoice reference') || null;
    const remarks = text(raw.remarks, 500, 'Remarks') || null;

    let chequeDate: Date | null = null;
    const dateText = text(raw.chequeDate, 40, 'Cheque date');
    if (!dateText) res.errors.push('Cheque date is missing');
    else {
      try {
        chequeDate = toDateOnly(dateText, 'Cheque date');
      } catch (e) {
        res.errors.push((e as Error).message);
      }
    }

    let amount: Prisma.Decimal | null = null;
    const amountText =
      typeof raw.amount === 'number'
        ? String(raw.amount)
        : typeof raw.amount === 'string'
          ? raw.amount.replace(/[^0-9.-]/g, '')
          : '';
    if (!amountText || Number.isNaN(Number(amountText))) {
      res.errors.push('Amount is missing or not a number');
    } else {
      const value = new Prisma.Decimal(amountText);
      if (value.lte(0)) res.errors.push('Amount must be above 0');
      else if (value.gt(MAX_MONEY_AMOUNT))
        res.errors.push('Amount is too large');
      else {
        amount = value.toDecimalPlaces(2);
        if (!amount.eq(value))
          res.warnings.push(`Amount rounded to ${money(amount)}`);
      }
    }

    const statusText = text(raw.status, 40, 'Status').toLowerCase();
    const status = IMPORT_STATUS[statusText];
    if (!status) res.errors.push(`Unknown status "${statusText}"`);

    let clearedDate: Date | null = null;
    const clearedText = text(raw.clearedDate, 40, 'Cleared date');
    if (status === 'CLEARED' && chequeDate) {
      if (clearedText) {
        try {
          clearedDate = this.checkClearedDate(clearedText, chequeDate);
        } catch (e) {
          res.errors.push((e as Error).message);
        }
      } else if (clearedOnChequeDate && chequeDate <= today()) {
        clearedDate = chequeDate;
      } else {
        res.warnings.push('Cleared — no cleared date recorded');
      }
    } else if (clearedText && status && status !== 'CLEARED') {
      res.warnings.push('Cleared date ignored — the cheque is not cleared');
    }

    if (res.errors.length || !direction || !chequeDate || !amount || !status) {
      return null;
    }
    return {
      direction,
      chequeNumber,
      chequeKey: chequeKeyOf(chequeNumber),
      bankName,
      bankKey: nameKey(bankName),
      chequeDate,
      partyName,
      partyKey: nameKey(partyName),
      invoiceRef,
      amount,
      status,
      clearedDate,
      remarks,
    };
  }

  private importCounts(rows: ImportRowResult[]) {
    return {
      ready: rows.filter((r) => r.result === 'ready').length,
      duplicates: rows.filter((r) => r.result === 'duplicate').length,
      errors: rows.filter((r) => r.result === 'error').length,
    };
  }

  private toItem(row: FlowRow, now: Date): ChequeFlowItem {
    let dueState: DueState = null;
    let daysOverdue = 0;
    if (row.status === 'PENDING') {
      const diff = Math.round(
        (row.chequeDate.getTime() - now.getTime()) / 86_400_000,
      );
      if (diff < 0) {
        dueState = 'overdue';
        daysOverdue = -diff;
      } else if (diff === 0) dueState = 'today';
      else if (diff <= SOON_DAYS) dueState = 'soon';
    }
    return {
      id: row.id,
      source: row.source,
      sourceId: row.sourceId,
      sourceLabel: SOURCE_LABEL[row.source],
      kindLabel: row.kindLabel,
      link: row.link,
      allowedStatuses: row.allowedStatuses,
      duplicateOf: row.duplicateOf
        ? { ...row.duplicateOf, label: SOURCE_LABEL[row.duplicateOf.source] }
        : null,
      direction: row.direction,
      chequeNumber: row.chequeNumber,
      bankName: row.bankName,
      chequeDate: dayOf(row.chequeDate),
      partyName: row.partyName,
      invoiceRef: row.invoiceRef,
      amount: row.amount.toNumber(),
      status: row.status,
      clearedDate: row.clearedDate ? dayOf(row.clearedDate) : null,
      remarks: row.remarks,
      importBatchId: row.importBatchId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // Only PENDING cheques counted in totals get due alerts.
      dueState: row.duplicateOf ? null : dueState,
      daysOverdue: row.duplicateOf ? 0 : daysOverdue,
    };
  }

  private async log(
    tx: Prisma.TransactionClient,
    adminId: string,
    action: string,
    row: ChequeFlowEntry,
    verb: string,
  ) {
    await this.activityLogService.log(tx, {
      adminId,
      action,
      targetId: row.id,
      details: `${verb} ${SIDE_LABEL[row.direction].toLowerCase()} cheque ${row.chequeNumber ?? '(no number)'} — ${row.partyName}, ${row.bankName}, ${money(row.amount)} dated ${dayOf(row.chequeDate)}`,
    });
  }
}
