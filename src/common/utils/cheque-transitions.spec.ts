import { BadRequestException } from '@nestjs/common';
import { ChequeStatus } from '@prisma/client';
import { assertChequeTransition, ChequeKind } from './cheque-transitions';

const { PENDING, CLEARED, RETURNED } = ChequeStatus;
const now = new Date('2026-10-19T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe('assertChequeTransition', () => {
  it('rejects a cheque with no status and a no-op change', () => {
    expect(() =>
      assertChequeTransition('DEALER', null, CLEARED, null, now),
    ).toThrow(BadRequestException);
    expect(() =>
      assertChequeTransition('DEALER', CLEARED, CLEARED, hoursAgo(1), now),
    ).toThrow(/already marked CLEARED/);
  });

  it.each<ChequeKind>(['DEALER', 'REFUND_RECEIVED'])(
    '%s: allows every change, at any age (bank reversals, re-presented cheques)',
    (kind) => {
      const all = [PENDING, CLEARED, RETURNED];
      for (const from of all)
        for (const to of all)
          if (from !== to)
            expect(() =>
              assertChequeTransition(kind, from, to, hoursAgo(24 * 365), now),
            ).not.toThrow();
    },
  );

  it.each<ChequeKind>(['SUPPLIER', 'INVESTMENT', 'REFUND_PAID'])(
    '%s: forward from PENDING, revert to PENDING only within a day, never CLEARED↔RETURNED',
    (kind) => {
      expect(() =>
        assertChequeTransition(kind, PENDING, CLEARED, null, now),
      ).not.toThrow();
      expect(() =>
        assertChequeTransition(kind, PENDING, RETURNED, null, now),
      ).not.toThrow();
      expect(() =>
        assertChequeTransition(kind, CLEARED, PENDING, hoursAgo(23), now),
      ).not.toThrow();
      expect(() =>
        assertChequeTransition(kind, RETURNED, PENDING, hoursAgo(25), now),
      ).toThrow(/within 1 day/);
      expect(() =>
        assertChequeTransition(kind, CLEARED, PENDING, null, now),
      ).toThrow(/within 1 day/);
      expect(() =>
        assertChequeTransition(kind, CLEARED, RETURNED, hoursAgo(1), now),
      ).toThrow(/cannot be changed/);
      expect(() =>
        assertChequeTransition(kind, RETURNED, CLEARED, hoursAgo(1), now),
      ).toThrow(/cannot be changed/);
    },
  );

  it.each<ChequeKind>(['SETTLEMENT'])('%s: final once decided', (kind) => {
    expect(() =>
      assertChequeTransition(kind, PENDING, CLEARED, null, now),
    ).not.toThrow();
    expect(() =>
      assertChequeTransition(kind, PENDING, RETURNED, null, now),
    ).not.toThrow();
    for (const [from, to] of [
      [CLEARED, PENDING],
      [CLEARED, RETURNED],
      [RETURNED, PENDING],
      [RETURNED, CLEARED],
    ] as const)
      expect(() =>
        assertChequeTransition(kind, from, to, hoursAgo(1), now),
      ).toThrow(BadRequestException);
  });
});
