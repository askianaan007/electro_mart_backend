import { ConflictException } from '@nestjs/common';

/**
 * How far back an identical submission counts as a probable double
 * submission (double click, network retry, two open tabs) rather than a
 * second real payment (LC-04).
 */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export function duplicateWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - DUPLICATE_WINDOW_MS);
}

/**
 * Thrown when an identical entry was recorded moments ago. The client shows
 * the message and may resend with `confirmDuplicate: true` when it really is
 * a second payment — identical partial payments stay possible, they just
 * can't happen by accident. Callers must check inside the same transaction
 * that holds the counterparty's row lock, so concurrent duplicates serialize
 * and the second one sees the first.
 */
export class PossibleDuplicateException extends ConflictException {
  constructor(what: string, existingId: string) {
    super({
      error: 'POSSIBLE_DUPLICATE',
      message: `An identical ${what} was recorded in the last ${DUPLICATE_WINDOW_MS / 60000} minutes (${existingId}). If this really is a second ${what}, confirm and submit again.`,
    });
  }
}
