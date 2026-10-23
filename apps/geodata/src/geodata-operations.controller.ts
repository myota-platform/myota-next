import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { fingerprintJsonRequest } from './geodata-request-fingerprint.js';
import { GeodataDeletionService } from './geodata-deletion.service.js';
import { GeodataScheduleService } from './geodata-schedule.service.js';
import { GeodataProposalService } from './geodata-proposal.service.js';
import { GeodataLoadTestCleanupService } from './geodata-load-test-cleanup.service.js';
import {
  authorizeImport,
  scopedRequestIdempotency,
} from './geodata-controller-support.js';

@Controller('geodata')
export class GeodataOperationsController {
  constructor(
    private readonly deletions: GeodataDeletionService,
    private readonly schedules: GeodataScheduleService,
    private readonly proposals: GeodataProposalService,
    private readonly loadTestCleanup: GeodataLoadTestCleanupService,
  ) {}

  @Post('entity-deletion-jobs')
  @HttpCode(201)
  createEntityDeletionJob(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, unknown> | null,
    @Req() request: Request,
  ) {
    const requestBody = body ?? {};
    const rawBody = (
      request as Request & { rawBody?: Buffer }
    ).rawBody?.toString('utf8');
    return this.deletions.create(
      authorization,
      key,
      requestBody,
      key ? fingerprintJsonRequest(requestBody, rawBody) : undefined,
      request.originalUrl,
    );
  }

  @Get('entity-deletion-jobs/:jobId')
  getEntityDeletionJob(
    @Headers('authorization') authorization: string | undefined,
    @Param('jobId') jobId: string,
  ) {
    return this.deletions.get(authorization, jobId);
  }

  @Post('entity-deletion-jobs/:jobId/confirm')
  @HttpCode(202)
  confirmEntityDeletionJob(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('jobId') jobId: string,
    @Body() body: Record<string, unknown> | null,
    @Req() request: Request,
  ) {
    const requestBody = body ?? {};
    const rawBody = (
      request as Request & { rawBody?: Buffer }
    ).rawBody?.toString('utf8');
    return this.deletions.confirm(
      authorization,
      key,
      jobId,
      requestBody,
      key ? fingerprintJsonRequest(requestBody, rawBody) : undefined,
      request.originalUrl,
    );
  }

  @Get('refresh-schedules')
  listRefreshSchedules(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    authorizeImport(authorization);
    return this.schedules.list(query);
  }

  @Post('refresh-schedules')
  @HttpCode(201)
  createRefreshSchedule(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = authorizeImport(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.schedules.create(
      idempotency.key,
      body,
      idempotency.requestHash,
    );
  }

  @Post('refresh-schedules/:scheduleId/run')
  @HttpCode(202)
  runRefreshSchedule(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('scheduleId') scheduleId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = authorizeImport(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.schedules.run(
      idempotency.key,
      scheduleId,
      claims.sub,
      body,
      idempotency.requestHash,
    );
  }

  @Post('proposals')
  @HttpCode(201)
  createProposal(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = verifyAccessToken(authorization);
    const rawBody = (
      request as Request & { rawBody?: Buffer }
    ).rawBody?.toString('utf8');
    return this.proposals.create(
      key,
      claims.sub,
      body,
      request.originalUrl,
      rawBody,
    );
  }

  @Delete('load-test-runs/:testRunId')
  cleanLoadTestRun(
    @Headers('authorization') authorization: string | undefined,
    @Param('testRunId') testRunId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.loadTestCleanup.clean(authorization, testRunId, body);
  }
}
