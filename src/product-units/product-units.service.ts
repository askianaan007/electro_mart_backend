import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  Prisma,
  ProductUnitCondition,
  ProductUnitEventType,
  ProductUnitSource,
  ProductUnitStatus,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { paginate } from '../common/utils/paginate';
import {
  checkSerialFormat,
  normalizeSerial,
  normalizeSerialList,
  serialProblemText,
} from '../common/utils/serial';
import { SerialLifecycleService } from './serial-lifecycle.service';
import {
  AssignOrderUnitsDto,
  QueryUnitsDto,
  RegisterUnitsDto,
  SetConditionDto,
  SupplierReplacementDto,
  UpdateUnitDto,
  ValidateSerialsDto,
  WarrantySwapDto,
} from './dto/product-units.dto';

type Tx = Prisma.TransactionClient;

export type SerialVerdictCode =
  | 'OK'
  | 'NEW_WILL_REGISTER'
  | 'INVALID_FORMAT'
  | 'DUPLICATE_IN_REQUEST'
  | 'ALREADY_EXISTS'
  | 'IS_MODEL_BARCODE'
  | 'NOT_REGISTERED'
  | 'ALREADY_ON_ORDER'
  | 'NOT_IN_STOCK'
  | 'DEFECTIVE'
  | 'NOT_ON_THIS_ORDER'
  | 'OTHER_PURCHASE';

export interface SerialVerdict {
  input: string;
  serialNumber: string | null;
  code: SerialVerdictCode;
  ok: boolean;
  message: string;
  unitId?: string;
}

const STATUS_WORDS: Record<ProductUnitStatus, string> = {
  IN_STOCK: 'in stock',
  ALLOCATED: 'allocated to an order',
  SOLD: 'sold',
  RETURNED_TO_SUPPLIER: 'returned to supplier',
  WRITTEN_OFF: 'written off',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fmtDate(date: Date | string | null | undefined) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Colombo',
  });
}

@Injectable()
export class ProductUnitsService {
  constructor(
    private prisma: PrismaService,
    private lifecycle: SerialLifecycleService,
    private activityLogService: ActivityLogService,
  ) {}

  // ---------------------------------------------------------------------
  // Idempotency (Bar_code_plan.md §9 / D8)
  // ---------------------------------------------------------------------

  private async idempotent<T>(
    key: string,
    adminId: string,
    operation: string,
    body: unknown,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ operation, body }))
      .digest('hex');

    const replay = async () => {
      const existing = await this.prisma.serialRequest.findUnique({
        where: { idempotencyKey: key },
      });
      if (!existing) return null;
      if (
        existing.adminId !== adminId ||
        existing.requestHash !== requestHash
      ) {
        throw new ConflictException(
          'This request key was already used for a different request — reopen the dialog and try again',
        );
      }
      return existing.response as T;
    };

    const previous = await replay();
    if (previous !== null) return previous;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const result = toJson(await work(tx));
        await tx.serialRequest.create({
          data: {
            idempotencyKey: key,
            adminId,
            operation,
            requestHash,
            response: result as Prisma.InputJsonValue,
          },
        });
        return result;
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const target = JSON.stringify(error.meta?.target ?? '');
        if (target.includes('idempotencyKey')) {
          const raced = await replay();
          if (raced !== null) return raced;
        }
        throw new ConflictException(
          'One of these serials was registered by someone else a moment ago — reload and try again',
        );
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Validation (no writes) — powers the live scan dialog
  // ---------------------------------------------------------------------

  async validate(dto: ValidateSerialsDto): Promise<SerialVerdict[]> {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      select: { id: true, name: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    const seen = new Set<string>();
    const parsed = dto.serials.map((input) => {
      const result = checkSerialFormat(input);
      if (!result.ok) {
        return {
          input,
          error: `Serial ${serialProblemText(result.problem)}`,
        } as const;
      }
      const duplicate = seen.has(result.value.serialKey);
      seen.add(result.value.serialKey);
      return { input, value: result.value, duplicate } as const;
    });
    const keys = parsed.flatMap((p) =>
      'value' in p && p.value ? [p.value.serialKey] : [],
    );

    const [units, clashes] = await Promise.all([
      this.prisma.productUnit.findMany({
        where: { serialKey: { in: keys } },
        include: {
          product: { select: { id: true, name: true } },
          order: { select: { id: true, orderNumber: true } },
        },
      }),
      this.lifecycle.findModelBarcodeClashes(this.prisma, keys),
    ]);

    return parsed.map((p): SerialVerdict => {
      if ('error' in p) {
        return {
          input: p.input,
          serialNumber: null,
          code: 'INVALID_FORMAT',
          ok: false,
          message: p.error ?? 'Invalid',
        };
      }
      const { value } = p;
      const base = { input: p.input, serialNumber: value.serialNumber };
      if (p.duplicate) {
        return {
          ...base,
          code: 'DUPLICATE_IN_REQUEST',
          ok: false,
          message: 'Scanned twice',
        };
      }
      const clash = clashes.get(value.serialKey);
      if (clash) {
        return {
          ...base,
          code: 'IS_MODEL_BARCODE',
          ok: false,
          message: `That's the model barcode of "${clash.name}" — scan the serial number label instead`,
        };
      }
      const own = units.find(
        (u) => u.serialKey === value.serialKey && u.productId === product.id,
      );
      const other = units.find(
        (u) => u.serialKey === value.serialKey && u.productId !== product.id,
      );

      switch (dto.context) {
        case 'RECEIVE':
          if (own) {
            return {
              ...base,
              code: 'ALREADY_EXISTS',
              ok: false,
              unitId: own.id,
              message: `Already registered (${STATUS_WORDS[own.status]})`,
            };
          }
          return {
            ...base,
            code: 'OK',
            ok: true,
            message: other
              ? `New — note: also used by "${other.product.name}"`
              : 'New',
          };
        case 'ASSIGN':
          if (!own) {
            return {
              ...base,
              code: 'NEW_WILL_REGISTER',
              ok: true,
              message:
                'Not registered yet — will be registered as existing stock',
            };
          }
          if (own.orderId === dto.orderId) {
            return {
              ...base,
              code: 'OK',
              ok: true,
              unitId: own.id,
              message: 'Already on this order',
            };
          }
          if (own.order) {
            return {
              ...base,
              code: 'ALREADY_ON_ORDER',
              ok: false,
              unitId: own.id,
              message: `Already on order ${own.order.orderNumber}`,
            };
          }
          if (own.status !== ProductUnitStatus.IN_STOCK) {
            return {
              ...base,
              code: 'NOT_IN_STOCK',
              ok: false,
              unitId: own.id,
              message: `Not in stock — ${STATUS_WORDS[own.status]}`,
            };
          }
          if (own.condition === ProductUnitCondition.DEFECTIVE) {
            return {
              ...base,
              code: 'DEFECTIVE',
              ok: false,
              unitId: own.id,
              message: 'Marked defective — not sellable',
            };
          }
          return {
            ...base,
            code: 'OK',
            ok: true,
            unitId: own.id,
            message: 'In stock',
          };
        case 'SALES_RETURN':
          if (!own)
            return {
              ...base,
              code: 'NOT_REGISTERED',
              ok: false,
              message: 'Not registered',
            };
          if (
            own.orderId !== dto.orderId ||
            own.status !== ProductUnitStatus.SOLD
          ) {
            return {
              ...base,
              code: 'NOT_ON_THIS_ORDER',
              ok: false,
              unitId: own.id,
              message: 'Not a sold unit on this order',
            };
          }
          return {
            ...base,
            code: 'OK',
            ok: true,
            unitId: own.id,
            message: 'Sold on this order',
          };
        case 'PURCHASE_RETURN':
        case 'WRITE_OFF':
          if (!own)
            return {
              ...base,
              code: 'NOT_REGISTERED',
              ok: false,
              message: 'Not registered',
            };
          if (own.status !== ProductUnitStatus.IN_STOCK) {
            return {
              ...base,
              code: 'NOT_IN_STOCK',
              ok: false,
              unitId: own.id,
              message: `Not in stock — ${STATUS_WORDS[own.status]}`,
            };
          }
          if (
            dto.context === 'PURCHASE_RETURN' &&
            dto.purchaseId &&
            own.purchaseId &&
            own.purchaseId !== dto.purchaseId
          ) {
            return {
              ...base,
              code: 'OTHER_PURCHASE',
              ok: false,
              unitId: own.id,
              message: 'Came from a different purchase',
            };
          }
          return {
            ...base,
            code: 'OK',
            ok: true,
            unitId: own.id,
            message:
              own.condition === ProductUnitCondition.DEFECTIVE
                ? 'In stock · defective'
                : 'In stock',
          };
      }
    });
  }

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  async register(dto: RegisterUnitsDto, adminId: string) {
    const serials = normalizeSerialList(dto.serials);
    const { idempotencyKey, ...body } = dto;
    return this.idempotent(
      idempotencyKey,
      adminId,
      'REGISTER',
      body,
      async (tx) => {
        const product = await tx.product.findUnique({
          where: { id: dto.productId },
          select: { name: true },
        });
        if (!product) throw new NotFoundException('Product not found');

        let count: number;
        let where: string;
        if (dto.purchaseId) {
          const purchase = await tx.purchase.findUnique({
            where: { id: dto.purchaseId },
            include: { items: true, supplier: { select: { name: true } } },
          });
          if (!purchase) throw new NotFoundException('Purchase not found');
          if (purchase.cancelledAt) {
            throw new BadRequestException(
              'This purchase is cancelled — its goods went back to the supplier',
            );
          }
          const qty = new Map<string, number>();
          const cost = new Map<string, Prisma.Decimal>();
          for (const item of purchase.items) {
            qty.set(
              item.productId,
              (qty.get(item.productId) ?? 0) + item.quantity,
            );
            cost.set(item.productId, item.unitCost);
          }
          // Units already returned to the supplier from this purchase don't count as held.
          const returned = await tx.purchaseReturnItem.aggregate({
            where: {
              productId: dto.productId,
              purchaseReturn: { purchaseId: purchase.id },
            },
            _sum: { quantity: true },
          });
          const returnedSerials = await tx.productUnit.count({
            where: {
              purchaseId: purchase.id,
              productId: dto.productId,
              status: ProductUnitStatus.RETURNED_TO_SUPPLIER,
            },
          });
          const unserializedReturns =
            (returned._sum.quantity ?? 0) - returnedSerials;
          if (qty.has(dto.productId)) {
            qty.set(
              dto.productId,
              (qty.get(dto.productId) ?? 0) - Math.max(0, unserializedReturns),
            );
          }
          count = await this.lifecycle.registerForPurchase(
            tx,
            purchase,
            [{ productId: dto.productId, serials }],
            qty,
            cost,
            adminId,
          );
          where = `purchase ${purchase.invoiceNumber}`;
        } else {
          const units = await this.lifecycle.registerUnits(tx, {
            productId: dto.productId,
            serials,
            source: ProductUnitSource.OPENING_STOCK,
            receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : new Date(),
            adminId,
            reason: dto.notes ?? 'Registered from existing stock',
          });
          count = units.length;
          where = 'existing stock';
        }

        await this.activityLogService.log(tx, {
          adminId,
          action: 'REGISTERED_SERIALS',
          targetId: dto.productId,
          details: `Registered ${count} serial(s) of ${product.name} against ${where}: ${serials.map((s) => s.serialNumber).join(', ')}`,
        });
        return { registered: count };
      },
    );
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async findAll(query: QueryUnitsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const searchKey = query.search?.replace(/\s+/g, '').toUpperCase();
    const where: Prisma.ProductUnitWhereInput = {
      ...(query.productId && { productId: query.productId }),
      ...(query.status && { status: query.status }),
      ...(query.condition && { condition: query.condition }),
      ...(query.purchaseId && { purchaseId: query.purchaseId }),
      ...(query.orderId && { orderId: query.orderId }),
      ...(searchKey && {
        OR: [
          { serialKey: { contains: searchKey } },
          {
            product: { name: { contains: query.search, mode: 'insensitive' } },
          },
        ],
      }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.productUnit.findMany({
        where,
        include: {
          product: {
            select: {
              id: true,
              name: true,
              brand: true,
              model: true,
              productCode: true,
            },
          },
          order: {
            select: {
              id: true,
              orderNumber: true,
              dealer: { select: { businessName: true } },
            },
          },
          purchase: { select: { id: true, invoiceNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.productUnit.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  /** What a scan of `code` resolves to (Scan screen). */
  async scan(code: string) {
    const format = checkSerialFormat(code);
    if (!format.ok) return { kind: 'NONE' as const, code };
    const key = format.value.serialKey;
    const units = await this.prisma.productUnit.findMany({
      where: { serialKey: key },
      include: {
        product: { select: { id: true, name: true, brand: true, model: true } },
      },
    });
    if (units.length > 0) {
      const enriched = await Promise.all(
        units.map(async (unit) => ({
          id: unit.id,
          serialNumber: unit.serialNumber,
          status: unit.status,
          condition: unit.condition,
          product: unit.product,
          statusSummary: (await this.findOne(unit.id)).statusSummary,
        })),
      );
      return { kind: 'UNIT' as const, code, units: enriched };
    }
    const clashes = await this.lifecycle.findModelBarcodeClashes(this.prisma, [
      key,
    ]);
    const clash = clashes.get(key);
    if (clash) {
      const product = await this.prisma.product.findUnique({
        where: { id: clash.id },
        select: {
          id: true,
          name: true,
          brand: true,
          model: true,
          productCode: true,
          barcode: true,
          currentStock: true,
          trackSerials: true,
        },
      });
      return { kind: 'PRODUCT' as const, code, product };
    }
    return { kind: 'NONE' as const, code };
  }

  /** Full unit detail, shaped for the unit page (Bar_code_plan.md §7.5). */
  async findOne(id: string) {
    const unit = await this.prisma.productUnit.findUnique({
      where: { id },
      include: {
        product: { include: { images: { orderBy: { sortOrder: 'asc' } } } },
        purchase: { include: { supplier: true } },
        replacement: {
          select: { id: true, replacementNumber: true, receivedDate: true },
        },
        order: {
          include: {
            dealer: {
              omit: {
                password: true,
                resetToken: true,
                resetTokenExpiry: true,
              },
            },
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                paymentStatus: true,
                dueDate: true,
                createdAt: true,
              },
            },
            createdByRep: { select: { id: true, name: true, phone: true } },
            items: true,
          },
        },
        purchaseReturn: {
          include: {
            supplier: true,
            purchase: {
              select: { id: true, invoiceNumber: true, cancelReason: true },
            },
          },
        },
        replacesUnit: {
          select: { id: true, serialNumber: true, status: true },
        },
        replacedBy: {
          select: {
            id: true,
            serialNumber: true,
            status: true,
            receivedAt: true,
            source: true,
          },
        },
        events: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      },
    });
    if (!unit) throw new NotFoundException('Serial unit not found');

    const adminIds = [
      ...new Set([unit.createdByAdminId, ...unit.events.map((e) => e.adminId)]),
    ];
    const admins = await this.prisma.admin.findMany({
      where: { id: { in: adminIds } },
      select: { id: true, name: true },
    });
    const adminName = new Map(admins.map((a) => [a.id, a.name]));
    const events = unit.events.map((e) => ({
      ...e,
      adminName: adminName.get(e.adminId) ?? 'Unknown admin',
    }));
    const chronological = [...events].reverse();

    const orderLine =
      unit.order?.items.find((i) => i.productId === unit.productId) ?? null;

    // Customer returns
    const salesReturnIds = events
      .filter((e) => e.type === ProductUnitEventType.RETURNED_BY_DEALER)
      .map((e) => e.documentId!);
    const salesReturns = await this.prisma.salesReturn.findMany({
      where: { id: { in: salesReturnIds } },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            invoice: { select: { id: true, invoiceNumber: true } },
          },
        },
        dealer: { select: { id: true, businessName: true } },
      },
    });
    const nextAfter = (eventId: string) => {
      const index = chronological.findIndex((e) => e.id === eventId);
      return index >= 0 ? (chronological[index + 1] ?? null) : null;
    };
    const customerReturns = events
      .filter((e) => e.type === ProductUnitEventType.RETURNED_BY_DEALER)
      .map((event) => {
        const doc = salesReturns.find((r) => r.id === event.documentId) ?? null;
        const reversed = events.some(
          (e) =>
            e.type === ProductUnitEventType.DEALER_RETURN_REVERSED &&
            e.documentId === event.documentId &&
            e.createdAt > event.createdAt,
        );
        const next = nextAfter(event.id);
        return {
          eventId: event.id,
          salesReturnId: event.documentId,
          documentRef: event.documentRef,
          documentDeleted: !doc,
          returnNumber:
            doc?.returnNumber ?? event.documentRef?.split(' / ')[0] ?? null,
          returnDate: doc?.returnDate ?? event.eventDate,
          order: doc?.order ?? null,
          dealer: doc?.dealer ?? { id: null, businessName: event.partyName },
          reasonAtTime: event.reason,
          reasonNow: doc?.reason ?? null,
          reasonEdited: !!doc && doc.reason !== event.reason,
          faultNote: event.faultNote,
          condition: event.conditionAfter,
          creditedAmount: event.amount,
          recordedBy: event.adminName,
          recordedAt: event.createdAt,
          reversed,
          next: next
            ? {
                type: next.type,
                documentRef: next.documentRef,
                eventDate: next.eventDate,
                documentId: next.documentId,
              }
            : null,
        };
      });

    // Returns to supplier
    const purchaseReturnIds = events
      .filter((e) => e.type === ProductUnitEventType.RETURNED_TO_SUPPLIER)
      .map((e) => e.documentId!);
    const purchaseReturns = await this.prisma.purchaseReturn.findMany({
      where: { id: { in: purchaseReturnIds } },
      include: {
        supplier: { select: { id: true, name: true, phone: true } },
        purchase: {
          select: { id: true, invoiceNumber: true, cancelReason: true },
        },
      },
    });
    const supplierReturns = events
      .filter((e) => e.type === ProductUnitEventType.RETURNED_TO_SUPPLIER)
      .map((event) => {
        const doc =
          purchaseReturns.find((r) => r.id === event.documentId) ?? null;
        const reversed = events.some(
          (e) =>
            e.type === ProductUnitEventType.SUPPLIER_RETURN_REVERSED &&
            e.documentId === event.documentId &&
            e.createdAt > event.createdAt,
        );
        const isCurrent = unit.purchaseReturnId === event.documentId;
        return {
          eventId: event.id,
          purchaseReturnId: event.documentId,
          documentDeleted: !doc,
          returnNumber: doc?.returnNumber ?? event.documentRef,
          returnDate: doc?.returnDate ?? event.eventDate,
          supplier: doc?.supplier ?? {
            id: null,
            name: event.partyName,
            phone: null,
          },
          purchase: doc?.purchase ?? null,
          isCancellation: doc?.isCancellation ?? false,
          reasonAtTime: event.reason,
          reasonNow: doc?.reason ?? null,
          reasonEdited: !!doc && doc.reason !== event.reason,
          condition: event.conditionAfter,
          unitCost: event.amount,
          recordedBy: event.adminName,
          recordedAt: event.createdAt,
          reversed,
          replacement:
            isCurrent && unit.replacedBy
              ? { state: 'RECEIVED' as const, unit: unit.replacedBy }
              : isCurrent
                ? {
                    state: 'AWAITING' as const,
                    days: Math.floor(
                      (Date.now() -
                        new Date(
                          doc?.returnDate ?? event.eventDate,
                        ).getTime()) /
                        DAY_MS,
                    ),
                  }
                : null,
        };
      });

    const swaps = events
      .filter(
        (e) =>
          e.type === ProductUnitEventType.WARRANTY_SWAP_OUT ||
          e.type === ProductUnitEventType.WARRANTY_SWAP_IN,
      )
      .map((e) => ({
        type: e.type,
        eventDate: e.eventDate,
        reason: e.reason,
        faultNote: e.faultNote,
        documentRef: e.documentRef,
        partyName: e.partyName,
        details: e.details,
        recordedBy: e.adminName,
      }));

    const writeOffEvent =
      unit.status === ProductUnitStatus.WRITTEN_OFF
        ? (events.find((e) => e.type === ProductUnitEventType.WRITTEN_OFF) ??
          null)
        : null;

    const previousSales = events
      .filter(
        (e) =>
          e.type === ProductUnitEventType.ASSIGNED_TO_ORDER &&
          e.documentId !== unit.orderId,
      )
      .map((e) => ({
        orderId: e.documentId,
        documentRef: e.documentRef,
        partyName: e.partyName,
        eventDate: e.eventDate,
        amount: e.amount,
      }));

    const now = new Date();
    const warranty = {
      startsAt: unit.warrantyStartsAt,
      expiresAt: unit.warrantyExpiresAt,
      months: unit.product.warrantyMonths,
      text: unit.product.warranty,
      manual: unit.warrantyManual,
      state: !unit.warrantyExpiresAt
        ? ('NOT_SET' as const)
        : unit.warrantyExpiresAt >= now
          ? ('VALID' as const)
          : ('EXPIRED' as const),
      daysLeft: unit.warrantyExpiresAt
        ? Math.ceil((unit.warrantyExpiresAt.getTime() - now.getTime()) / DAY_MS)
        : null,
    };

    const statusSummary = this.statusSummary({
      unit,
      warranty,
      latestReturn: customerReturns.find((r) => !r.reversed) ?? null,
      currentSupplierReturn:
        supplierReturns.find(
          (r) => r.purchaseReturnId === unit.purchaseReturnId,
        ) ?? null,
      latestSwapIn:
        events.find((e) => e.type === ProductUnitEventType.WARRANTY_SWAP_IN) ??
        null,
      writeOffEvent,
      latestDefect:
        events.find((e) => e.type === ProductUnitEventType.MARKED_DEFECTIVE) ??
        null,
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { events: _events, order, ...rest } = unit;
    return {
      unit: {
        ...rest,
        createdByAdminName: adminName.get(unit.createdByAdminId) ?? null,
      },
      statusSummary,
      warranty,
      currentSale: order
        ? {
            order: {
              id: order.id,
              orderNumber: order.orderNumber,
              status: order.status,
              approvedAt: order.approvedAt,
              deliveredAt: order.deliveredAt,
              completedAt: order.completedAt,
            },
            invoice: order.invoice,
            dealer: order.dealer,
            rep: order.createdByRep,
            unitPrice: orderLine?.unitPrice ?? null,
            netUnitPrice: orderLine?.netUnitPrice ?? null,
          }
        : null,
      customerReturns,
      supplierReturns,
      swaps,
      writeOff: writeOffEvent
        ? {
            eventDate: writeOffEvent.eventDate,
            reason: writeOffEvent.reason,
            recordedBy: writeOffEvent.adminName,
          }
        : null,
      previousSales,
      timeline: events,
    };
  }

  private statusSummary(input: {
    unit: {
      status: ProductUnitStatus;
      condition: ProductUnitCondition;
      receivedAt: Date;
      source: ProductUnitSource;
      purchase: { invoiceNumber: string; supplier: { name: string } } | null;
      order: {
        orderNumber: string;
        deliveredAt: Date | null;
        dealer: { businessName: string };
        invoice: { invoiceNumber: string } | null;
      } | null;
      replacesUnit: { serialNumber: string } | null;
      replacedBy: { serialNumber: string; receivedAt: Date } | null;
    };
    warranty: {
      state: 'NOT_SET' | 'VALID' | 'EXPIRED';
      daysLeft: number | null;
    };
    latestReturn: {
      returnNumber: string | null;
      returnDate: Date;
      dealer: { businessName: string | null };
      reasonNow: string | null;
      reasonAtTime: string | null;
      faultNote: string | null;
    } | null;
    currentSupplierReturn: {
      returnNumber: string | null;
      returnDate: Date;
      supplier: { name: string | null };
      reasonNow: string | null;
      reasonAtTime: string | null;
      isCancellation: boolean;
      purchase: { invoiceNumber: string; cancelReason: string | null } | null;
    } | null;
    latestSwapIn: { eventDate: Date; reason: string | null } | null;
    writeOffEvent: { eventDate: Date; reason: string | null } | null;
    latestDefect: { eventDate: Date; reason: string | null } | null;
  }) {
    const { unit, warranty, latestReturn, currentSupplierReturn } = input;
    const received = unit.purchase
      ? `Received ${fmtDate(unit.receivedAt)} from ${unit.purchase.supplier.name} (${unit.purchase.invoiceNumber})`
      : unit.source === ProductUnitSource.REPLACEMENT && unit.replacesUnit
        ? `Supplier replacement for ${unit.replacesUnit.serialNumber}, received ${fmtDate(unit.receivedAt)}`
        : `Registered from existing stock on ${fmtDate(unit.receivedAt)}`;
    const returnLine = latestReturn
      ? `Returned by ${latestReturn.dealer.businessName} on ${latestReturn.returnNumber}, ${fmtDate(latestReturn.returnDate)}: "${latestReturn.faultNote || latestReturn.reasonNow || latestReturn.reasonAtTime}"`
      : null;
    const warrantyText =
      warranty.state === 'VALID'
        ? `warranty valid, ${warranty.daysLeft} day(s) left`
        : warranty.state === 'EXPIRED'
          ? 'warranty expired'
          : 'no warranty date set';

    switch (unit.status) {
      case ProductUnitStatus.IN_STOCK:
        if (unit.condition === ProductUnitCondition.DEFECTIVE) {
          return {
            tone: 'warning' as const,
            headline: 'Defective — in our store',
            subline:
              (returnLine ??
                (input.latestDefect
                  ? `Marked defective ${fmtDate(input.latestDefect.eventDate)}: "${input.latestDefect.reason}"`
                  : received)) +
              '. Not sellable — next step: return to supplier.',
          };
        }
        return latestReturn
          ? {
              tone: 'success' as const,
              headline: 'In stock — returned by customer',
              subline: returnLine!,
            }
          : {
              tone: 'success' as const,
              headline: 'In stock',
              subline: received,
            };
      case ProductUnitStatus.ALLOCATED:
        return {
          tone: 'info' as const,
          headline: `Allocated to ${unit.order?.dealer.businessName ?? 'an order'}`,
          subline: `${unit.order?.orderNumber ?? ''}${unit.order?.invoice ? ` · ${unit.order.invoice.invoiceNumber}` : ''} · waiting for delivery`,
        };
      case ProductUnitStatus.SOLD:
        return {
          tone: 'info' as const,
          headline: `Sold to ${unit.order?.dealer.businessName ?? 'a dealer'}${unit.replacesUnit && input.latestSwapIn ? ' (warranty replacement)' : ''}`,
          subline:
            unit.replacesUnit && input.latestSwapIn
              ? `Replaces ${unit.replacesUnit.serialNumber} (swapped ${fmtDate(input.latestSwapIn.eventDate)}: "${input.latestSwapIn.reason}") · ${warrantyText}`
              : `${unit.order?.invoice?.invoiceNumber ?? unit.order?.orderNumber ?? ''}${unit.order?.deliveredAt ? ` · delivered ${fmtDate(unit.order.deliveredAt)}` : ''} · ${warrantyText}`,
        };
      case ProductUnitStatus.RETURNED_TO_SUPPLIER:
        if (currentSupplierReturn?.isCancellation) {
          return {
            tone: 'purple' as const,
            headline: 'Returned to supplier (purchase cancelled)',
            subline: `${currentSupplierReturn.purchase?.invoiceNumber ?? ''} cancelled ${fmtDate(currentSupplierReturn.returnDate)}: "${currentSupplierReturn.purchase?.cancelReason ?? currentSupplierReturn.reasonNow ?? ''}"`,
          };
        }
        if (unit.replacedBy) {
          return {
            tone: 'purple' as const,
            headline: 'Returned to supplier — replaced',
            subline: `Replaced by ${unit.replacedBy.serialNumber}, received ${fmtDate(unit.replacedBy.receivedAt)}`,
          };
        }
        return {
          tone: 'purple' as const,
          headline: 'With supplier — awaiting replacement',
          subline: currentSupplierReturn
            ? `Sent to ${currentSupplierReturn.supplier.name} on ${currentSupplierReturn.returnNumber}, ${fmtDate(currentSupplierReturn.returnDate)}: "${currentSupplierReturn.reasonNow ?? currentSupplierReturn.reasonAtTime}" · ${Math.floor((Date.now() - new Date(currentSupplierReturn.returnDate).getTime()) / DAY_MS)} day(s) ago`
            : 'Sent back to the supplier',
        };
      case ProductUnitStatus.WRITTEN_OFF:
        return {
          tone: 'muted' as const,
          headline: 'Written off',
          subline: input.writeOffEvent
            ? `${fmtDate(input.writeOffEvent.eventDate)}: "${input.writeOffEvent.reason}"`
            : 'Removed from stock',
        };
    }
  }

  /** Per tracked product: physical stock vs serials (§6.2). Reports only. */
  async coverage(productId?: string) {
    const products = await this.prisma.product.findMany({
      where: {
        ...(productId && { id: productId }),
        OR: [{ trackSerials: true }, { units: { some: {} } }],
      },
      select: { id: true, name: true, productCode: true, trackSerials: true },
      orderBy: { name: 'asc' },
    });
    const rows: Record<string, unknown>[] = [];
    for (const product of products) {
      const state = await this.lifecycle.shelfState(this.prisma, product.id);
      const counts = await this.prisma.productUnit.groupBy({
        by: ['status', 'condition'],
        where: { productId: product.id },
        _count: { _all: true },
      });
      const count = (
        status: ProductUnitStatus,
        condition?: ProductUnitCondition,
      ) =>
        counts
          .filter(
            (c) =>
              c.status === status && (!condition || c.condition === condition),
          )
          .reduce((sum, c) => sum + c._count._all, 0);
      rows.push({
        ...product,
        ...state,
        inStock: count(ProductUnitStatus.IN_STOCK),
        defectiveInStock: count(
          ProductUnitStatus.IN_STOCK,
          ProductUnitCondition.DEFECTIVE,
        ),
        allocated: count(ProductUnitStatus.ALLOCATED),
        sold: count(ProductUnitStatus.SOLD),
        returnedToSupplier: count(ProductUnitStatus.RETURNED_TO_SUPPLIER),
        writtenOff: count(ProductUnitStatus.WRITTEN_OFF),
        problem: state.gap < 0,
      });
    }
    return rows;
  }

  // ---------------------------------------------------------------------
  // Unit corrections
  // ---------------------------------------------------------------------

  async update(id: string, dto: UpdateUnitDto, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lifecycle.lockUnits(tx, [id]);
      const unit = await tx.productUnit.findUnique({
        where: { id },
        include: { events: true, product: { select: { name: true } } },
      });
      if (!unit) throw new NotFoundException('Serial unit not found');

      const changes: string[] = [];
      const data: Prisma.ProductUnitUpdateInput = {};

      if (dto.serialNumber !== undefined) {
        const serial = normalizeSerial(dto.serialNumber);
        if (
          serial.serialKey !== unit.serialKey ||
          serial.serialNumber !== unit.serialNumber
        ) {
          const sold = unit.events.some(
            (e) => e.type === ProductUnitEventType.ASSIGNED_TO_ORDER,
          );
          if (unit.status !== ProductUnitStatus.IN_STOCK || sold) {
            throw new BadRequestException(
              'Only an in-stock unit that was never on an order can have its serial corrected',
            );
          }
          if (!dto.reason?.trim())
            throw new BadRequestException('Give a reason for the correction');
          const clashes = await this.lifecycle.findModelBarcodeClashes(tx, [
            serial.serialKey,
          ]);
          if (clashes.size > 0) {
            throw new BadRequestException(
              'That value is a product model barcode/code, not a unit serial',
            );
          }
          data.serialNumber = serial.serialNumber;
          data.serialKey = serial.serialKey;
          changes.push(`serial ${unit.serialNumber} → ${serial.serialNumber}`);
          await this.lifecycle.addEvent(tx, unit, {
            type: ProductUnitEventType.SERIAL_CORRECTED,
            adminId,
            reason: dto.reason,
            details: `${unit.serialNumber} → ${serial.serialNumber}`,
          });
        }
      }

      const warrantyEdited =
        dto.warrantyStartsAt !== undefined ||
        dto.warrantyExpiresAt !== undefined;
      if (warrantyEdited) {
        if (!unit.orderId) {
          throw new BadRequestException(
            'Warranty dates apply to a unit on an order',
          );
        }
        if (!dto.reason?.trim())
          throw new BadRequestException(
            'Give a reason for changing the warranty',
          );
        const startsAt =
          dto.warrantyStartsAt === undefined
            ? unit.warrantyStartsAt
            : dto.warrantyStartsAt
              ? new Date(dto.warrantyStartsAt)
              : null;
        const expiresAt =
          dto.warrantyExpiresAt === undefined
            ? unit.warrantyExpiresAt
            : dto.warrantyExpiresAt
              ? new Date(dto.warrantyExpiresAt)
              : null;
        if (startsAt && expiresAt && expiresAt < startsAt) {
          throw new BadRequestException(
            'Warranty expiry cannot be before its start',
          );
        }
        data.warrantyStartsAt = startsAt;
        data.warrantyExpiresAt = expiresAt;
        data.warrantyManual = true;
        changes.push(
          `warranty ${fmtDate(unit.warrantyStartsAt)}–${fmtDate(unit.warrantyExpiresAt)} → ${fmtDate(startsAt)}–${fmtDate(expiresAt)}`,
        );
        await this.lifecycle.addEvent(tx, unit, {
          type: ProductUnitEventType.WARRANTY_UPDATED,
          adminId,
          reason: dto.reason,
          details: `Was ${fmtDate(unit.warrantyStartsAt) || '—'} to ${fmtDate(unit.warrantyExpiresAt) || '—'}; now ${fmtDate(startsAt) || '—'} to ${fmtDate(expiresAt) || '—'}`,
        });
      }

      if (dto.notes !== undefined) {
        data.notes = dto.notes?.trim() || null;
        changes.push('notes');
      }
      if (changes.length === 0) return { message: 'Nothing changed' };

      try {
        await tx.productUnit.update({ where: { id }, data });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException(
            'Another unit of this product already has that serial',
          );
        }
        throw error;
      }
      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_SERIAL_UNIT',
        targetId: id,
        details: `${unit.product.name} ${unit.serialNumber}: ${changes.join('; ')}`,
      });
      return { message: 'Updated' };
    }, TRANSACTION_OPTIONS);
  }

  /** Mistaken registration only (§6.3). */
  async remove(id: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lifecycle.lockUnits(tx, [id]);
      const unit = await tx.productUnit.findUnique({
        where: { id },
        include: {
          events: true,
          replacedBy: { select: { id: true } },
          product: { select: { name: true } },
        },
      });
      if (!unit) throw new NotFoundException('Serial unit not found');
      const blocking: ProductUnitEventType[] = [
        ProductUnitEventType.ASSIGNED_TO_ORDER,
        ProductUnitEventType.RETURNED_BY_DEALER,
        ProductUnitEventType.RETURNED_TO_SUPPLIER,
        ProductUnitEventType.WARRANTY_SWAP_IN,
        ProductUnitEventType.WARRANTY_SWAP_OUT,
        ProductUnitEventType.WRITTEN_OFF,
      ];
      if (
        unit.status !== ProductUnitStatus.IN_STOCK ||
        unit.events.some((e) => blocking.includes(e.type)) ||
        unit.replacedBy ||
        unit.replacesUnitId
      ) {
        throw new BadRequestException(
          'This unit has sales, return or replacement history — correct its serial or write it off instead',
        );
      }
      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_SERIAL_UNIT',
        targetId: id,
        details: JSON.stringify({ reason: 'Mistaken registration', unit }),
      });
      await tx.productUnitEvent.deleteMany({ where: { unitId: id } });
      await tx.productUnit.delete({ where: { id } });
      return { message: `Serial ${unit.serialNumber} removed` };
    }, TRANSACTION_OPTIONS);
  }

  async setCondition(id: string, dto: SetConditionDto, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lifecycle.lockUnits(tx, [id]);
      const unit = await tx.productUnit.findUnique({
        where: { id },
        include: { product: { select: { name: true } } },
      });
      if (!unit) throw new NotFoundException('Serial unit not found');
      if (unit.status !== ProductUnitStatus.IN_STOCK) {
        throw new BadRequestException(
          'Only an in-stock unit can be marked good or defective',
        );
      }
      if (unit.condition === dto.condition) {
        throw new BadRequestException(
          `Unit is already ${dto.condition.toLowerCase()}`,
        );
      }
      const updated = await tx.productUnit.updateMany({
        where: {
          id,
          status: ProductUnitStatus.IN_STOCK,
          condition: unit.condition,
        },
        data: { condition: dto.condition },
      });
      if (updated.count !== 1)
        throw new ConflictException(
          'Unit changed meanwhile — reload and try again',
        );
      await this.lifecycle.addEvent(
        tx,
        { id, status: unit.status, condition: dto.condition },
        {
          type:
            dto.condition === ProductUnitCondition.DEFECTIVE
              ? ProductUnitEventType.MARKED_DEFECTIVE
              : ProductUnitEventType.MARKED_GOOD,
          adminId,
          reason: dto.reason,
        },
      );
      await this.activityLogService.log(tx, {
        adminId,
        action: 'SET_SERIAL_CONDITION',
        targetId: id,
        details: `${unit.product.name} ${unit.serialNumber} marked ${dto.condition.toLowerCase()}: ${dto.reason}`,
      });
      return { message: 'Updated' };
    }, TRANSACTION_OPTIONS);
  }

  /**
   * §6.1 step 3: the buyer hands back a faulty unit and takes another of the
   * same product on the same order. One in, one out of the same product, so
   * stock, invoice and balances are untouched — nothing but units moves.
   */
  async warrantySwap(id: string, dto: WarrantySwapDto, adminId: string) {
    const replacementSerial = normalizeSerial(dto.replacementSerial);
    const { idempotencyKey, ...body } = dto;
    return this.idempotent(
      idempotencyKey,
      adminId,
      `SWAP:${id}`,
      body,
      async (tx) => {
        await this.lifecycle.lockUnits(tx, [id]);
        const old = await tx.productUnit.findUnique({
          where: { id },
          include: { product: { select: { name: true } } },
        });
        if (!old) throw new NotFoundException('Serial unit not found');
        if (
          !old.orderId ||
          (old.status !== ProductUnitStatus.SOLD &&
            old.status !== ProductUnitStatus.ALLOCATED)
        ) {
          throw new BadRequestException(
            'Only a unit that is on an order can be swapped',
          );
        }
        const order = await this.lifecycle.loadOrderContext(tx, old.orderId);
        await this.lifecycle.lockOrder(tx, order.id);
        const fresh = await tx.productUnit.findUnique({
          where: {
            productId_serialKey: {
              productId: old.productId,
              serialKey: replacementSerial.serialKey,
            },
          },
        });
        if (!fresh) {
          throw new BadRequestException(
            `Serial ${replacementSerial.serialNumber} is not registered for "${old.product.name}" — register it first`,
          );
        }
        if (fresh.id === old.id)
          throw new BadRequestException(
            'Scan a different unit as the replacement',
          );
        if (
          fresh.status !== ProductUnitStatus.IN_STOCK ||
          fresh.orderId ||
          fresh.condition !== ProductUnitCondition.GOOD
        ) {
          throw new BadRequestException(
            `Serial ${fresh.serialNumber} is not a good, in-stock unit`,
          );
        }
        if (fresh.replacesUnitId) {
          throw new BadRequestException(
            `Serial ${fresh.serialNumber} already replaced another unit`,
          );
        }
        await this.lifecycle.lockUnits(tx, [fresh.id]);
        const ref = order.invoice
          ? `${order.orderNumber} / ${order.invoice.invoiceNumber}`
          : order.orderNumber;

        const outRes = await tx.productUnit.updateMany({
          where: { id: old.id, orderId: order.id, status: old.status },
          data: {
            status: ProductUnitStatus.IN_STOCK,
            condition: ProductUnitCondition.DEFECTIVE,
            orderId: null,
          },
        });
        const inRes = await tx.productUnit.updateMany({
          where: {
            id: fresh.id,
            status: ProductUnitStatus.IN_STOCK,
            orderId: null,
          },
          data: {
            status: old.status,
            orderId: order.id,
            replacesUnitId: old.id,
            allocatedAt: new Date(),
            soldAt: old.soldAt,
            warrantyStartsAt: old.warrantyStartsAt,
            warrantyExpiresAt: old.warrantyExpiresAt,
            warrantyManual: true,
          },
        });
        if (outRes.count !== 1 || inRes.count !== 1) {
          throw new ConflictException(
            'A unit changed meanwhile — reload and try again',
          );
        }
        await this.lifecycle.addEvent(
          tx,
          {
            id: old.id,
            status: ProductUnitStatus.IN_STOCK,
            condition: ProductUnitCondition.DEFECTIVE,
          },
          {
            type: ProductUnitEventType.WARRANTY_SWAP_OUT,
            adminId,
            documentId: order.id,
            documentRef: ref,
            partyName: order.dealer.businessName,
            reason: dto.reason,
            faultNote: dto.faultNote?.trim() || null,
            details: `Replaced by ${fresh.serialNumber}`,
          },
        );
        await this.lifecycle.addEvent(
          tx,
          {
            id: fresh.id,
            status: old.status,
            condition: ProductUnitCondition.GOOD,
          },
          {
            type: ProductUnitEventType.WARRANTY_SWAP_IN,
            adminId,
            documentId: order.id,
            documentRef: ref,
            partyName: order.dealer.businessName,
            reason: dto.reason,
            details: `Replaces ${old.serialNumber}`,
          },
        );
        await this.activityLogService.log(tx, {
          adminId,
          action: 'WARRANTY_SWAP',
          targetId: order.id,
          details: `${old.product.name}: ${old.serialNumber} swapped for ${fresh.serialNumber} on ${ref} (${dto.reason})`,
        });
        return { oldUnitId: old.id, newUnitId: fresh.id };
      },
    );
  }

  /** A unit sent back to the supplier was replaced: register the new serial, linked. */
  async supplierReplacement(
    id: string,
    dto: SupplierReplacementDto,
    adminId: string,
  ) {
    const serial = normalizeSerial(dto.serial);
    const { idempotencyKey, ...body } = dto;
    return this.idempotent(
      idempotencyKey,
      adminId,
      `REPLACEMENT:${id}`,
      body,
      async (tx) => {
        await this.lifecycle.lockUnits(tx, [id]);
        const old = await tx.productUnit.findUnique({
          where: { id },
          include: {
            replacedBy: { select: { id: true } },
            purchaseReturn: {
              include: { supplier: { select: { name: true } } },
            },
            product: { select: { name: true } },
          },
        });
        if (!old) throw new NotFoundException('Serial unit not found');
        if (old.status !== ProductUnitStatus.RETURNED_TO_SUPPLIER) {
          throw new BadRequestException(
            'Only a unit returned to the supplier can get a supplier replacement',
          );
        }
        if (old.replacedBy)
          throw new BadRequestException(
            'This unit already has a replacement registered',
          );
        if (dto.replacementId) {
          const record = await tx.purchaseReturnReplacement.findUnique({
            where: { id: dto.replacementId },
          });
          if (!record || record.purchaseReturnId !== old.purchaseReturnId) {
            throw new BadRequestException(
              'That replacement record belongs to a different return',
            );
          }
        }
        const [unit] = await this.lifecycle.registerUnits(tx, {
          productId: old.productId,
          serials: [serial],
          source: ProductUnitSource.REPLACEMENT,
          receivedAt: new Date(dto.receivedAt),
          adminId,
          replacementId: dto.replacementId,
          replacesUnitId: old.id,
          documentRef: old.purchaseReturn?.returnNumber,
          partyName: old.purchaseReturn?.supplier.name,
          reason: dto.notes ?? `Supplier replacement for ${old.serialNumber}`,
        });
        await this.activityLogService.log(tx, {
          adminId,
          action: 'REGISTERED_SUPPLIER_REPLACEMENT',
          targetId: unit.id,
          details: `${old.product.name}: ${serial.serialNumber} received from ${old.purchaseReturn?.supplier.name ?? 'supplier'} replacing ${old.serialNumber}`,
        });
        return { newUnitId: unit.id };
      },
    );
  }

  // ---------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------

  async getOrderUnits(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                brand: true,
                model: true,
                trackSerials: true,
                warrantyMonths: true,
              },
            },
          },
        },
        units: {
          include: { replacesUnit: { select: { serialNumber: true } } },
          orderBy: { serialKey: 'asc' },
        },
        salesReturns: { include: { items: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order.items.map((item) => {
      const returnedQty = order.salesReturns
        .flatMap((r) => r.items)
        .filter((i) => i.productId === item.productId)
        .reduce((sum, i) => sum + i.quantity, 0);
      const assigned = order.units.filter(
        (u) => u.productId === item.productId,
      );
      return {
        productId: item.productId,
        product: item.product,
        quantity: item.quantity,
        returnedQty,
        required: item.quantity - returnedQty,
        assigned: assigned.map((u) => ({
          id: u.id,
          serialNumber: u.serialNumber,
          status: u.status,
          condition: u.condition,
          warrantyExpiresAt: u.warrantyExpiresAt,
          replacesSerial: u.replacesUnit?.serialNumber ?? null,
        })),
      };
    });
  }

  async assignOrderUnits(
    orderId: string,
    dto: AssignOrderUnitsDto,
    adminId: string,
  ) {
    const lines = dto.lines.map((line) => ({
      productId: line.productId,
      serials: normalizeSerialList(line.serials),
    }));
    const productIds = lines.map((l) => l.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new BadRequestException('Each product may appear once');
    }
    const { idempotencyKey, ...body } = dto;
    return this.idempotent(
      idempotencyKey,
      adminId,
      `ASSIGN:${orderId}`,
      body,
      async (tx) => {
        await this.lifecycle.lockOrder(tx, orderId);
        const order = await this.lifecycle.loadOrderContext(tx, orderId);
        const totals = { added: 0, removed: 0, registered: 0 };
        for (const line of lines) {
          const result = await this.lifecycle.setOrderLineUnits(
            tx,
            order,
            line.productId,
            line.serials,
            adminId,
          );
          totals.added += result.added;
          totals.removed += result.removed;
          totals.registered += result.registered;
        }
        if (totals.added + totals.removed > 0) {
          await this.activityLogService.log(tx, {
            adminId,
            action: 'ASSIGNED_SERIALS',
            targetId: orderId,
            details: `Order ${order.orderNumber}: ${totals.added} serial(s) assigned, ${totals.removed} removed${totals.registered ? `, ${totals.registered} newly registered` : ''}`,
          });
        }
        return totals;
      },
    );
  }

  /** Invoice page 2 — safe for the dealer role (no cost/supplier data). */
  async serialAnnexForOrder(orderId: string) {
    const units = await this.prisma.productUnit.findMany({
      where: {
        orderId,
        status: { in: [ProductUnitStatus.ALLOCATED, ProductUnitStatus.SOLD] },
      },
      select: {
        id: true,
        serialNumber: true,
        status: true,
        warrantyExpiresAt: true,
        productId: true,
        product: { select: { name: true, brand: true, model: true } },
        replacesUnit: { select: { serialNumber: true } },
      },
      orderBy: [{ productId: 'asc' }, { serialKey: 'asc' }],
    });
    const groups = new Map<
      string,
      {
        productId: string;
        productName: string;
        brand: string | null;
        model: string | null;
        serials: {
          id: string;
          serialNumber: string;
          status: ProductUnitStatus;
          warrantyExpiresAt: Date | null;
          replacesSerial: string | null;
        }[];
      }
    >();
    for (const unit of units) {
      const group = groups.get(unit.productId) ?? {
        productId: unit.productId,
        productName: unit.product.name,
        brand: unit.product.brand,
        model: unit.product.model,
        serials: [],
      };
      group.serials.push({
        id: unit.id,
        serialNumber: unit.serialNumber,
        status: unit.status,
        warrantyExpiresAt: unit.warrantyExpiresAt,
        replacesSerial: unit.replacesUnit?.serialNumber ?? null,
      });
      groups.set(unit.productId, group);
    }
    return [...groups.values()];
  }

  /** Order screen badge: assigned vs still-with-buyer quantity per tracked line. */
  async serialProgressForOrder(orderId: string) {
    const lines = await this.getOrderUnits(orderId);
    return lines
      .filter((line) => line.product.trackSerials || line.assigned.length > 0)
      .map((line) => ({
        productId: line.productId,
        assigned: line.assigned.length,
        required: line.required,
      }));
  }

  /** Purchase screen: serials registered per product. */
  async unitsForPurchase(purchaseId: string) {
    return this.prisma.productUnit.findMany({
      where: { purchaseId },
      select: {
        id: true,
        productId: true,
        serialNumber: true,
        status: true,
        condition: true,
      },
      orderBy: [{ productId: 'asc' }, { serialKey: 'asc' }],
    });
  }

  /** Delivered statuses, exposed for callers deciding SOLD vs ALLOCATED. */
  static isDelivered(status: OrderStatus) {
    return status === OrderStatus.DELIVERED || status === OrderStatus.COMPLETED;
  }
}
