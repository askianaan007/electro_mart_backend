import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { CashAdjustmentType, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { paginate } from '../common/utils/paginate';
import { nextSequenceNumber } from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import {
  assertNotFutureBusinessDate,
  businessDateOf,
} from '../common/utils/business-date';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { CASH_LEDGER_CTE } from '../liquid-cash/cash-ledger.sql';
import { CreateCashAdjustmentDto } from './dto/create-cash-adjustment.dto';

// Serializes opening-balance creation/reversal so "at most one active" holds
// under concurrent requests (a partial unique index would do it in the DB,
// but Prisma can't model one and would try to drop it on the next migrate).
const OPENING_BALANCE_LOCK = 482_017_001;

/**
 * Liquid Cash entries backed only by evidence — a physical cash count or a
 * bank statement — not by any dealer/supplier/investor document. Nothing is
 * ever inferred: the figure, its date and its evidence come from an admin,
 * who re-enters their password. Adjustments are never edited or deleted; a
 * mistake is corrected by reversing it (a new, exactly negating row), so
 * every figure ever shown can still be explained.
 */
@Injectable()
export class CashAdjustmentsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  async create(dto: CreateCashAdjustmentDto, adminId: string) {
    await this.assertPassword(adminId, dto.password);
    assertNotFutureBusinessDate(dto.adjustmentDate, 'Adjustment date');
    const amount = new Prisma.Decimal(dto.amount);

    return this.prisma.$transaction(async (tx) => {
      if (dto.type === 'OPENING_BALANCE') {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OPENING_BALANCE_LOCK})`;
        const active = await tx.cashAdjustment.findFirst({
          where: {
            type: CashAdjustmentType.OPENING_BALANCE,
            reversalOfId: null,
            reversedBy: null,
          },
          select: { adjustmentNumber: true },
        });
        if (active) {
          throw new BadRequestException(
            `An opening balance (${active.adjustmentNumber}) already exists — reverse it first to replace it`,
          );
        }
        const [first] = await tx.$queryRaw<{ date: Date | null }[]>`
          ${CASH_LEDGER_CTE}
          SELECT MIN(date) AS date FROM combined WHERE type <> 'ADJUSTMENT'
        `;
        if (
          first?.date &&
          businessDateOf(dto.adjustmentDate) > businessDateOf(first.date)
        ) {
          throw new BadRequestException(
            `An opening balance must be dated on or before the first cash entry (${businessDateOf(first.date)}). Use an ADJUSTMENT for a later correction.`,
          );
        }
      }

      const adjustmentNumber = await nextSequenceNumber(
        tx,
        'cashAdjustment',
        'ADJ',
      );
      const adjustment = await tx.cashAdjustment.create({
        data: {
          adjustmentNumber,
          type: dto.type,
          amount,
          adjustmentDate: new Date(dto.adjustmentDate),
          reason: dto.reason,
          evidenceReference: dto.evidenceReference,
          adminId,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action:
          dto.type === 'OPENING_BALANCE'
            ? 'RECORDED_OPENING_BALANCE'
            : 'RECORDED_CASH_ADJUSTMENT',
        targetId: adjustment.id,
        details: `${adjustmentNumber}: ${dto.type} of ${amount.toString()} dated ${businessDateOf(dto.adjustmentDate)} (evidence: ${dto.evidenceReference}) — ${dto.reason}`,
      });
      return adjustment;
    }, TRANSACTION_OPTIONS);
  }

  async reverse(id: string, reason: string, password: string, adminId: string) {
    await this.assertPassword(adminId, password);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OPENING_BALANCE_LOCK})`;
      await tx.$queryRaw`SELECT id FROM "CashAdjustment" WHERE id = ${id} FOR UPDATE`;
      const original = await tx.cashAdjustment.findUnique({
        where: { id },
        include: { reversedBy: { select: { adjustmentNumber: true } } },
      });
      if (!original) throw new NotFoundException('Adjustment not found');
      if (original.reversalOfId) {
        throw new BadRequestException('A reversal cannot itself be reversed');
      }
      if (original.reversedBy) {
        throw new BadRequestException(
          `Already reversed by ${original.reversedBy.adjustmentNumber}`,
        );
      }
      if (original.type === CashAdjustmentType.SETTLEMENT_REVERSAL) {
        throw new BadRequestException(
          'A settlement reversal belongs to its commission settlement and cannot be reversed here',
        );
      }

      const adjustmentNumber = await nextSequenceNumber(
        tx,
        'cashAdjustment',
        'ADJ',
      );
      const reversal = await tx.cashAdjustment.create({
        data: {
          adjustmentNumber,
          type: original.type,
          amount: original.amount.neg(),
          adjustmentDate: new Date(),
          reason: `Reversal of ${original.adjustmentNumber}: ${reason}`,
          evidenceReference: original.evidenceReference,
          adminId,
          reversalOfId: original.id,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'REVERSED_CASH_ADJUSTMENT',
        targetId: original.id,
        details: `${adjustmentNumber} reverses ${original.adjustmentNumber} (${original.amount.toString()}): ${reason}`,
      });
      return reversal;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.CashAdjustmentWhereInput = query.search
      ? {
          OR: [
            {
              adjustmentNumber: { contains: query.search, mode: 'insensitive' },
            },
            { reason: { contains: query.search, mode: 'insensitive' } },
            {
              evidenceReference: {
                contains: query.search,
                mode: 'insensitive',
              },
            },
          ],
        }
      : {};
    const [data, total] = await this.prisma.$transaction([
      this.prisma.cashAdjustment.findMany({
        where,
        include: {
          admin: { select: { id: true, name: true } },
          reversedBy: { select: { id: true, adjustmentNumber: true } },
          reversalOf: { select: { id: true, adjustmentNumber: true } },
          settlement: { select: { id: true, settlementNumber: true } },
        },
        orderBy: [{ adjustmentDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.cashAdjustment.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  private async assertPassword(adminId: string, password: string) {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
    });
    if (!admin) throw new NotFoundException('Admin not found');
    if (!(await bcrypt.compare(password, admin.password))) {
      // 403, not 401: the session is fine, only the confirmation failed — a
      // 401 would make the frontend's API client treat it as a dead session.
      throw new ForbiddenException('Incorrect password');
    }
  }
}
