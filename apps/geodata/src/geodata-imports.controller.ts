import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { integerSetting } from '@app/platform/integer-setting.js';
import {
  GeodataUploadService,
  MAX_UPLOAD_PART_BYTES,
} from './geodata-upload.service.js';
import { GeodataImportService } from './geodata-import.service.js';
import { GeodataImportMutationRepository } from './geodata-import-mutation.repository.js';
import { GeodataRepository } from './geodata.repository.js';
import {
  rawImportSourceData,
  fingerprintJsonRequest,
} from './geodata-request-fingerprint.js';
import {
  authorizeImport,
  parseImportPartNumber,
  scopedRequestIdempotency,
} from './geodata-controller-support.js';

@Controller('geodata')
export class GeodataImportsController {
  constructor(
    private readonly repository: GeodataRepository,
    private readonly imports: GeodataImportService,
    private readonly importMutations: GeodataImportMutationRepository,
    private readonly uploads: GeodataUploadService,
  ) {}

  @Post('import-uploads')
  @HttpCode(201)
  createImportUpload(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = authorizeImport(authorization);
    return this.uploads.create(claims.sub, key, body);
  }

  @Get('import-uploads/:uploadId')
  getImportUpload(
    @Headers('authorization') authorization: string | undefined,
    @Param('uploadId') id: string,
  ) {
    const claims = authorizeImport(authorization);
    return this.uploads.get(claims.sub, id);
  }

  @Post('import-uploads/:uploadId/parts/:partNumber')
  @HttpCode(200)
  uploadImportPart(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-part-sha256') checksum: string | undefined,
    @Param('uploadId') id: string,
    @Param('partNumber') partNumber: string,
    @Req() request: Request,
  ) {
    const body: unknown = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0)
      throw new BadRequestException(
        `upload part must be between 1 and ${MAX_UPLOAD_PART_BYTES} bytes`,
      );
    const claims = authorizeImport(authorization);
    return this.uploads.uploadPart(
      claims.sub,
      id,
      parseImportPartNumber(partNumber),
      body,
      checksum,
    );
  }

  @Post('import-uploads/:uploadId/complete')
  @HttpCode(202)
  completeImportUpload(
    @Headers('authorization') authorization: string | undefined,
    @Param('uploadId') id: string,
  ) {
    const claims = authorizeImport(authorization);
    return this.uploads.complete(claims.sub, id);
  }

  @Delete('import-uploads/:uploadId')
  abortImportUpload(
    @Headers('authorization') authorization: string | undefined,
    @Param('uploadId') id: string,
  ) {
    const claims = authorizeImport(authorization);
    return this.uploads.abort(claims.sub, id);
  }

  @Post('imports')
  @HttpCode(202)
  createImport(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = authorizeImport(authorization);
    if (request.is('multipart/form-data')) {
      request.resume();
      const contentLength = request.header('content-length') ?? '0';
      const length = Number(contentLength);
      if (!Number.isInteger(length))
        throw new BadRequestException('invalid Content-Length');
      const maximumBytes = integerSetting(
        process.env.MYOTA_MAX_BODY_BYTES,
        1024 * 1024 * 1024,
      );
      if (length > maximumBytes)
        throw new BadRequestException(
          `request body exceeds ${maximumBytes} bytes`,
        );
      if (length <= 0)
        throw new BadRequestException(
          'multipart request body must not be empty',
        );
      throw new BadRequestException(
        'single-request uploads are disabled; create a resumable upload session',
      );
    }
    const rawBody = (
      request as Request & { rawBody?: Buffer }
    ).rawBody?.toString('utf8');
    const rawSourceData = rawBody ? rawImportSourceData(rawBody) : {};
    const idempotencyKey = key
      ? `http:${claims.sub}:${request.originalUrl}:${key}`
      : undefined;
    return this.imports.create(idempotencyKey, () => body, {
      requestHash: key ? fingerprintJsonRequest(body, rawBody) : undefined,
      ...rawSourceData,
    });
  }

  @Get('imports')
  listImports(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    authorizeImport(authorization);
    return this.repository.listImports(query);
  }

  @Get('imports/:runId')
  getImport(
    @Headers('authorization') authorization: string | undefined,
    @Param('runId') id: string,
  ) {
    authorizeImport(authorization);
    return this.repository.getImport(id);
  }

  @Post('imports/:runId/process')
  @HttpCode(200)
  processImportCandidates(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('runId') runId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = authorizeImport(authorization);
    const rawBody = (
      request as Request & { rawBody?: Buffer }
    ).rawBody?.toString('utf8');
    const scopedKey = key
      ? `http:${claims.sub}:${request.originalUrl}:${key}`
      : undefined;
    return this.importMutations.processImportCandidates(
      runId,
      scopedKey,
      body,
      claims,
      key ? fingerprintJsonRequest(body, rawBody) : undefined,
    );
  }

  @Post('imports/:runId/processed')
  @HttpCode(200)
  async finalizeImport(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('runId') runId: string,
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
    const finalization = await this.importMutations.finalizeImport(
      runId,
      idempotency.key,
      body,
      idempotency.requestHash,
    );
    return {
      ...(await this.repository.getImport(runId)),
      ...(finalization as Record<string, unknown>),
      finalized: true,
    };
  }

  @Put('imports/:runId/cancellation')
  async cancelImport(
    @Headers('authorization') authorization: string | undefined,
    @Param('runId') runId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const claims = authorizeImport(authorization);
    const cancellation = await this.importMutations.cancelImport(
      runId,
      claims.sub,
    );
    response.status(cancellation.httpStatus);
    if (cancellation.status === 'CANCELLED')
      await this.imports.discardSourceObject(cancellation.sourceMetadata);
    return {
      ...(await this.repository.getImport(runId)),
      status: cancellation.status,
    };
  }

  @Get('imports/:runId/processing-queues/:queueId')
  getImportProcessingQueue(
    @Headers('authorization') authorization: string | undefined,
    @Param('runId') runId: string,
    @Param('queueId') queueId: string,
  ) {
    authorizeImport(authorization);
    return this.repository.getImportProcessingQueue(runId, queueId);
  }

  @Post('imports/:runId/processing-queues/:queueId/redrive')
  @HttpCode(202)
  redriveImportProcessingQueue(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('runId') runId: string,
    @Param('queueId') queueId: string,
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
    return this.importMutations.redriveImportProcessingQueue(
      runId,
      queueId,
      idempotency.key,
      claims.sub,
      body.reason,
      idempotency.requestHash,
    );
  }

  @Get('imports/:runId/candidates')
  listImportCandidates(
    @Headers('authorization') authorization: string | undefined,
    @Param('runId') runId: string,
    @Query() query: Record<string, unknown>,
  ) {
    authorizeImport(authorization);
    return this.repository.listImportCandidates(runId, query);
  }

  @Post('imports/:runId/candidates/:candidateId/entity-id-suggestion')
  @HttpCode(200)
  suggestImportCandidateEntityIdentifier(
    @Headers('authorization') authorization: string | undefined,
    @Param('runId') runId: string,
    @Param('candidateId') candidateId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    authorizeImport(authorization);
    return this.importMutations.suggestEntityIdentifier(
      runId,
      candidateId,
      body,
    );
  }

  @Post('imports/:runId/candidates/validate')
  @HttpCode(200)
  validateImportCandidates(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('runId') runId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = authorizeImport(authorization);
    const rawBody = (
      request as Request & { rawBody?: Buffer }
    ).rawBody?.toString('utf8');
    const scopedKey = key
      ? `http:${claims.sub}:${request.originalUrl}:${key}`
      : undefined;
    return this.importMutations.validateImportCandidates(
      runId,
      scopedKey,
      body,
      key ? fingerprintJsonRequest(body, rawBody) : undefined,
    );
  }
}
