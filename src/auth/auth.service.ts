import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { hashToken } from '../common/utils/hash-token';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const PASSWORD_SALT_ROUNDS = 10;
const REFRESH_TOKEN_BYTES = 48;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private mailer: MailerService,
  ) {}

  private async issueTokens(
    role: Role,
    userId: string,
    payload: Record<string, unknown>,
  ) {
    const accessToken = this.jwt.sign({ sub: userId, role, ...payload });

    const refreshToken = crypto
      .randomBytes(REFRESH_TOKEN_BYTES)
      .toString('hex');
    const refreshDays = Number(
      this.config.get<string>('JWT_REFRESH_EXPIRES_IN_DAYS') ?? 30,
    );
    const expiresAt = new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: { tokenHash: hashToken(refreshToken), role, userId, expiresAt },
    });

    return { accessToken, refreshToken };
  }

  async adminLogin(email: string, password: string) {
    const admin = await this.prisma.admin.findUnique({ where: { email } });
    if (!admin) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.issueTokens(Role.ADMIN, admin.id, {
      email: admin.email,
    });
    return {
      ...tokens,
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: Role.ADMIN,
      },
    };
  }

  async dealerLogin(username: string, password: string) {
    const dealer = await this.prisma.dealer.findUnique({ where: { username } });
    if (!dealer) throw new UnauthorizedException('Invalid credentials');
    if (dealer.status !== AccountStatus.ACTIVE)
      throw new UnauthorizedException('Account is inactive');

    const valid = await bcrypt.compare(password, dealer.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.issueTokens(Role.DEALER, dealer.id, {
      username: dealer.username,
    });
    return {
      ...tokens,
      user: {
        id: dealer.id,
        businessName: dealer.businessName,
        username: dealer.username,
        role: Role.DEALER,
      },
    };
  }

  async refresh(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    if (stored.role === Role.ADMIN) {
      const admin = await this.prisma.admin.findUnique({
        where: { id: stored.userId },
      });
      if (!admin) throw new UnauthorizedException('Account no longer exists');
      return this.issueTokens(Role.ADMIN, admin.id, { email: admin.email });
    }

    const dealer = await this.prisma.dealer.findUnique({
      where: { id: stored.userId },
    });
    if (!dealer || dealer.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedException('Account no longer active');
    }
    return this.issueTokens(Role.DEALER, dealer.id, {
      username: dealer.username,
    });
  }

  async logout(refreshToken: string): Promise<{ message: string }> {
    const tokenHash = hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { message: 'Logged out' };
  }

  async forgotPassword(
    identifier: string,
    role: Role,
  ): Promise<{ message: string }> {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    if (role === Role.ADMIN) {
      const admin = await this.prisma.admin.findUnique({
        where: { email: identifier },
      });
      if (admin) {
        await this.prisma.admin.update({
          where: { id: admin.id },
          data: { resetToken, resetTokenExpiry },
        });
        await this.mailer.notifyPasswordReset(admin.email, resetToken);
      }
    } else {
      const dealer = await this.prisma.dealer.findUnique({
        where: { username: identifier },
      });
      if (dealer?.email) {
        await this.prisma.dealer.update({
          where: { id: dealer.id },
          data: { resetToken, resetTokenExpiry },
        });
        await this.mailer.notifyPasswordReset(dealer.email, resetToken);
      }
    }

    return { message: 'If the account exists, a reset link has been sent.' };
  }

  async resetPassword(
    token: string,
    role: Role,
    newPassword: string,
  ): Promise<{ message: string }> {
    const hashed = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);

    if (role === Role.ADMIN) {
      const admin = await this.prisma.admin.findUnique({
        where: { resetToken: token },
      });
      if (
        !admin ||
        !admin.resetTokenExpiry ||
        admin.resetTokenExpiry < new Date()
      ) {
        throw new BadRequestException('Invalid or expired reset token');
      }
      await this.prisma.admin.update({
        where: { id: admin.id },
        data: { password: hashed, resetToken: null, resetTokenExpiry: null },
      });
    } else {
      const dealer = await this.prisma.dealer.findUnique({
        where: { resetToken: token },
      });
      if (
        !dealer ||
        !dealer.resetTokenExpiry ||
        dealer.resetTokenExpiry < new Date()
      ) {
        throw new BadRequestException('Invalid or expired reset token');
      }
      await this.prisma.dealer.update({
        where: { id: dealer.id },
        data: { password: hashed, resetToken: null, resetTokenExpiry: null },
      });
    }

    return { message: 'Password has been reset. You can now log in.' };
  }
}
