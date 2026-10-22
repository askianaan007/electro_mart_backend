/* eslint-disable @typescript-eslint/no-unsafe-member-access -- assertions read untyped JSON response bodies (supertest) */
import { createTestApp, TestContext } from '../support/test-app';

describe('integration harness', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('is connected to the marked disposable database', async () => {
    const [row] = await ctx.prisma.$queryRawUnsafe<{ db: string }[]>(
      'SELECT current_database() AS db',
    );
    expect(row.db).toBe('lcfix_test');
  });

  it('serves an empty Liquid Cash summary', async () => {
    const res = await ctx.get('/liquid-cash/summary').expect(200);
    expect(res.body.balance).toBe(0);
  });

  it('rejects unauthenticated requests', async () => {
    await ctx.api().get('/liquid-cash/summary').expect(401);
  });
});
