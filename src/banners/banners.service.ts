import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { AssignBannerDto } from './dto/assign-banner.dto';
import { SetStatusDto } from '../common/dto/set-status.dto';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

@Injectable()
export class BannersService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private uploadsService: UploadsService,
  ) {}

  async create(
    dto: CreateBannerDto,
    file: Express.Multer.File | undefined,
    adminId: string,
  ) {
    if (!file) throw new BadRequestException('A banner image is required');
    const uploaded = await this.uploadsService.uploadImage(
      file.buffer,
      'banners',
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const banner = await tx.banner.create({
          data: {
            imageUrl: uploaded.url,
            publicId: uploaded.publicId,
            title: dto.title,
            subtitle: dto.subtitle,
            ctaLabel: dto.ctaLabel,
            linkType: dto.linkType,
            linkValue: dto.linkValue,
            sortOrder: dto.sortOrder ?? 0,
          },
        });
        await this.activityLogService.log(tx, {
          adminId,
          action: 'CREATED_BANNER',
          targetId: banner.id,
          details: `Created banner${banner.title ? ` "${banner.title}"` : ''}`,
        });
        return banner;
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      await this.uploadsService.deleteImage(uploaded.publicId);
      throw error;
    }
  }

  async findAll() {
    return this.prisma.banner.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async findOne(id: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) throw new NotFoundException('Banner not found');
    return banner;
  }

  async update(id: string, dto: UpdateBannerDto, adminId: string) {
    await this.findOne(id);
    return this.prisma.$transaction(async (tx) => {
      const banner = await tx.banner.update({ where: { id }, data: dto });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_BANNER',
        targetId: id,
        details: `Updated banner${banner.title ? ` "${banner.title}"` : ''}`,
      });
      return banner;
    }, TRANSACTION_OPTIONS);
  }

  async setStatus(id: string, dto: SetStatusDto, adminId: string) {
    await this.findOne(id);
    return this.prisma.$transaction(async (tx) => {
      const banner = await tx.banner.update({
        where: { id },
        data: { status: dto.status },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: `BANNER_${dto.status}`,
        targetId: id,
        details: `Banner set to ${dto.status}`,
      });
      return banner;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const banner = await this.findOne(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.bannerAssignment.deleteMany({ where: { bannerId: id } });
      await tx.banner.delete({ where: { id } });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_BANNER',
        targetId: id,
        details: `Deleted banner${banner.title ? ` "${banner.title}"` : ''}`,
      });
    }, TRANSACTION_OPTIONS);

    await this.uploadsService.deleteImage(banner.publicId);
    return { message: 'Banner deleted' };
  }

  // -------------------------------------------------------------------
  // Assignment (Rep_Portal_DOCUMENTATION.md §7 / version2_changes_backend.md §8)
  // -------------------------------------------------------------------

  async listAssignments(bannerId: string) {
    await this.findOne(bannerId);
    return this.prisma.bannerAssignment.findMany({
      where: { bannerId },
      include: { representative: { select: { id: true, name: true } } },
    });
  }

  async assign(bannerId: string, dto: AssignBannerDto, adminId: string) {
    await this.findOne(bannerId);
    const rep = await this.prisma.representative.findUnique({
      where: { id: dto.representativeId },
    });
    if (!rep) throw new NotFoundException('Representative not found');

    return this.prisma.$transaction(async (tx) => {
      const assignment = await tx.bannerAssignment.create({
        data: {
          bannerId,
          representativeId: dto.representativeId,
          priority: dto.priority ?? 0,
          startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'ASSIGNED_BANNER',
        targetId: bannerId,
        details: `Assigned banner ${bannerId} to representative ${rep.name}`,
      });
      return assignment;
    }, TRANSACTION_OPTIONS);
  }

  async removeAssignment(
    bannerId: string,
    assignmentId: string,
    adminId: string,
  ) {
    const assignment = await this.prisma.bannerAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment || assignment.bannerId !== bannerId) {
      throw new NotFoundException('Assignment not found');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.bannerAssignment.delete({ where: { id: assignmentId } });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'REMOVED_BANNER_ASSIGNMENT',
        targetId: bannerId,
        details: `Removed a banner assignment from banner ${bannerId}`,
      });
      return { message: 'Assignment removed' };
    }, TRANSACTION_OPTIONS);
  }
}
