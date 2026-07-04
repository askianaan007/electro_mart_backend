import { Prisma } from '@prisma/client';

const FK_VIOLATION_PATTERN = /foreign key constraint|violates.*constraint/i;

export function isForeignKeyViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2003';
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return FK_VIOLATION_PATTERN.test(error.message);
  }
  return false;
}
