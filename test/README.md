# Backend tests

| Command                    | What runs                                                                  | Database                            |
| -------------------------- | -------------------------------------------------------------------------- | ----------------------------------- |
| `npm test`                 | Unit specs (`src/**/*.spec.ts`)                                            | none (mocked)                       |
| `npm run test:integration` | API + service integration specs (`test/**/*.int-spec.ts`, `*.e2e-spec.ts`) | a verified disposable test database |
| `npm run test:e2e`         | same as `test:integration`                                                 | same                                |

## The integration database

Integration tests **write** to the database: they truncate every table
before each scenario. They refuse to start unless the target is proven to be a
disposable test database (`test/support/isolated-db.ts`):

1. `TEST_DATABASE_URL` and `TEST_DB_ISOLATION_TOKEN` must both be set.
2. The URL's host must be `localhost`, `127.0.0.1` or `::1`.
3. It must not be the same database as `DATABASE_URL` / `DIRECT_URL` in the
   environment or in `.env`.
4. The database must contain `test_isolation.marker` with a row equal to
   `TEST_DB_ISOLATION_TOKEN`. The app's own connection checks this again
   before every truncate.

The app is then pointed at `TEST_DATABASE_URL` only. SMTP is blanked, and
JWT and Cloudinary get dummy values.

### One-time setup (local Postgres)

```bash
createdb electro_mart_test
psql electro_mart_test <<'SQL'
CREATE SCHEMA test_isolation;
CREATE TABLE test_isolation.marker (token text PRIMARY KEY);
INSERT INTO test_isolation.marker VALUES ('pick-a-random-token');
SQL
DATABASE_URL=postgresql://localhost/electro_mart_test \
DIRECT_URL=postgresql://localhost/electro_mart_test \
  npx prisma migrate deploy
```

Never run `migrate deploy` with your real `DATABASE_URL` while doing this.

### Run

```bash
TEST_DATABASE_URL=postgresql://localhost/electro_mart_test \
TEST_DB_ISOLATION_TOKEN=pick-a-random-token \
  npm run test:integration
```
