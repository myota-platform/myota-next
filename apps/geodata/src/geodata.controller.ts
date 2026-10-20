import {
  BadRequestException,
  Controller,
  Body,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import { GeodataRepository } from './geodata.repository.js';
import { GeodataImportService } from './geodata-import.service.js';
import { GeodataImportMutationRepository } from './geodata-import-mutation.repository.js';
import { GeodataEntityMutationRepository } from './geodata-entity-mutation.repository.js';
import { GeodataUploadService } from './geodata-upload.service.js';
import { GeodataDeletionService } from './geodata-deletion.service.js';
import { GeodataScheduleService } from './geodata-schedule.service.js';
import { GeodataProposalService } from './geodata-proposal.service.js';
import { GeodataLoadTestCleanupService } from './geodata-load-test-cleanup.service.js';
import { integerSetting } from '@app/platform/integer-setting.js';
import { fingerprintJsonRequest } from './geodata-request-fingerprint.js';

@Controller('geodata')
export class GeodataController {
  constructor(
    private readonly repository: GeodataRepository,
    private readonly imports: GeodataImportService,
    private readonly importMutations: GeodataImportMutationRepository,
    private readonly entityMutations: GeodataEntityMutationRepository,
    private readonly uploads: GeodataUploadService,
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
    @Body() body: Record<string, unknown>,
  ) {
    return this.deletions.create(authorization, key, body);
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
    @Body() body: Record<string, unknown>,
  ) {
    return this.deletions.confirm(authorization, key, jobId, body);
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
  ) {
    authorizeImport(authorization);
    return this.schedules.create(key, body);
  }

  @Post('refresh-schedules/:scheduleId/run')
  @HttpCode(202)
  runRefreshSchedule(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('scheduleId') scheduleId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = authorizeImport(authorization);
    return this.schedules.run(key, scheduleId, claims.sub, body);
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
  uploadImportPart(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-part-sha256') checksum: string | undefined,
    @Param('uploadId') id: string,
    @Param('partNumber') partNumber: string,
    @Req() request: Request,
  ) {
    const claims = authorizeImport(authorization);
    return this.uploads.uploadPart(
      claims.sub,
      id,
      Number(partNumber),
      request.body as Buffer,
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
    const idempotencyKey = key
      ? `http:${claims.sub}:${request.originalUrl}:${key}`
      : undefined;
    return this.imports.create(idempotencyKey, () => body, {
      requestHash: key ? fingerprintJsonRequest(body, rawBody) : undefined,
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
  @HttpCode(202)
  queueImportProcessing(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('runId') runId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = authorizeImport(authorization);
    return this.importMutations.queueImportProcessing(runId, key, body, claims);
  }

  @Post('imports/:runId/processed')
  async finalizeImport(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('runId') runId: string,
    @Body() body: Record<string, unknown>,
  ) {
    authorizeImport(authorization);
    const finalization = await this.importMutations.finalizeImport(
      runId,
      key,
      body,
    );
    return {
      ...(await this.repository.getImport(runId)),
      ...finalization,
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
  ) {
    const claims = authorizeImport(authorization);
    return this.importMutations.redriveImportProcessingQueue(
      runId,
      queueId,
      key,
      claims.sub,
      body.reason,
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

  @Post('imports/:runId/candidates/validate')
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

  @Get('entities')
  listEntities(@Query() query: Record<string, unknown>) {
    return this.repository.listEntities(query);
  }

  @Get('entities/:entityId/audit')
  getEntityAudit(
    @Headers('authorization') authorization: string | undefined,
    @Param('entityId') id: string,
  ) {
    authorizeBearer(authorization);
    return this.repository.getEntityAudit(id);
  }

  @Get('adapters')
  adapters(@Headers('authorization') authorization: string | undefined) {
    authorizeBearer(authorization);
    return {
      adapters: [
        {
          code: 'PARKSERVE_US',
          formats: ['PARKSERVE_US', 'GEOJSON', 'KML', 'GPX'],
          requires: ['license', 'retrievedAt', 'sourceRef'],
        },
        {
          code: 'OSM',
          formats: ['OSM_PBF', 'GEOJSON', 'KML', 'GPX'],
          requiredTags: [
            'leisure=park',
            'leisure=nature_reserve',
            'boundary=protected_area',
            'landuse=recreation_ground',
            'highway=path',
            'highway=footway',
            'highway=track',
            'highway=bridleway',
            'route=hiking',
          ],
          attribution: '© OpenStreetMap contributors',
        },
        {
          code: 'GOVERNMENT_GIS',
          formats: [
            'WFS',
            'GEOJSON',
            'KML',
            'GPX',
            'SHAPEFILE',
            'SHP',
            'ARCGIS_FEATURESERVER',
          ],
          requires: ['license', 'attribution', 'sourceFormat'],
        },
        {
          code: 'MANUAL',
          formats: ['GEOJSON', 'KML', 'GPX', 'SHAPEFILE', 'SHP'],
          requires: ['feature', 'entityTypes'],
        },
      ],
    };
  }

  @Get('conflation')
  listConflation(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    authorizeBearer(authorization);
    return this.repository.listConflation(query);
  }

  @Post('conflation/:candidateId/resolve')
  resolveConflation(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('candidateId') candidateId: string,
    @Body() body: Record<string, unknown>,
  ) {
    authorizeBearer(authorization);
    return this.importMutations.resolveConflation(candidateId, key, body);
  }

  @Get('location-options')
  async locationOptions(
    @Headers('authorization') authorization: string | undefined,
  ) {
    authorizeBearer(authorization);
    return buildLocationTree(await this.repository.getLocationRows());
  }

  @Get('tiles/:z/:x/:y')
  async tile(
    @Param('z') zoom: string,
    @Param('x') x: string,
    @Param('y') y: string,
    @Res() response: Response,
  ) {
    const tile = await this.repository.getTile(
      parseTileCoordinate(zoom),
      parseTileCoordinate(x),
      parseTileCoordinate(y),
    );
    response.setHeader('content-type', 'application/vnd.mapbox-vector-tile');
    response.setHeader('cache-control', 'public, max-age=60');
    response.status(200).send(tile);
  }

  @Get('entities/:entityId')
  getEntity(@Param('entityId') id: string) {
    return this.repository.getEntity(id);
  }

  @Patch('entities/:entityId')
  patchEntityMetadata(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = authorizeReview(authorization);
    return this.entityMutations.patchEntityMetadata(
      id,
      key,
      ifMatch,
      body,
      claims,
    );
  }

  @Post('entities/:entityId/location-enrichment-requests')
  @HttpCode(202)
  requestLocationEnrichment(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = verifyAccessToken(authorization);
    return this.entityMutations.requestLocationEnrichment(
      id,
      key,
      ifMatch,
      body,
      claims,
    );
  }

  @Post('entities/:entityId/reviews')
  reviewEntity(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = authorizeReview(authorization);
    return this.entityMutations.reviewEntity(id, key, ifMatch, body, claims);
  }

  @Put('entities/:entityId/categories')
  replaceEntityCategories(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = authorizeReview(authorization);
    return this.entityMutations.replaceEntityCategories(
      id,
      key,
      ifMatch,
      body,
      claims,
    );
  }

  @Put('entities/:entityId/geometry')
  replaceEntityGeometry(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = authorizeReview(authorization);
    return this.entityMutations.replaceEntityGeometry(
      id,
      key,
      ifMatch,
      body,
      claims,
    );
  }
}

function parseTileCoordinate(value: string): number {
  const normalized = value.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
    throw new BadRequestException('tile coordinates must be integers');
  const parsed = Number(normalized.replaceAll('_', ''));
  if (!Number.isSafeInteger(parsed))
    throw new BadRequestException('tile coordinates must be integers');
  return parsed;
}

function authorizeBearer(authorization: string | undefined) {
  verifyAccessToken(authorization);
}

function authorizeImport(authorization: string | undefined) {
  const claims = verifyAccessToken(authorization);
  if (!claims.scp.some((scope) => scope === '*' || scope === 'geodata.import'))
    throw new ForbiddenException('geodata.import scope is required');
  return claims;
}

function authorizeReview(authorization: string | undefined) {
  const claims = verifyAccessToken(authorization);
  if (!claims.scp.some((scope) => scope === '*' || scope === 'geodata.review'))
    throw new ForbiddenException('geodata.review scope is required');
  return claims;
}

type LocationNode = { name: string; code: string | null } & Record<string, any>;

function buildLocationTree(rows: Record<string, string | null>[]) {
  const continents = new Map<string, LocationNode>();
  const upsert = (
    map: Map<string, LocationNode>,
    name: string | null,
    code: string | null,
    childFields: string[],
  ) => {
    const label = trimPythonWhitespace(String(name ?? ''));
    if (!label) return null;
    const normalizedCode =
      trimPythonWhitespace(String(code ?? '')).toUpperCase() || null;
    const key = `${normalizedCode ?? ''}:${unicodeCaseFold(label)}`;
    let value = map.get(key);
    if (!value) {
      value = { name: label, code: normalizedCode };
      for (const field of childFields) value[field] = new Map();
      map.set(key, value);
    } else if (!value.code && normalizedCode) value.code = normalizedCode;
    return value;
  };
  const cities = (
    map: Map<string, LocationNode>,
    row: Record<string, string | null>,
  ) => {
    for (const name of new Set([row.city, row.municipality].filter(Boolean)))
      upsert(map, name, null, []);
  };
  for (const row of rows) {
    const continent = upsert(continents, row.continent, row.continentCode, [
      'countries',
    ]);
    if (!continent) continue;
    const country = upsert(
      continent.countries as Map<string, LocationNode>,
      row.country,
      row.countryCode,
      ['subdivisions', 'cities'],
    );
    if (!country) continue;
    cities(country.cities as Map<string, LocationNode>, row);
    const subdivision = upsert(
      country.subdivisions as Map<string, LocationNode>,
      row.region,
      row.regionCode,
      ['provinces', 'cities'],
    );
    if (!subdivision) continue;
    cities(subdivision.cities as Map<string, LocationNode>, row);
    const province = upsert(
      subdivision.provinces as Map<string, LocationNode>,
      row.province,
      row.provinceCode,
      ['cities'],
    );
    if (province) cities(province.cities as Map<string, LocationNode>, row);
  }
  const sorted = (map: Map<string, LocationNode>, type: string) =>
    [...map.values()]
      .map((node) => {
        const result: Record<string, unknown> = {
          name: node.name,
          code: node.code,
        };
        if (type === 'continent')
          result.countries = sorted(
            node.countries as Map<string, LocationNode>,
            'country',
          );
        if (type === 'country') {
          result.subdivisions = sorted(
            node.subdivisions as Map<string, LocationNode>,
            'subdivision',
          );
          result.cities = sorted(
            node.cities as Map<string, LocationNode>,
            'city',
          );
        }
        if (type === 'subdivision') {
          result.provinces = sorted(
            node.provinces as Map<string, LocationNode>,
            'province',
          );
          result.cities = sorted(
            node.cities as Map<string, LocationNode>,
            'city',
          );
        }
        if (type === 'province')
          result.cities = sorted(
            node.cities as Map<string, LocationNode>,
            'city',
          );
        return result;
      })
      .sort((a, b) => {
        const nameOrder = compareText(
          unicodeCaseFold(String(a.name)),
          unicodeCaseFold(String(b.name)),
        );
        return (
          nameOrder ||
          compareText(
            typeof a.code === 'string' ? a.code : '',
            typeof b.code === 'string' ? b.code : '',
          )
        );
      });
  return {
    provider: 'BIGDATACLOUD',
    codeStandards: {
      continent: 'provider ISO continent code',
      country: 'ISO 3166-1',
      subdivision: 'ISO 3166-2',
    },
    continents: sorted(continents, 'continent'),
  };
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
