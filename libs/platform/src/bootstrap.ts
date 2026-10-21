import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { integerSetting } from './integer-setting.js';
import {
  ApiProblemFilter,
  createApiProblem,
  parserProblem,
  requestIds,
  usesSharedJsonParser,
} from './http-problem.js';
import { ObserveInstrument } from './observe.js';
import {
  containsBigIntOrFloatMetadata,
  stringifyJsonWithBigInts,
} from './json-bigint.js';
import {
  parseJsonWithExactIntegers,
  parseJsonWithFloatMetadata,
} from './json-exact.js';
import { recordHttpRequest } from './http-metrics.js';

type DeclaredBodyLimit = {
  method: string;
  path: string;
  maxBytes: number;
  detail: string;
};

export async function bootstrapHttpService(
  rootModule: Type<unknown>,
  defaultPort: number,
  jsonLimit: string | number = integerSetting(
    process.env.MYOTA_MAX_BODY_BYTES,
    1024 ** 2,
  ),
  rawBodyRoutes: string[] = [],
  globalPrefixExclusions: { path: string; method: RequestMethod }[] = [],
  preserveBigIntJson = false,
  serviceId = 'myota-api',
  declaredBodyLimits: DeclaredBodyLimit[] = [],
  parseRequestBodies = true,
): Promise<INestApplication> {
  const app = await NestFactory.create(rootModule, {
    bodyParser: false,
    instrument: ObserveInstrument,
  });
  app.use(requestIds);
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.once('finish', () =>
      recordHttpRequest(serviceId, request, response.statusCode),
    );
    next();
  });
  if (
    ['identity-api', 'programmes-api', 'activity-api', 'geodata-api'].includes(
      serviceId,
    )
  )
    app.use((request: Request, response: Response, next: NextFunction) => {
      const originalEnd = response.end.bind(response);
      response.end = new Proxy(originalEnd, {
        apply(target, thisArg, argumentsList) {
          if (response.statusCode === 204) {
            response.setHeader(
              'Content-Type',
              'application/json; charset=utf-8',
            );
            response.setHeader('Content-Length', '0');
          }
          return Reflect.apply(target, thisArg, argumentsList);
        },
      });
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader(
        'Access-Control-Allow-Headers',
        serviceId === 'geodata-api'
          ? 'Content-Type, Authorization, Idempotency-Key, If-Match, X-Request-ID, X-Correlation-ID, traceparent, tracestate'
          : 'Content-Type, Authorization, Idempotency-Key, X-Request-ID, X-Correlation-ID, traceparent, tracestate',
      );
      response.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      );
      if (request.method !== 'OPTIONS') {
        next();
        return;
      }
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Content-Length', '0');
      response.statusCode = 204;
      response.end();
    });
  if (parseRequestBodies) {
    for (const { method, path, maxBytes, detail } of declaredBodyLimits)
      app.use((request: Request, response: Response, next: NextFunction) => {
        if (
          request.method !== method ||
          request.url?.split('?', 1)[0] !== path ||
          Number(request.get('content-length') ?? 0) <= maxBytes
        ) {
          next();
          return;
        }
        response
          .status(400)
          .type('application/json; charset=utf-8')
          .json(createApiProblem(request, response, 400, detail));
      });
    for (const route of rawBodyRoutes)
      app.use(
        route,
        express.raw({
          type: () => true,
          limit: integerSetting(
            process.env.MYOTA_UPLOAD_PART_MAX_BYTES,
            16 * 1024 * 1024,
          ),
        }),
      );
    app.use((request: Request, _response: Response, next: NextFunction) => {
      if (
        usesSharedJsonParser(
          request.method ?? '',
          request.url ?? '',
          request.headers['content-type'],
        )
      )
        request.headers['content-type'] = 'application/json; charset=utf-8';
      next();
    });
    app.use(
      express.json({
        limit: jsonLimit,
        inflate: false,
        strict: false,
        type: (request) =>
          usesSharedJsonParser(
            request.method ?? '',
            request.url ?? '',
            request.headers['content-type'],
          ),
        verify: (request, _response, buffer) => {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
            buffer,
          );
          if (decoded.charCodeAt(0) === 0xfeff)
            throw new Error('invalid JSON body');
          const path = request.url?.split('?', 1)[0] ?? '';
          if (
            [
              '/v1/geodata/proposals',
              '/v1/geodata/imports',
              '/v1/geodata/refresh-schedules',
              '/v1/programmes',
              '/v1/entity-types',
              '/v1/activations',
              '/v1/awards/evaluation-jobs',
              '/v1/identity/admin/roles',
              '/v1/identity/roles',
            ].includes(path) ||
            /^\/v1\/geodata\/imports\/[^/]+\/(?:candidates\/validate|process|processed)$/.test(
              path,
            ) ||
            /^\/v1\/geodata\/imports\/[^/]+\/processing-queues\/[^/]+\/redrive$/.test(
              path,
            ) ||
            /^\/v1\/geodata\/entities\/[^/]+(?:\/(?:location-enrichment-requests|reviews|categories|geometry))?$/.test(
              path,
            ) ||
            /^\/v1\/geodata\/conflation\/[^/]+\/resolve$/.test(path) ||
            /^\/v1\/geodata\/refresh-schedules\/[^/]+\/run$/.test(path) ||
            /^\/v1\/geodata\/entity-deletion-jobs(?:\/[^/]+\/confirm)?$/.test(
              path,
            ) ||
            /^\/v1\/qsos\/[^/]+\/corrections$/.test(path) ||
            /^\/v1\/programmes\/[^/]+\/entity-types$/.test(path) ||
            /^\/v1\/identity\/roles\/[^/]+$/.test(path) ||
            /^\/v1\/identity\/accounts\/[^/]+\/callsigns\/[^/]+\/evidence$/.test(
              path,
            )
          )
            Object.assign(request, { rawBody: buffer });
        },
      }),
    );
    app.use((request: Request, _response: Response, next: NextFunction) => {
      const path = request.url?.split('?', 1)[0] ?? '';
      const exactIntegerRequest =
        request.method === 'POST' &&
        ([
          '/v1/programmes',
          '/v1/geodata/refresh-schedules',
          '/v1/geodata/imports',
        ].includes(path) ||
          /^\/v1\/identity\/accounts\/[^/]+\/callsigns\/[^/]+\/evidence$/.test(
            path,
          ));
      const floatMetadataRequest =
        (request.method === 'POST' &&
          ([
            '/v1/activations',
            '/v1/awards/evaluation-jobs',
            '/v1/entity-types',
            '/v1/identity/admin/roles',
            '/v1/identity/roles',
            '/v1/qso-ingestions',
          ].includes(path) ||
            /^\/v1\/programmes\/[^/]+\/entity-types$/.test(path) ||
            /^\/v1\/activations\/[^/]+\/qsos$/.test(path))) ||
        (request.method === 'PATCH' &&
          /^\/v1\/geodata\/entities\/[^/]+$/.test(path)) ||
        (request.method === 'POST' &&
          (/^\/v1\/qsos\/[^/]+\/corrections$/.test(path) ||
            /^\/v1\/geodata\/entity-deletion-jobs\/[^/]+\/confirm$/.test(
              path,
            ))) ||
        (request.method === 'PATCH' &&
          /^\/v1\/identity\/roles\/[^/]+$/.test(path));
      if (
        (exactIntegerRequest || floatMetadataRequest) &&
        Buffer.isBuffer((request as Request & { rawBody?: Buffer }).rawBody)
      )
        request.body = exactIntegerRequest
          ? parseJsonWithExactIntegers(
              (request as Request & { rawBody: Buffer }).rawBody.toString(
                'utf8',
              ),
            )
          : parseJsonWithFloatMetadata(
              (request as Request & { rawBody: Buffer }).rawBody.toString(
                'utf8',
              ),
            );
      next();
    });
    app.use((request: Request, _response: Response, next: NextFunction) => {
      if (request.body === undefined) request.body = {};
      next();
    });
    app.use((request: Request, response: Response, next: NextFunction) => {
      const body = request.body as unknown;
      if (
        Buffer.isBuffer(body) ||
        (body !== null && typeof body === 'object' && !Array.isArray(body))
      ) {
        next();
        return;
      }
      response
        .status(400)
        .type('application/json; charset=utf-8')
        .json(
          createApiProblem(
            request,
            response,
            400,
            'JSON body must be an object',
          ),
        );
    });
  }
  if (preserveBigIntJson || serviceId === 'geodata-api')
    app.use((_request: Request, response: Response, next: NextFunction) => {
      const originalJson = response.json.bind(response);
      response.json = (body: unknown) => {
        if (serviceId === 'geodata-api' && isRecordBody(body)) {
          const version = body.version;
          if (
            typeof version === 'bigint' ||
            (typeof version === 'number' && Number.isInteger(version))
          )
            response.setHeader('ETag', `"${version}"`);
        }
        if (!preserveBigIntJson || !containsBigIntOrFloatMetadata(body))
          return originalJson(body);
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
      { path: 'metrics', method: RequestMethod.GET },
      ...globalPrefixExclusions,
    ],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new ApiProblemFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? defaultPort), '0.0.0.0');
  return app;
}

function isRecordBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
