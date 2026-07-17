import { Prisma } from '@prisma/client';

type TransactionClient = Prisma.TransactionClient;

export async function nextSequenceNumber(
  tx: TransactionClient,
  key: string,
  prefix: string,
  padding = 5,
): Promise<string> {
  const counter = await tx.counter.upsert({
    where: { key },
    create: { key, value: 1 },
    update: { value: { increment: 1 } },
  });

  const year = new Date().getFullYear();
  const serial = String(counter.value).padStart(padding, '0');
  return `${prefix}-${year}-${serial}`;
}

/**
 * True if `sequenceValue` is the number the counter most recently handed
 * out. Based on the counter's issuance order, not createdAt — records can
 * be backdated (e.g. migrating a historical sale), so createdAt is not a
 * reliable stand-in for "was this issued last."
 */
export async function isLatestSequenceNumber(
  tx: TransactionClient,
  key: string,
  sequenceValue: string,
  padding = 5,
): Promise<boolean> {
  const counter = await tx.counter.findUnique({ where: { key } });
  if (!counter) return false;

  const serial = String(counter.value).padStart(padding, '0');
  return sequenceValue.endsWith(serial);
}

/**
 * Rolls a sequence counter back by one, but only if `sequenceValue` is the
 * number the counter most recently handed out — i.e. this is the newest
 * record in the sequence and reclaiming it can't collide with or
 * un-sequence anything else. Silently no-ops otherwise, so callers can use
 * this as a best-effort "give the number back" without needing to gate
 * deletion on it.
 */
export async function releaseSequenceNumberIfLatest(
  tx: TransactionClient,
  key: string,
  sequenceValue: string,
  padding = 5,
): Promise<boolean> {
  if (!(await isLatestSequenceNumber(tx, key, sequenceValue, padding))) {
    return false;
  }

  await tx.counter.update({ where: { key }, data: { value: { decrement: 1 } } });
  return true;
}
