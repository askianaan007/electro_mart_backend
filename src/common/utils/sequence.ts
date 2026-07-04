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
