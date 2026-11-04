import './env';
import 'reflect-metadata';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ValidationError } from 'class-validator';

import { AppModule } from './app.module';
import { AppError } from './common/errors';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true });
  // vendor KYC and catalog photos arrive as compressed JPEG data URIs
  app.useBodyParser('json', { limit: '3mb' });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      // first message per field, in the app's error shape
      exceptionFactory: (errors: ValidationError[]) => {
        const fields = Object.fromEntries(errors.map((e) => [e.property, Object.values(e.constraints ?? {})[0] ?? 'Invalid value']));
        return new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION', Object.values(fields)[0], fields);
      },
    }),
  );
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  console.log(`Blissmark API on http://localhost:${port}/v1`);
}
bootstrap();
