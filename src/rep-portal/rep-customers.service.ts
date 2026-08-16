import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerStatus,
  DealerSource,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RepActivityLogService } from '../rep-activity-log/rep-activity-log.service';
import { CreateRepCustomerDto } from './dto/create-rep-customer.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { generateTempPassword } from '../common/utils/generate-password';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

const PASSWORD_SALT_ROUNDS = 10;

/**
 * Rep Portal — Customer Management (Rep_Portal_DOCUMENTATION.md §11-§13).
 * A "customer" here is a Dealer row sourced from the Rep Portal
 * (source: REP_PORTAL), extended with the CustomerProfile satellite — see
 * that document's §23.2-§23.3 for the full reasoning. This service never
 * touches a Dealer row with source: DEALER_PORTAL.
 */
@Injectable()
export class RepCustomersService {
  constructor(
    private prisma: PrismaService,
    private repActivityLogService: RepActivityLogService,
  ) {}

  private readonly customerInclude = {
    customerProfile: true,
  } satisfies Prisma.DealerInclude;

  private toCustomerShape(
    dealer: Prisma.DealerGetPayload<{
      include: { customerProfile: true };
      omit: { password: true };
    }>,
  ) {
    const { customerProfile, ...rest } = dealer;
    return {
      ...rest,
      whatsapp: customerProfile?.whatsapp ?? null,
      city: customerProfile?.city ?? null,
      province: customerProfile?.province ?? null,
      area: customerProfile?.area ?? null,
      latitude: customerProfile?.latitude ?? null,
      longitude: customerProfile?.longitude ?? null,
      shopPhotoUrl: customerProfile?.shopPhotoUrl ?? null,
      customerStatus: customerProfile?.status ?? CustomerStatus.NEW,
      assignedRepId: customerProfile?.assignedRepId ?? null,
    };
  }

  // Deliberately not scoped by repId — shared across all representatives so
  // two reps don't independently register the same shop twice (§11.1).
  async search(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // §11.1 — scoped to REP_PORTAL-sourced shops only, shared across every
    // representative (not just the caller) so two reps don't independently
    // register the same shop twice.
    const where: Prisma.DealerWhereInput = {
      source: DealerSource.REP_PORTAL,
      ...(query.search && {
        OR: [
          { businessName: { contains: query.search, mode: 'insensitive' } },
          { ownerName: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search, mode: 'insensitive' } },
          {
            customerProfile: {
              city: { contains: query.search, mode: 'insensitive' },
            },
          },
          {
            customerProfile: {
              area: { contains: query.search, mode: 'insensitive' },
            },
          },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.dealer.findMany({
        where,
        include: this.customerInclude,
        omit: { password: true },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.dealer.count({ where }),
    ]);

    return paginate(
      data.map((d) => this.toCustomerShape(d)),
      total,
      page,
      limit,
    );
  }

  async create(dto: CreateRepCustomerDto, repId: string) {
    const normalizedPhone = dto.phone.replace(/\s+/g, '');
    const duplicate = await this.prisma.dealer.findFirst({
      where: {
        source: DealerSource.REP_PORTAL,
        phone: { equals: normalizedPhone },
      },
    });
    // Loose match against stored phone values too, since existing rows may
    // include formatting the exact-equals check above would miss.
    const duplicateLoose =
      duplicate ??
      (await this.prisma.dealer.findFirst({
        where: {
          source: DealerSource.REP_PORTAL,
          phone: { contains: normalizedPhone },
        },
      }));
    if (duplicateLoose) {
      throw new ConflictException(
        `A shop with this phone number already exists: "${duplicateLoose.businessName}". Search for it instead of creating a duplicate.`,
      );
    }

    // Auto-generated, never surfaced — this shop never logs in itself
    // (Rep_Portal_DOCUMENTATION.md §12).
    const username = `shop-${crypto.randomBytes(6).toString('hex')}`;
    const hashed = await bcrypt.hash(
      generateTempPassword(),
      PASSWORD_SALT_ROUNDS,
    );

    const dealer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dealer.create({
        data: {
          businessName: dto.shopName,
          ownerName: dto.contactName,
          phone: dto.phone,
          email: dto.email,
          address: dto.address,
          district: dto.district,
          username,
          password: hashed,
          creditLimit: 0,
          unlimitedCredit: true, // §29.2 — PENDING_APPROVAL is the real checkpoint for a brand-new shop
          source: DealerSource.REP_PORTAL,
          createdByRepId: repId,
          customerProfile: {
            create: {
              whatsapp: dto.whatsapp,
              city: dto.city,
              province: dto.province,
              status: CustomerStatus.NEW,
              assignedRepId: repId,
            },
          },
        },
        include: this.customerInclude,
        omit: { password: true },
      });

      await this.repActivityLogService.log(tx, {
        representativeId: repId,
        action: 'CUSTOMER_CREATED',
        targetId: created.id,
        details: `Registered new shop ${created.businessName}`,
      });

      return created;
    }, TRANSACTION_OPTIONS);

    return this.toCustomerShape(dealer);
  }

  async findOne(id: string) {
    const dealer = await this.prisma.dealer.findFirst({
      where: { id, source: DealerSource.REP_PORTAL },
      include: this.customerInclude,
      omit: { password: true },
    });
    if (!dealer) throw new NotFoundException('Customer not found');

    const [totalOrders, pendingOrders, completedOrdersAgg, notes] =
      await this.prisma.$transaction([
        this.prisma.order.count({ where: { dealerId: id } }),
        this.prisma.order.count({
          where: { dealerId: id, status: OrderStatus.PENDING_APPROVAL },
        }),
        this.prisma.order.aggregate({
          where: { dealerId: id, status: OrderStatus.COMPLETED },
          _sum: { totalAmount: true },
        }),
        this.prisma.customerNote.findMany({
          where: { dealerId: id },
          include: {
            authorRep: { select: { id: true, name: true } },
            authorAdmin: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

    return {
      ...this.toCustomerShape(dealer),
      summary: {
        totalOrders,
        pendingOrders,
        lifetimeCompletedValue: completedOrdersAgg._sum.totalAmount ?? 0,
      },
      notes: notes.map((n) => ({
        id: n.id,
        dealerId: n.dealerId,
        authorRepId: n.authorRepId,
        authorRepName: n.authorRep?.name,
        authorAdminId: n.authorAdminId,
        authorAdminName: n.authorAdmin?.name,
        note: n.note,
        createdAt: n.createdAt,
      })),
    };
  }

  async setStatus(id: string, status: CustomerStatus, repId: string) {
    const dealer = await this.prisma.dealer.findFirst({
      where: { id, source: DealerSource.REP_PORTAL },
    });
    if (!dealer) throw new NotFoundException('Customer not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.customerProfile.upsert({
        where: { dealerId: id },
        create: { dealerId: id, status, assignedRepId: repId },
        update: { status },
      });
      await tx.dealer.update({
        where: { id },
        data: { updatedAt: new Date() },
      });

      await this.repActivityLogService.log(tx, {
        representativeId: repId,
        action: 'CUSTOMER_STATUS_UPDATED',
        targetId: id,
        details: `Set ${dealer.businessName}'s status to ${status}`,
      });

      const updated = await tx.dealer.findUniqueOrThrow({
        where: { id },
        include: this.customerInclude,
        omit: { password: true },
      });
      return this.toCustomerShape(updated);
    }, TRANSACTION_OPTIONS);
  }

  async addNote(id: string, note: string, repId: string) {
    const dealer = await this.prisma.dealer.findFirst({
      where: { id, source: DealerSource.REP_PORTAL },
    });
    if (!dealer) throw new NotFoundException('Customer not found');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.customerNote.create({
        data: { dealerId: id, authorRepId: repId, note },
      });
      await this.repActivityLogService.log(tx, {
        representativeId: repId,
        action: 'CUSTOMER_NOTE_ADDED',
        targetId: id,
        details: `Added a note to ${dealer.businessName}`,
      });
      return created;
    }, TRANSACTION_OPTIONS);
  }
}
