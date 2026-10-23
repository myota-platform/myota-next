import { Controller, Get, Optional, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseHealthService } from './database.module.js';

@Controller()
export class HealthController {
  constructor(
    @Optional() private readonly databaseHealth?: DatabaseHealthService,
  ) {}

  @Get('healthz')
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readiness(@Res() response: Response): Promise<void> {
    const ready = this.databaseHealth
      ? await this.databaseHealth.isReady()
      : true;
    response
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ready' : 'not-ready' });
  }
}
