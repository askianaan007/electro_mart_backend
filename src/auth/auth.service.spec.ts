import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    admin: { findUnique: jest.Mock; update: jest.Mock };
    dealer: { findUnique: jest.Mock; update: jest.Mock };
    refreshToken: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let mailer: { notifyPasswordReset: jest.Mock };

  beforeEach(async () => {
    prisma = {
      admin: { findUnique: jest.fn(), update: jest.fn() },
      dealer: { findUnique: jest.fn(), update: jest.fn() },
      refreshToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    mailer = { notifyPasswordReset: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { sign: jest.fn(() => 'signed.jwt.token') },
        },
        { provide: ConfigService, useValue: { get: jest.fn(() => '30') } },
        { provide: MailerService, useValue: mailer },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('adminLogin', () => {
    it('rejects unknown email without revealing whether the account exists', async () => {
      prisma.admin.findUnique.mockResolvedValue(null);
      await expect(
        service.adminLogin('nobody@example.com', 'password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an incorrect password', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      prisma.admin.findUnique.mockResolvedValue({
        id: 'admin-1',
        email: 'admin@example.com',
        password: hashed,
        name: 'Admin',
      });
      await expect(
        service.adminLogin('admin@example.com', 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('issues tokens and returns the user on valid credentials', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      prisma.admin.findUnique.mockResolvedValue({
        id: 'admin-1',
        email: 'admin@example.com',
        password: hashed,
        name: 'Admin',
      });
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.adminLogin(
        'admin@example.com',
        'correct-password',
      );

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.refreshToken).toEqual(expect.any(String));
      expect(result.user).toEqual({
        id: 'admin-1',
        name: 'Admin',
        email: 'admin@example.com',
        role: Role.ADMIN,
      });
      expect(prisma.refreshToken.create).toHaveBeenCalled();
    });
  });

  describe('dealerLogin', () => {
    it('rejects an inactive dealer even with the correct password', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      prisma.dealer.findUnique.mockResolvedValue({
        id: 'dealer-1',
        username: 'dealer1',
        password: hashed,
        status: AccountStatus.INACTIVE,
        businessName: 'Dealer Co',
      });
      await expect(
        service.dealerLogin('dealer1', 'correct-password'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refresh', () => {
    it('rejects an expired refresh token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
        role: Role.ADMIN,
        userId: 'admin-1',
      });
      await expect(service.refresh('some-refresh-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an already-revoked refresh token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000 * 60),
        role: Role.ADMIN,
        userId: 'admin-1',
      });
      await expect(service.refresh('some-refresh-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('resetPassword', () => {
    it('rejects an invalid or expired reset token', async () => {
      prisma.admin.findUnique.mockResolvedValue(null);
      await expect(
        service.resetPassword('bad-token', Role.ADMIN, 'new-password'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
