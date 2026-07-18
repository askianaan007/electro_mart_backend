import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ExpressAdapter } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import type express from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

export async function createApp(expressInstance?: express.Express) {
  const app = expressInstance
    ? await NestFactory.create<NestExpressApplication>(
        AppModule,
        new ExpressAdapter(expressInstance),
      )
    : await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');
  const isProduction = process.env.NODE_ENV === 'production';

  app.use(helmet());

  // Behind a reverse proxy (Render/Railway/Vercel/etc.), req.ip is the proxy's own
  // address for every request unless this is set — which would otherwise
  // make the login throttle (@Throttle on auth.controller.ts) either share
  // one bucket across every user, or silently do nothing.
  app.set('trust proxy', 1);

  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    app.enableCors({ origin: corsOrigin.split(',').map((o) => o.trim()) });
  } else if (isProduction) {
    throw new Error(
      'CORS_ORIGIN must be set in production — refusing to start with CORS wide open.',
    );
  } else {
    logger.warn(
      'CORS_ORIGIN is not set — allowing all origins. Set CORS_ORIGIN (comma-separated) in production.',
    );
    app.enableCors();
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  // The full API schema — including admin-only destructive routes like
  // clear-data and the activity-log wipe — is otherwise publicly browsable
  // with no auth gate. Fine for local/staging exploration, not for prod.
  if (!isProduction) {
    const config = new DocumentBuilder()
      .setTitle('Electro Mart API')
      .setDescription('ERP & Dealer Ordering System — Phase 1 API')
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'JWT',
          in: 'header',
        },
        'access-token',
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  return app;
}
