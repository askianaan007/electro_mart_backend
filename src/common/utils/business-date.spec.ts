import {
  assertNotFutureBusinessDate,
  businessDateOf,
  businessDateRange,
  startOfBusinessDay,
  startOfBusinessMonth,
} from './business-date';

describe('business dates (Asia/Colombo, UTC+05:30)', () => {
  it('keeps date-only strings as the Colombo date', () => {
    expect(businessDateOf('2026-10-31')).toBe('2026-10-31');
  });

  it('maps instants to the Colombo date across the 18:30Z boundary', () => {
    expect(businessDateOf('2026-10-30T18:29:59.999Z')).toBe('2026-10-30');
    expect(businessDateOf('2026-10-30T18:30:00.000Z')).toBe('2026-10-31');
    // A date picked in a Colombo browser and sent via toISOString().
    expect(businessDateOf(new Date('2026-10-31T00:00:00+05:30'))).toBe(
      '2026-10-31',
    );
  });

  it('starts the day at 00:00 Colombo', () => {
    expect(startOfBusinessDay('2026-10-31').toISOString()).toBe(
      '2026-10-30T18:30:00.000Z',
    );
  });

  it('turns an inclusive from/to filter into whole-day [gte, lt)', () => {
    const range = businessDateRange('2026-10-01', '2026-10-31')!;
    expect(range.gte!.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(range.lt!.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    // 23:59 Colombo on the "to" day is inside; 00:00 the next day is not.
    expect(new Date('2026-10-31T23:59:00+05:30') < range.lt!).toBe(true);
    expect(new Date('2026-11-01T00:00:00+05:30') < range.lt!).toBe(false);
    expect(businessDateRange()).toBeUndefined();
    expect(businessDateRange(undefined, '2026-10-31')).toEqual({
      lt: new Date('2026-10-31T18:30:00.000Z'),
    });
  });

  it('computes Colombo month starts, including just after midnight on the 1st', () => {
    // 00:10 Colombo on 1 Nov is still 31 Oct in UTC.
    const now = new Date('2026-10-31T18:40:00Z');
    expect(startOfBusinessMonth(now).toISOString()).toBe(
      '2026-10-31T18:30:00.000Z',
    );
    expect(startOfBusinessMonth(now, -1).toISOString()).toBe(
      '2026-09-30T18:30:00.000Z',
    );
    expect(
      startOfBusinessMonth(new Date('2026-01-15T00:00:00Z'), -1).toISOString(),
    ).toBe('2025-11-30T18:30:00.000Z');
  });

  it('rejects posting dates after today in Colombo', () => {
    const now = new Date('2026-10-19T19:00:00Z'); // 00:30 on 20 Oct in Colombo
    expect(() =>
      assertNotFutureBusinessDate('2026-10-20', 'Payment date', now),
    ).not.toThrow();
    expect(() =>
      assertNotFutureBusinessDate('2026-10-21', 'Payment date', now),
    ).toThrow('Payment date cannot be in the future');
    expect(() => assertNotFutureBusinessDate('garbage', 'x', now)).toThrow(
      /Invalid date/,
    );
  });
});
