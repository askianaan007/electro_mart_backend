import express from 'express';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createApp } from '../src/create-app';

// Reused across warm invocations of the same Lambda instance so we don't
// re-run Nest's full DI bootstrap (and re-open a Prisma connection) on
// every request.
let cachedServer: express.Express | undefined;

async function bootstrapServer(): Promise<express.Express> {
  if (!cachedServer) {
    const expressInstance = express();
    const app = await createApp(expressInstance);
    await app.init();
    cachedServer = expressInstance;
  }
  return cachedServer;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const server = await bootstrapServer();
  server(req, res);
}
