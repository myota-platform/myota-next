import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

const requestCounts = new Map<string, number>();

export function recordHttpRequest(
  service: string,
  request: Request,
  status: number,
): void {
  if (request.path === '/metrics') return;
  const route = request.route
    ? `${request.baseUrl}${request.route.path}`
    : request.path === '/healthz' || request.path === '/readyz'
      ? request.path
      : '/_unmatched';
  const labels = {
    service,
    method: request.method,
    route,
    status: String(status),
  };
  const key = JSON.stringify(labels);
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
}

export function renderHttpRequestMetrics(): string {
  const lines = [
    '# HELP myota_http_requests_total Total HTTP requests handled by a service.',
    '# TYPE myota_http_requests_total counter',
  ];
  for (const [key, count] of [...requestCounts.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const labels = JSON.parse(key) as Record<string, string>;
    const formatted = Object.entries(labels)
      .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
      .join(',');
    lines.push(`myota_http_requests_total{${formatted}} ${count}`);
  }
  return `${lines.join('\n')}\n`;
}

@Controller()
export class HttpMetricsController {
  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  metrics(@Res() response: Response): void {
    response
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(renderHttpRequestMetrics());
  }
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}
