import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Write-based tests run only against a database proven to be a disposable
 * test database — never because a URL merely "looks" local. All of these must
 * hold, or nothing runs:
 *
 *  1. TEST_DATABASE_URL is set and points at localhost / 127.0.0.1 / ::1.
 *  2. Its host:port/database differs from DATABASE_URL / DIRECT_URL in both
 *     the environment and the repo's .env (the app's real target).
 *  3. The database contains test_isolation.marker with a row whose token
 *     equals TEST_DB_ISOLATION_TOKEN. Only someone who created that database
 *     for testing put it there; a shared/production database never has it.
 *
 * Create one with: CREATE DATABASE x_test; then in it
 *   CREATE SCHEMA test_isolation;
 *   CREATE TABLE test_isolation.marker(token text primary key);
 *   INSERT INTO test_isolation.marker VALUES ('<your token>');
 * and apply migrations to it (`prisma migrate deploy` with DATABASE_URL set
 * to it). See test/README.md.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function target(url: string) {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}/${u.pathname.replace(/^\//, '')}`;
}

function envFileUrls(): string[] {
  const file = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) =>
      line.match(/^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*"?([^"\s]+)"?/),
    )
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => m[2]);
}

export async function verifyIsolatedTestDatabase(): Promise<string> {
  const url = process.env.TEST_DATABASE_URL;
  const token = process.env.TEST_DB_ISOLATION_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Refusing to run: TEST_DATABASE_URL and TEST_DB_ISOLATION_TOKEN must be set (see test/README.md).',
    );
  }
  const { hostname } = new URL(url);
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL host "${hostname}" is not local.`,
    );
  }
  const appTargets = [
    process.env.DATABASE_URL,
    process.env.DIRECT_URL,
    ...envFileUrls(),
  ].filter((u): u is string => !!u && u !== url);
  for (const other of appTargets) {
    if (target(other) === target(url)) {
      throw new Error(
        'Refusing to run: TEST_DATABASE_URL is the same database the application is configured to use.',
      );
    }
  }

  const client = new PrismaClient({ datasourceUrl: url });
  try {
    const rows = await client
      .$queryRawUnsafe<{ token: string }[]>(
        'SELECT token FROM test_isolation.marker',
      )
      .catch(() => [] as { token: string }[]);
    if (!rows.some((r) => r.token === token)) {
      throw new Error(
        'Refusing to run: the test database has no matching test_isolation.marker token.',
      );
    }
  } finally {
    await client.$disconnect();
  }
  return url;
}
