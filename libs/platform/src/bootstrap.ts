import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { integerSetting } from './integer-setting.js';
import { ApiProblemFilter, parserProblem, requestIds } from './http-problem.js';
import { ObserveInstrument } from './observe.js';
import { containsBigInt, stringifyJsonWithBigInts } from './json-bigint.js';
import { parseJsonWithExactIntegers } from './json-exact.js';

export async function bootstrapHttpService(
  rootModule: Type<unknown>,
  defaultPort: number,
  jsonLimit: string | number = integerSetting(
    process.env.MYOTA_MAX_BODY_BYTES,
    1024 * 1024,
  ),
  rawBodyRoutes: string[] = [],
  globalPrefixExclusions: { path: string; method: RequestMethod }[] = [],
  preserveBigIntJson = false,
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
          ) ||
          /^\/v1\/geodata\/imports\/[^/]+\/processed$/.test(
            request.url?.split('?', 1)[0] ?? '',
          ) ||
          /^\/v1\/geodata\/imports\/[^/]+\/processing-queues\/[^/]+\/redrive$/.test(
            request.url?.split('?', 1)[0] ?? '',
          ) ||
          /^\/v1\/geodata\/entities\/[^/]+(?:\/(?:location-enrichment-requests|reviews|categories|geometry))?$/.test(
            request.url?.split('?', 1)[0] ?? '',
          ) ||
          /^\/v1\/geodata\/conflation\/[^/]+\/resolve$/.test(
            request.url?.split('?', 1)[0] ?? '',
          ) ||
          /^\/v1\/geodata\/refresh-schedules\/[^/]+\/run$/.test(
            request.url?.split('?', 1)[0] ?? '',
          ) ||
          /^\/v1\/geodata\/entity-deletion-jobs(?:\/[^/]+\/confirm)?$/.test(
            request.url?.split('?', 1)[0] ?? '',
          ) ||
          request.url?.split('?', 1)[0] === '/v1/geodata/refresh-schedules' ||
          request.url?.split('?', 1)[0] === '/v1/programmes'
        )
          Object.assign(request, { rawBody: buffer });
      },
    }),
  );
  app.use((request: Request, _response: Response, next: NextFunction) => {
    if (
      request.method === 'POST' &&
      request.url?.split('?', 1)[0] === '/v1/programmes' &&
      Buffer.isBuffer((request as Request & { rawBody?: Buffer }).rawBody)
    )
      request.body = parseJsonWithExactIntegers(
        (request as Request & { rawBody: Buffer }).rawBody.toString('utf8'),
      );
    next();
  });
  app.use(express.urlencoded({ extended: true, limit: jsonLimit }));
  if (preserveBigIntJson)
    app.use((_request: Request, response: Response, next: NextFunction) => {
      const originalJson = response.json.bind(response);
      response.json = (body: unknown) => {
        if (!containsBigInt(body)) return originalJson(body);
        const serialized = stringifyJsonWithBigInts(body);
        response.type('application/json');
        return response.send(serialized ?? 'null');
      };
      next();
    });
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
