import { Prisma } from '@prisma/client';
import {
  buildTimeline,
  chequeKeyOf,
  displayChequeNumber,
  monthRange,
  monthsBetween,
  nameKey,
  summarise,
  toDateOnly,
} from './cheque-flow.utils';

const D = (v: number) => new Prisma.Decimal(v);

describe('cheque-flow utils', () => {
  it('keeps the cheque number as text but matches spreadsheet variants', () => {
    expect(displayChequeNumber('#091942 ')).toBe('091942');
    expect(displayChequeNumber('000718')).toBe('000718');
    expect(displayChequeNumber('  ')).toBeNull();
    expect(chequeKeyOf('#091942 ')).toBe('91942');
    expect(chequeKeyOf('091942')).toBe(chequeKeyOf('91942'));
    expect(chequeKeyOf('000')).toBe('0');
    expect(chequeKeyOf(null)).toBe('');
  });

  it('matches bank and party names regardless of case and spacing', () => {
    expect(nameKey('Commercial ')).toBe(nameKey('commercial'));
    expect(nameKey('Amana  Bank')).toBe('amana bank');
  });

  it('parses calendar dates and refuses impossible ones', () => {
    expect(toDateOnly('2026-10-31', 'x').toISOString()).toBe(
      '2026-10-31T00:00:00.000Z',
    );
    // A Colombo midnight sent as UTC (18:30 the day before) is that Colombo day.
    expect(
      toDateOnly('2026-10-30T18:30:00.000Z', 'x').toISOString().slice(0, 10),
    ).toBe('2026-10-31');
    expect(() => toDateOnly('2026-02-30', 'x')).toThrow();
    expect(() => toDateOnly('nope', 'x')).toThrow();
    expect(() => toDateOnly('1999-12-31', 'x')).toThrow();
  });

  it('builds month ranges', () => {
    expect(monthRange('2026-12')).toEqual({
      gte: new Date('2026-12-01T00:00:00.000Z'),
      lt: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(monthsBetween('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
    expect(() => monthRange('2026-13')).toThrow();
  });

  it('keeps bounced and cancelled out of total, pending and cleared', () => {
    const row = (
      direction: 'RECEIVABLE' | 'PAYABLE',
      status: string,
      amount: number,
      n = 1,
    ) => ({
      direction,
      status: status as never,
      _sum: { amount: D(amount) },
      _count: { _all: n },
    });
    const s = summarise([
      row('RECEIVABLE', 'PENDING', 1000.1, 2),
      row('RECEIVABLE', 'CLEARED', 500.2),
      row('RECEIVABLE', 'BOUNCED', 300),
      row('RECEIVABLE', 'CANCELLED', 50),
      row('PAYABLE', 'PENDING', 1500),
      row('PAYABLE', 'CLEARED', 100),
    ]);
    expect(s.receivable).toMatchObject({
      total: 1500.3,
      pending: 1000.1,
      cleared: 500.2,
      bounced: 300,
      cancelled: 50,
      count: 3,
    });
    expect(s.payable.total).toBe(1600);
    expect(s.netPending).toBe(-499.9);
  });

  it('flags days when payments fall before receipts', () => {
    const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
    const t = buildTimeline([
      {
        direction: 'RECEIVABLE',
        chequeDate: day('2026-11-20'),
        _sum: { amount: D(500) },
      },
      {
        direction: 'PAYABLE',
        chequeDate: day('2026-11-05'),
        _sum: { amount: D(300) },
      },
      {
        direction: 'RECEIVABLE',
        chequeDate: day('2026-11-05'),
        _sum: { amount: D(100) },
      },
    ]);
    expect(t).toEqual([
      {
        date: '2026-11-05',
        receipts: 100,
        payments: 300,
        net: -200,
        cumulative: -200,
        shortfall: true,
      },
      {
        date: '2026-11-20',
        receipts: 500,
        payments: 0,
        net: 500,
        cumulative: 300,
        shortfall: false,
      },
    ]);
  });
});
