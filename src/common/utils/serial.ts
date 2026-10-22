import { BadRequestException } from '@nestjs/common';

/**
 * Serial-number normalization (Bar_code_plan.md §4.1). The frontend mirrors
 * this in src/lib/serial.ts so the scan dialog can flag problems instantly,
 * but this is the copy that counts.
 */
export const SERIAL_MIN_LENGTH = 3;
export const SERIAL_MAX_LENGTH = 64;
export const SERIALS_PER_REQUEST = 500;

// Printable characters a serial label realistically carries.
const ALLOWED = /^[A-Za-z0-9\-_/.:#+]+$/;
// Scanners often append CR/LF/TAB or GS (0x1d) group separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export interface NormalizedSerial {
  /** As scanned, trimmed — shown to people and printed. */
  serialNumber: string;
  /** Uppercase, no whitespace — uniqueness and lookup. */
  serialKey: string;
}

export type SerialFormatProblem =
  'EMPTY' | 'TOO_SHORT' | 'TOO_LONG' | 'BAD_CHARACTERS';

export function checkSerialFormat(
  raw: string,
):
  | { ok: true; value: NormalizedSerial }
  | { ok: false; problem: SerialFormatProblem } {
  const serialNumber = String(raw ?? '')
    .replace(CONTROL_CHARS, '')
    .trim()
    .replace(/\s+/g, ' ');
  const serialKey = serialNumber.replace(/\s+/g, '').toUpperCase();
  if (!serialKey) return { ok: false, problem: 'EMPTY' };
  if (serialKey.length < SERIAL_MIN_LENGTH)
    return { ok: false, problem: 'TOO_SHORT' };
  if (
    serialKey.length > SERIAL_MAX_LENGTH ||
    serialNumber.length > SERIAL_MAX_LENGTH
  ) {
    return { ok: false, problem: 'TOO_LONG' };
  }
  if (!ALLOWED.test(serialKey)) return { ok: false, problem: 'BAD_CHARACTERS' };
  return { ok: true, value: { serialNumber, serialKey } };
}

const PROBLEM_TEXT: Record<SerialFormatProblem, string> = {
  EMPTY: 'is empty',
  TOO_SHORT: `is shorter than ${SERIAL_MIN_LENGTH} characters`,
  TOO_LONG: `is longer than ${SERIAL_MAX_LENGTH} characters`,
  BAD_CHARACTERS: 'contains characters a serial label cannot have',
};

export function serialProblemText(problem: SerialFormatProblem) {
  return PROBLEM_TEXT[problem];
}

/** Normalizes or throws a 400 naming the bad value. */
export function normalizeSerial(raw: string): NormalizedSerial {
  const result = checkSerialFormat(raw);
  if (!result.ok) {
    throw new BadRequestException(
      `Serial "${String(raw ?? '').slice(0, 80)}" ${serialProblemText(result.problem)}`,
    );
  }
  return result.value;
}

/** Normalizes a list and rejects duplicates within it. */
export function normalizeSerialList(raws: string[]): NormalizedSerial[] {
  if (raws.length > SERIALS_PER_REQUEST) {
    throw new BadRequestException(
      `At most ${SERIALS_PER_REQUEST} serials can be sent at once`,
    );
  }
  const seen = new Set<string>();
  return raws.map((raw) => {
    const value = normalizeSerial(raw);
    if (seen.has(value.serialKey)) {
      throw new BadRequestException(
        `Serial ${value.serialNumber} appears more than once in this request`,
      );
    }
    seen.add(value.serialKey);
    return value;
  });
}

/** Adds whole months, clamping to the last day of the target month. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}
