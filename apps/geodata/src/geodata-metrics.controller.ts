import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { renderHttpRequestMetrics } from '@app/platform/http-metrics.js';
import { GeodataQueryMetrics } from './geodata-query-metrics.service.js';

@Controller()
export class GeodataMetricsController {
  constructor(private readonly queryMetrics: GeodataQueryMetrics) {}

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  metrics(@Res() response: Response): void {
    response
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(`${renderHttpRequestMetrics()}${this.queryMetrics.render()}`);
  }
}
