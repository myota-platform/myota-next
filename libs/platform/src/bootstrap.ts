import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';

export async function bootstrapHttpService(
  rootModule: Type<unknown>,
  defaultPort: number,
): Promise<INestApplication> {
  const app = await NestFactory.create(rootModule);
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? defaultPort), '0.0.0.0');
  return app;
}
