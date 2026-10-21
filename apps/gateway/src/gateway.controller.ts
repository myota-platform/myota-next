import {
  All,
  Controller,
  Get,
  Headers,
  Logger,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { renderHttpRequestMetrics } from '@app/platform/http-metrics.js';
import {
  MYOTA_CLIENT_ADDRESS_HEADER,
  MYOTA_CLIENT_ADDRESS_SIGNATURE_HEADER,
  signClientAddress,
  createApiProblem,
} from '@app/platform';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';

const ROUTES: Array<[string, string]> = [
  ['/v1/identity/', 'IDENTITY'],
  ['/v1/entity-types', 'PROGRAMMES'],
  ['/v1/programmes', 'PROGRAMMES'],
  ['/v1/geodata/', 'GEODATA'],
  ['/v1/activity/work-jobs', 'ACTIVITY'],
  ['/v1/activations', 'ACTIVITY'],
  ['/v1/awards', 'ACTIVITY'],
  ['/v1/qso-ingestions', 'ACTIVITY'],
  ['/v1/adif/', 'ACTIVITY'],
  ['/v1/qsos', 'ACTIVITY'],
  ['/v1/statistics', 'ACTIVITY'],
  ['/v1/public/programmes/', 'PROGRAMMES'],
  ['/v1/public/', 'ACTIVITY'],
  ['/v1/notifications', 'ACTIVITY'],
];

const SAFE_RESPONSE_HEADERS = [
  'api-version',
  'cache-control',
  'content-disposition',
  'content-type',
  'deprecation',
  'etag',
  'traceparent',
  'tracestate',
  'x-trace-id',
  'x-correlation-id',
  'x-request-id',
  'sunset',
];

@Controller()
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);
  private readonly requests = new Map<string, number>();

  @Get('_internal/grafana/auth')
  async grafanaAuth(
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (
      !authorization?.startsWith('Bearer ') ||
      !trimPythonWhitespace(authorization.slice(7))
    )
      return this.grafanaError(
        request,
        response,
        401,
        'authentication_required',
      );

    const identityBase =
      process.env.MYOTA_IDENTITY_URL ?? 'http://identity:8001';
    let account: Record<string, unknown>;
    try {
      const result = await fetch(
        `${identityBase.replace(/\/$/, '')}/v1/identity/me`,
        {
          headers: { authorization },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!result.ok) {
        return this.grafanaError(
          request,
          response,
          [400, 401, 403].includes(result.status) ? 401 : 503,
          'identity_unavailable',
        );
      }
      const payload: unknown = await result.json();
      if (!isRecord(payload))
        return this.grafanaError(
          request,
          response,
          401,
          'authentication_required',
        );
      account = payload;
    } catch {
      return this.grafanaError(request, response, 503, 'identity_unavailable');
    }

    const accountId = typeof account.id === 'string' ? account.id : '';
    if (!accountId)
      return this.grafanaError(
        request,
        response,
        401,
        'authentication_required',
      );
    const roles = Array.isArray(account.roles) ? account.roles : [];
    const scopes = Array.isArray(account.scopes) ? account.scopes : [];
    const isGlobalOperator = roles.some((item) => {
      const role = isRecord(item) ? item.role : item;
      return role === 'GLOBAL_OPERATOR' || role === 'GLOBAL_ADMIN';
    });
    const canView = scopes.some(
      (scope) => scope === '*' || scope === 'observability.view',
    );
    if (!isGlobalOperator && !canView)
      return this.grafanaError(request, response, 403, 'forbidden');

    const values: Record<string, string> = {
      'X-MyOTA-Grafana-User': `myota:${accountId}`,
      'X-MyOTA-Grafana-Name':
        typeof account.displayName === 'string'
          ? account.displayName
          : accountId,
      'X-MyOTA-Grafana-Email':
        typeof account.email === 'string' ? account.email : '',
      'X-MyOTA-Grafana-Role': isGlobalOperator ? 'Editor' : 'Viewer',
    };
    if (Object.values(values).some((value) => /[\r\n]/.test(value)))
      return this.grafanaError(request, response, 503, 'identity_unavailable');
    for (const [name, value] of Object.entries(values))
      response.setHeader(name, value);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    this.count(request, '/_internal/grafana/auth', 200);
    response.status(200).send('{}');
  }

  @Get('metrics')
  metrics(@Res() response: Response) {
    const lines = [
      '# HELP myota_gateway_requests_total Total proxied gateway requests.',
      '# TYPE myota_gateway_requests_total counter',
      ...[...this.requests.entries()].map(
        ([labels, count]) => `myota_gateway_requests_total{${labels}} ${count}`,
      ),
    ];
    response
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(`${lines.join('\n')}\n${renderHttpRequestMetrics()}`);
  }

  @All('*path')
  async proxy(@Req() request: Request, @Res() response: Response) {
    const urlPath = request.originalUrl.split('?', 1)[0];
    if (
      urlPath === '/v1/identity/internal' ||
      urlPath.startsWith('/v1/identity/internal/')
    )
      return this.finish(response, request, 404, 'no route for ' + urlPath);
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, If-Match, X-Request-ID, X-Correlation-ID, traceparent, tracestate',
      );
      response.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      );
      return this.finish(response, request, 204);
    }
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method))
      return this.finish(response, request, 404, `no route for ${urlPath}`);

    const route = ROUTES.find(([prefix]) => urlPath.startsWith(prefix));
    if (!route)
      return this.finish(response, request, 404, `no route for ${urlPath}`);
    const [prefix, service] = route;
    const servicePath = `${process.env[`MYOTA_${service}_URL`] ?? defaultServiceUrl(service)}`;
    let target: URL;
    try {
      const base = new URL(servicePath);
      target = new URL(
        `${base.pathname.replace(/\/$/, '')}${request.originalUrl}`,
        base.origin,
      );
    } catch {
      this.logger.error(`Invalid ${service} upstream URL`);
      return this.finish(
        response,
        request,
        503,
        'upstream service unavailable',
      );
    }

    const headers = new globalThis.Headers();
    for (const name of [
      'accept',
      'authorization',
      'content-type',
      'idempotency-key',
      'if-match',
      'user-agent',
      'x-correlation-id',
      'x-request-id',
      'traceparent',
      'tracestate',
    ]) {
      const value = request.header(name);
      if (value) headers.set(name, value);
    }
    // Replace caller-supplied values with the signed address observed by Gateway.
    const clientAddress = request.socket.remoteAddress;
    const signingKey = process.env.MYOTA_AUTH_SIGNING_KEY;
    if (clientAddress && signingKey) {
      headers.set(MYOTA_CLIENT_ADDRESS_HEADER, clientAddress);
      headers.set(
        MYOTA_CLIENT_ADDRESS_SIGNATURE_HEADER,
        signClientAddress(clientAddress, signingKey),
      );
    }

    let body: BodyInit | undefined;
    let duplex: 'half' | undefined;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const contentLength = request.header('content-length');
      if (contentLength) headers.set('content-length', contentLength);
      if (request.body !== undefined) {
        body = JSON.stringify(request.body);
        if (!headers.has('content-type'))
          headers.set('content-type', 'application/json');
      } else {
        body = request as unknown as BodyInit;
        duplex = 'half';
      }
    }
    const timeout =
      request.method === 'POST'
        ? boundedInteger(
            process.env.MYOTA_PROXY_UPLOAD_TIMEOUT_SECONDS,
            3600,
            1,
            7200,
          )
        : boundedInteger(process.env.MYOTA_PROXY_TIMEOUT_SECONDS, 60, 1, 600);
    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        ...(duplex ? { duplex } : {}),
        signal: AbortSignal.timeout(timeout * 1000),
      } as RequestInit & { duplex?: 'half' });
      response.status(upstream.status);
      response.setHeader('Access-Control-Allow-Origin', '*');
      for (const name of SAFE_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (response.destroyed) break;
          if (!response.write(chunk))
            await new Promise<void>((resolve) =>
              response.once('drain', resolve),
            );
        }
      }
      response.end();
      this.count(request, prefix, upstream.status);
    } catch (error) {
      this.logger.warn(
        `Gateway upstream request failed for ${service}: ${error instanceof Error ? error.name : 'request error'}`,
      );
      if (!response.headersSent)
        this.finish(response, request, 503, 'upstream service unavailable');
      else response.destroy();
    }
  }

  private grafanaError(
    request: Request,
    response: Response,
    status: number,
    error: string,
  ) {
    this.count(request, '/_internal/grafana/auth', status);
    response.setHeader('Cache-Control', 'no-store');
    response
      .status(status)
      .type('application/json; charset=utf-8')
      .json(createApiProblem(request, response, status, error));
  }

  private finish(
    response: Response,
    request: Request,
    status: number,
    detail?: string,
  ) {
    this.count(request, 'unmatched', status);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.status(status);
    if (detail)
      response
        .type('application/json; charset=utf-8')
        .json(createApiProblem(request, response, status, detail));
    else response.end();
  }

  private count(request: Request, prefix: string, status: number) {
    const route = `${request.method} ${prefix}`;
    const labels = `method="${escapeLabel(request.method)}",route="${escapeLabel(route)}",status="${status}"`;
    this.requests.set(labels, (this.requests.get(labels) ?? 0) + 1);
  }
}

function defaultServiceUrl(service: string) {
  const ports: Record<string, number> = {
    IDENTITY: 8001,
    PROGRAMMES: 8002,
    GEODATA: 8003,
    ACTIVITY: 8004,
  };
  return `http://${service.toLowerCase()}:${ports[service]}`;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function escapeLabel(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
