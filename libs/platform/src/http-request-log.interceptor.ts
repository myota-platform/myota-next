import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, finalize, tap } from 'rxjs';
import { REQUEST_ID_HEADER, safeRequestId } from './http-problem.js';

@Injectable()
export class HttpRequestLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HttpRequestLogInterceptor.name);

  constructor(private readonly serviceId: string) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    if (['/healthz', '/readyz', '/metrics'].includes(request.path))
      return next.handle();

    const startedAt = Date.now();
    let logged = false;
    const log = (statusCode: number) => {
      if (logged) return;
      logged = true;

      const matchedPath = request.route?.path;
      const route =
        typeof matchedPath === 'string'
          ? `${request.baseUrl}${matchedPath}` || '/_unmatched'
          : '/_unmatched';
      this.logger.log(
        JSON.stringify({
          event: 'http_request_completed',
          serviceId: this.serviceId,
          method: request.method,
          route,
          statusCode,
          durationMs: Math.max(0, Date.now() - startedAt),
          traceId: safeRequestId(request.get(REQUEST_ID_HEADER)),
        }),
      );
    };

    return next.handle().pipe(
      tap({
        complete: () => log(response.statusCode),
        error: (error: unknown) =>
          log(
            error instanceof HttpException
              ? error.getStatus()
              : response.statusCode >= 400
                ? response.statusCode
                : 500,
          ),
      }),
      finalize(() => {
        if (!logged) log(response.statusCode);
      }),
    );
  }
}
