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
 * Realigns a counter with what's actually in the table — for after a bulk
 * clear (e.g. clearing a dealer's data) leaves the counter stuck high with
 * no records left to justify it. Sets the counter to the highest serial
 * found among `sequenceValues`, or 0 if there are none, so the next
 * `nextSequenceNumber` call issues exactly one past the current max —
 * never colliding with an existing number, never skipping unnecessarily.
 */
export async function resetSequenceCounter(
  tx: TransactionClient,
  key: string,
  sequenceValues: string[],
): Promise<number> {
  const maxSerial = sequenceValues.reduce((max, value) => {
    const match = value.match(/-(\d+)$/);
    const parsed = match ? parseInt(match[1], 10) : 0;
    return Math.max(max, parsed);
  }, 0);

  await tx.counter.upsert({
    where: { key },
    create: { key, value: maxSerial },
    update: { value: maxSerial },
  });

  return maxSerial;
}
