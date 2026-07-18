import { Logger } from '@nestjs/common';
import { createApp } from './create-app';

async function bootstrap() {
  const app = await createApp();
  const logger = new Logger('Bootstrap');
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);
}

void bootstrap();
