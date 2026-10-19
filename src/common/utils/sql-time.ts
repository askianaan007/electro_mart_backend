import { Prisma } from '@prisma/client';

/**
 * An instant as a UTC `timestamp` for raw SQL comparisons. Prisma's
 * DateTime columns are `timestamp(3)` holding UTC wall-clock time, but a
 * bare Date parameter in $queryRaw binds as `timestamptz`, which makes
 * Postgres reinterpret the column in the session's TimeZone — correct only
 * while that happens to be UTC. Converting the parameter instead makes the
 * comparison independent of the server/session setting. (Prisma's own query
 * builder, used everywhere outside raw SQL, already does the equivalent.)
 */
export function sqlUtc(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}
