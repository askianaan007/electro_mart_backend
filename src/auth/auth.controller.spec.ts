import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: {
    adminLogin: jest.Mock;
    dealerLogin: jest.Mock;
    forgotPassword: jest.Mock;
    resetPassword: jest.Mock;
    refresh: jest.Mock;
    logout: jest.Mock;
  };

  beforeEach(async () => {
    authService = {
      adminLogin: jest.fn(),
      dealerLogin: jest.fn(),
      forgotPassword: jest.fn(),
      resetPassword: jest.fn(),
      refresh: jest.fn(),
      logout: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates admin login to AuthService with the DTO fields', () => {
    void controller.adminLogin({
      email: 'admin@example.com',
      password: 'secret',
    });
    expect(authService.adminLogin).toHaveBeenCalledWith(
      'admin@example.com',
      'secret',
    );
  });

  it('delegates dealer login to AuthService with the DTO fields', () => {
    void controller.dealerLogin({ username: 'dealer1', password: 'secret' });
    expect(authService.dealerLogin).toHaveBeenCalledWith('dealer1', 'secret');
  });

  it('delegates password reset to AuthService with token, role, and new password', () => {
    void controller.resetPassword({
      token: 'tok',
      role: Role.ADMIN,
      newPassword: 'new-pass',
    });
    expect(authService.resetPassword).toHaveBeenCalledWith(
      'tok',
      Role.ADMIN,
      'new-pass',
    );
  });

  it('returns the current user from the request unchanged', () => {
    const user = { sub: 'admin-1', role: Role.ADMIN, iat: 0, exp: 0 };
    expect(controller.getProfile(user)).toBe(user);
  });
});
