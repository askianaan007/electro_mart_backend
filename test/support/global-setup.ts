import { verifyIsolatedTestDatabase } from './isolated-db';

/** Jest globalSetup: abort the whole run unless the target DB is a verified disposable test DB. */
export default async function globalSetup() {
  await verifyIsolatedTestDatabase();
}
