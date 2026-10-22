/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- assertions read untyped JSON response bodies (supertest) */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { applyGlobalPipesAndFilters } from '../../src/create-app';
import { PrismaService } from '../../src/prisma/prisma.service';
import { hashPassword } from './fixtures';

export const ADMIN_PASSWORD = 'Admin-Test-Password-1';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  adminId: string;
  token: string;
  api: () => ReturnType<typeof request>;
  get: (path: string) => request.Test;
  post: (path: string, body?: object) => request.Test;
  patch: (path: string, body?: object) => request.Test;
  del: (path: string) => request.Test;
}

/**
 * Re-verifies, through the app's own PrismaService connection, that it is
 * the marked disposable database before anything is truncated — a second
 * guard on top of globalSetup, in case DATABASE_URL was somehow redirected.
 */
async function assertMarkedDatabase(prisma: PrismaService) {
  const token = process.env.TEST_DB_ISOLATION_TOKEN;
  const rows = await prisma
    .$queryRawUnsafe<{ token: string }[]>(
      'SELECT token FROM test_isolation.marker',
    )
    .catch(() => [] as { token: string }[]);
  if (!token || !rows.some((r) => r.token === token)) {
    throw new Error(
      'Refusing to continue: app is not connected to the marked test database.',
    );
  }
}

export async function resetDatabase(prisma: PrismaService) {
  await assertMarkedDatabase(prisma);
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.length === 0) return;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';

/** Empty database plus the one admin every test request authenticates as. */
export async function resetWithAdmin(prisma: PrismaService) {
  await resetDatabase(prisma);
  return prisma.admin.create({
    data: {
      id: ADMIN_ID,
      email: 'admin@test.local',
      name: 'Test Admin',
      password: await hashPassword(ADMIN_PASSWORD),
    },
  });
}

export async function createTestApp(): Promise<TestContext> {
  // The global ThrottlerGuard is registered as APP_GUARD (useClass), which
  // overrideGuard can't reach; 100 req/min would throttle a test file's own
  // requests, so stub it at the prototype.
  jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  applyGlobalPipesAndFilters(app);
  await app.init();

  const prisma = app.get(PrismaService);
  const admin = await resetWithAdmin(prisma);
  const token = app
    .get(JwtService)
    .sign({ sub: admin.id, role: Role.ADMIN, email: admin.email });

  const server = app.getHttpServer();
  const auth = (t: request.Test) => t.set('Authorization', `Bearer ${token}`);
  return {
    app,
    prisma,
    adminId: admin.id,
    token,
    api: () => request(server),
    get: (p) => auth(request(server).get(p)),
    post: (p, body) => auth(request(server).post(p)).send(body ?? {}),
    patch: (p, body) => auth(request(server).patch(p)).send(body ?? {}),
    del: (p) => auth(request(server).delete(p)),
  };
}
