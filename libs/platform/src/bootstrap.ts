import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import express from 'express';
import { integerSetting } from './integer-setting.js';
import { ApiProblemFilter, parserProblem, requestIds } from './http-problem.js';
import { ObserveInstrument } from './observe.js';

export async function bootstrapHttpService(
  rootModule: Type<unknown>,
  defaultPort: number,
  jsonLimit: string | number = integerSetting(
    process.env.MYOTA_MAX_BODY_BYTES,
    1024 * 1024,
  ),
  rawBodyRoutes: string[] = [],
  globalPrefixExclusions: { path: string; method: RequestMethod }[] = [],
): Promise<INestApplication> {
  const app = await NestFactory.create(rootModule, {
    bodyParser: false,
    instrument: ObserveInstrument,
  });
  app.use(requestIds);
  for (const route of rawBodyRoutes)
    app.use(
      route,
      express.raw({ type: 'application/octet-stream', limit: '16mb' }),
    );
  app.use(
    express.json({
      limit: jsonLimit,
      verify: (request, _response, buffer) => {
        if (
          ['/v1/geodata/proposals', '/v1/geodata/imports'].includes(
            request.url?.split('?', 1)[0] ?? '',
          ) ||
          /^\/v1\/geodata\/imports\/[^/]+\/candidates\/validate$/.test(
            request.url?.split('?', 1)[0] ?? '',
          ) ||
          /^\/v1\/geodata\/imports\/[^/]+\/process$/.test(
            request.url?.split('?', 1)[0] ?? '',
          )
        )
          Object.assign(request, { rawBody: buffer });
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: jsonLimit }));
  app.use(parserProblem);
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
      ...globalPrefixExclusions,
    ],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new ApiProblemFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? defaultPort), '0.0.0.0');
  return app;
}
