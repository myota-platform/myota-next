import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : undefined;
}

type ApiProblem = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  requestId: string;
  correlationId: string;
};

export function requestIds(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const requestId =
    safeRequestId(request.get(REQUEST_ID_HEADER)) ?? randomUUID();
  const correlationId =
    safeId(request.get(CORRELATION_ID_HEADER)) ?? randomUUID();
  request.headers[REQUEST_ID_HEADER] = requestId;
  request.headers[CORRELATION_ID_HEADER] = correlationId;
  response.setHeader('X-Request-ID', requestId);
  response.setHeader('X-Trace-ID', requestId);
  response.setHeader('X-Correlation-ID', correlationId);
  response.setHeader(
    'Access-Control-Expose-Headers',
    'X-Request-ID, X-Correlation-ID, traceparent, tracestate, X-Trace-ID',
  );
  response.locals.requestId = requestId;
  response.locals.correlationId = correlationId;
  next();
}

@Catch()
export class ApiProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const exceptionStatus =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const status = exceptionStatus === 401 ? 403 : exceptionStatus;
    const body =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const data = isRecord(body) ? body : undefined;
    const code = problemCode(status);
    let detail = detailFrom(data, body, exception);
    if (status === 404 && /^Cannot \w+ /.test(detail))
      detail = `no route for ${request.path}`;
    const problem: ApiProblem = {
      type: `https://myota.dev/problems/${code}`,
      title: code
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
      status,
      code,
      detail,
      requestId: response.locals.requestId ?? randomUUID(),
      correlationId: response.locals.correlationId ?? randomUUID(),
    };
    response
      .status(status)
      .type('application/json; charset=utf-8')
      .json(problem);
  }
}

export function parserProblem(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
) {
  if (!isRecord(error) || !('status' in error)) return next(error);
  let status = typeof error.status === 'number' ? error.status : 400;
  let detail =
    typeof error.message === 'string' ? error.message : 'invalid request body';
  const errorType = typeof error.type === 'string' ? error.type : '';
  const isJson =
    request.is('application/json') || request.is('application/*+json');
  if (isJson && errorType === 'entity.parse.failed') {
    status = 400;
    detail = 'invalid JSON body';
  } else if (
    (isJson || request.is('application/x-www-form-urlencoded')) &&
    errorType === 'entity.too.large'
  ) {
    status = 400;
    detail =
      typeof error.limit === 'number'
        ? `request body exceeds ${error.limit} bytes`
        : 'request body exceeds the configured limit';
  }
  const code = problemCode(status);
  const problem: ApiProblem = {
    type: `https://myota.dev/problems/${code}`,
    title: code
      .replaceAll('_', ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase()),
    status,
    code,
    detail,
    requestId: response.locals.requestId ?? randomUUID(),
    correlationId: response.locals.correlationId ?? randomUUID(),
  };
  response.status(status).type('application/json; charset=utf-8').json(problem);
}

export function createApiProblem(
  request: Request,
  response: Response,
  status: number,
  detail: string,
): ApiProblem {
  const code = problemCode(status);
  return {
    type: `https://myota.dev/problems/${code}`,
    title: code
      .replaceAll('_', ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase()),
    status,
    code,
    detail,
    requestId:
      response.locals.requestId ??
      request.get(REQUEST_ID_HEADER) ??
      randomUUID(),
    correlationId:
      response.locals.correlationId ??
      request.get(CORRELATION_ID_HEADER) ??
      randomUUID(),
  };
}

function problemCode(status: number) {
  if (status === 404) return 'not_found';
  if (status === 403 || status === 401 || status === 429) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'internal_error';
  return 'invalid_request';
}

function detailFrom(
  data: Record<string, unknown> | undefined,
  body: unknown,
  exception: unknown,
) {
  const value =
    data?.detail ??
    data?.message ??
    (typeof body === 'string' ? body : undefined);
  if (Array.isArray(value)) return value.map(String).join('; ');
  if (typeof value === 'string') return value;
  if (exception instanceof Error) return exception.message;
  return 'internal server error';
}

function safeId(value: string | undefined) {
  return value && /^[\x21-\x7e]{1,128}$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
