import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RepCatalogVisibilityService } from '../rep-catalog-visibility/rep-catalog-visibility.service';
import { UpsertDraftDto } from './dto/upsert-draft.dto';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

/**
 * The server-side cart (Rep_Portal_DOCUMENTATION.md §14/§23.9). Deliberately
 * not an Order row — no interaction with OrderStatus, stock reservation, or
 * credit checks until RepOrdersService.create() is explicitly called.
 */
@Injectable()
export class RepDraftsService {
  private readonly draftInclude = {
    items: { include: { product: true } },
  } satisfies Prisma.RepOrderDraftInclude;

  constructor(
    private prisma: PrismaService,
    private repCatalogVisibility: RepCatalogVisibilityService,
  ) {}

  /** Every draft item embeds its product — must go through the same costPrice/stock-hiding boundary as every other rep-facing product read. */
  private async sanitize<
    T extends { items: { product: Prisma.ProductGetPayload<object> }[] },
  >(draft: T) {
    const items = await Promise.all(
      draft.items.map(async (item) => ({
        ...item,
        product: await this.repCatalogVisibility.serializeForRep(item.product),
      })),
    );
    return { ...draft, items };
  }

  private async sanitizeMany<
    T extends { items: { product: Prisma.ProductGetPayload<object> }[] },
  >(drafts: T[]) {
    return Promise.all(drafts.map((draft) => this.sanitize(draft)));
  }

  async create(repId: string) {
    const draft = await this.prisma.repOrderDraft.create({
      data: { repId },
      include: this.draftInclude,
    });
    return this.sanitize(draft);
  }

  async list(repId: string) {
    const drafts = await this.prisma.repOrderDraft.findMany({
      where: { repId },
      include: this.draftInclude,
      orderBy: { updatedAt: 'desc' },
    });
    return this.sanitizeMany(drafts);
  }

  async findOne(id: string, repId: string) {
    const draft = await this.prisma.repOrderDraft.findUnique({
      where: { id },
      include: this.draftInclude,
    });
    if (!draft) throw new NotFoundException('Draft not found');
    if (draft.repId !== repId)
      throw new ForbiddenException('You do not have access to this draft');
    return draft;
  }

  /** Same lookup as findOne, but returns the rep-safe serialized shape — this is the one the controller's GET :id route should call. */
  async findOneSanitized(id: string, repId: string) {
    const draft = await this.findOne(id, repId);
    return this.sanitize(draft);
  }

  async update(id: string, repId: string, dto: UpsertDraftDto) {
    await this.findOne(id, repId);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.items) {
        await tx.repOrderDraftItem.deleteMany({ where: { draftId: id } });
      }

      return tx.repOrderDraft.update({
        where: { id },
        data: {
          ...(dto.dealerId !== undefined && { dealerId: dto.dealerId }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(dto.expectedDeliveryDate !== undefined && {
            expectedDeliveryDate: dto.expectedDeliveryDate
              ? new Date(dto.expectedDeliveryDate)
              : null,
          }),
          ...(dto.items && {
            items: {
              create: dto.items.map((item) => ({
                productId: item.productId,
                quantity: item.quantity,
              })),
            },
          }),
        },
        include: this.draftInclude,
      });
    }, TRANSACTION_OPTIONS);
    return this.sanitize(updated);
  }

  async remove(id: string, repId: string) {
    await this.findOne(id, repId);
    await this.prisma.repOrderDraft.delete({ where: { id } });
    return { message: 'Draft deleted' };
  }
}
