import { BadRequestException } from '@nestjs/common';

/**
 * Business dates are Sri Lankan calendar dates. Asia/Colombo is a fixed
 * UTC+05:30 with no daylight saving, so day boundaries are a constant offset
 * from UTC — no tz database needed, and the result never depends on the
 * server's own time zone (Vercel runs in UTC, a dev laptop may not).
 *
 * Accepts either a date-only string ("2026-10-20", taken as that Colombo
 * date) or any instant (an ISO timestamp or Date, mapped to the Colombo date
 * it falls on). The frontend sends both shapes — a picked date serialized
 * with toISOString() from a Colombo browser arrives as the previous UTC day
 * at 18:30Z, which still maps to the intended Colombo date here.
 */
export const BUSINESS_TIME_ZONE = 'Asia/Colombo';
const OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type DateInput = string | Date;

/** The Colombo calendar date (YYYY-MM-DD) of `input`. */
export function businessDateOf(input: DateInput): string {
  if (typeof input === 'string' && DATE_ONLY.test(input)) return input;
  const time = new Date(input).getTime();
  if (Number.isNaN(time)) {
    throw new BadRequestException(`Invalid date: ${String(input)}`);
  }
  return new Date(time + OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 Colombo time on `input`'s business date, as a UTC instant. */
export function startOfBusinessDay(input: DateInput): Date {
  return new Date(`${businessDateOf(input)}T00:00:00.000+05:30`);
}

/** 00:00 Colombo time on the day after `input`'s business date. */
export function startOfNextBusinessDay(input: DateInput): Date {
  return new Date(startOfBusinessDay(input).getTime() + DAY_MS);
}

/** First instant of the Colombo calendar month `monthOffset` months from `now`'s. */
export function startOfBusinessMonth(now: Date = new Date(), monthOffset = 0) {
  const [year, month] = businessDateOf(now).split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  return startOfBusinessDay(target.toISOString().slice(0, 10));
}

export function businessToday(now: Date = new Date()): string {
  return businessDateOf(now);
}

/**
 * Inclusive from/to date filter → half-open [gte, lt) instants covering
 * whole Colombo days. Use for every user-facing date-range filter so "to
 * 31 Oct" always includes all of 31 Oct.
 */
export function businessDateRange(
  from?: DateInput,
  to?: DateInput,
): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from && { gte: startOfBusinessDay(from) }),
    ...(to && { lt: startOfNextBusinessDay(to) }),
  };
}

/**
 * Posting dates (payment, expense, investment, refund, adjustment) record
 * when money actually moved, so they can't be later than today in Colombo.
 * A post-dated cheque is still allowed — its chequeDate is not a posting date.
 */
export function assertNotFutureBusinessDate(
  input: DateInput,
  label: string,
  now: Date = new Date(),
) {
  if (businessDateOf(input) > businessToday(now)) {
    throw new BadRequestException(`${label} cannot be in the future`);
  }
}
