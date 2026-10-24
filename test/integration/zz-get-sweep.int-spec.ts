/* eslint-disable */
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { applyGlobalPipesAndFilters } from '../../src/create-app';
import { PrismaService } from '../../src/prisma/prisma.service';
it('GET sweep (read-only)', async () => {
  const url = process.env.DATABASE_URL ?? '';
  if (url.includes('ep-icy-boat') || !(url.includes('ep-bold-voice') || url.includes('127.0.0.1:54329'))) throw new Error('REFUSED');
  jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = m.createNestApplication(); applyGlobalPipesAndFilters(app); await app.init();
  const prisma = app.get(PrismaService);
  const admin = await prisma.admin.findFirstOrThrow();
  const token = app.get(JwtService).sign({ sub: admin.id, role: Role.ADMIN, email: admin.email });
  const routes: string[] = [];
  const server: any = app.getHttpServer();
  const router = server._events.request._router ?? app.getHttpAdapter().getInstance()._router;
  for (const l of router.stack) if (l.route && l.route.methods.get && !l.route.path.includes(':')) routes.push(l.route.path);
  const dealer = await prisma.dealer.findFirst();
  const invoice = await prisma.invoice.findFirst();
  if (dealer) routes.push(`/dealers/${dealer.id}`, `/dealers/${dealer.id}/wallet`, `/refunds/available/dealer/${dealer.id}`);
  if (invoice) routes.push(`/invoices/${invoice.id}`);
  const bad: string[] = [];
  for (const r of routes) {
    const res = await request(server).get(r).set('Authorization', `Bearer ${token}`);
    if (res.status >= 500) bad.push(`${r} ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  console.log(`checked ${routes.length} GET routes; 5xx: ${bad.length}\n${bad.join('\n')}`);
  await app.close();
  expect(bad).toEqual([]);
}, 600000);
