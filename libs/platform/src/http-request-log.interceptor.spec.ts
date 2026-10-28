import {
  ForbiddenException,
  Logger,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestLogInterceptor } from './http-request-log.interceptor.js';

function context(request: Partial<Request>, response: Partial<Response>) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('HttpRequestLogInterceptor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a route template and trace id without request values', () => {
    const write = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    const interceptor = new HttpRequestLogInterceptor('identity-api');
    const request = {
      method: 'GET',
      path: '/v1/identity/accounts/private-account-id',
      baseUrl: '/v1/identity/accounts',
      route: { path: '/:accountId' },
      get: () => 'trace-request-123',
    } as unknown as Request;
    const response = { statusCode: 200 } as Response;

    interceptor
      .intercept(context(request, response), {
        handle: () => of({ id: 'private-account-id' }),
      } as CallHandler)
      .subscribe();

    expect(write).toHaveBeenCalledOnce();
    const entry = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(entry).toMatchObject({
      event: 'http_request_completed',
      serviceId: 'identity-api',
      method: 'GET',
      route: '/v1/identity/accounts/:accountId',
      statusCode: 200,
      traceId: 'trace-request-123',
    });
    expect(JSON.stringify(entry)).not.toContain('private-account-id');
  });

  it('logs the HTTP status from a Nest exception', () => {
    const write = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    const interceptor = new HttpRequestLogInterceptor('identity-api');
    const request = {
      method: 'GET',
      path: '/v1/identity/admin/accounts',
      baseUrl: '/v1/identity/admin/accounts',
      route: { path: '/' },
      get: () => 'trace-request-456',
    } as unknown as Request;

    interceptor
      .intercept(context(request, { statusCode: 200 }), {
        handle: () => throwError(() => new ForbiddenException()),
      } as CallHandler)
      .subscribe({ error: () => undefined });

    expect(JSON.parse(String(write.mock.calls[0]?.[0])).statusCode).toBe(403);
  });

  it('does not log health, readiness, or metrics scrape requests', () => {
    const write = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    const interceptor = new HttpRequestLogInterceptor('gateway');
    const next = { handle: () => of({ status: 'ok' }) } as CallHandler;

    for (const path of ['/healthz', '/readyz', '/metrics']) {
      interceptor
        .intercept(
          context(
            { method: 'GET', path } as Request,
            { statusCode: 200 } as Response,
          ),
          next,
        )
        .subscribe();
    }

    expect(write).not.toHaveBeenCalled();
  });
});
