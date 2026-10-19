import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { ActivityRepository } from './activity.repository.js';
import {
  normalizeActivation,
  normalizeQso,
  type JsonRecord,
} from './activity-domain.js';

@Injectable()
export class ActivityService {
  constructor(private readonly repository: ActivityRepository) {}

  async list(
    authorization: string | undefined,
    query: {
      programme?: string;
      operatorId?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    const claims = this.authorize(authorization, [
      'activity.read',
      'activity.admin',
    ]);
    const operatorId =
      claims.scp.includes('*') || claims.scp.includes('activity.admin')
        ? query.operatorId
        : claims.sub;
    const items = await this.repository.list(query.programme, operatorId);
    const page = positiveInt(query.page, 1);
    const pageSize = Math.min(100, positiveInt(query.pageSize, 50));
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      page,
      pageSize,
      total: items.length,
      nextPage: start + pageSize < items.length ? page + 1 : null,
    };
  }

  async create(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    const claims = verifyAccessToken(authorization);
    if (
      claims.sub !== body.operatorId &&
      !claims.scp.some((scope) => ['*', 'activity.admin'].includes(scope))
    )
      throw new ForbiddenException(
        'activation operator does not match the authenticated account',
      );
    for (const field of [
      'programmeSlug',
      'entityId',
      'operatorId',
      'startedAt',
    ])
      if (!body[field]) throw new BadRequestException(`${field} is required`);
    return this.repository.create(normalizeActivation(body), key);
  }

  async get(authorization: string | undefined, id: string) {
    this.authorize(authorization, ['activity.read', 'activity.admin']);
    return this.repository.get(id);
  }

  async addQso(
    authorization: string | undefined,
    key: string | undefined,
    activationId: string,
    body: JsonRecord,
  ) {
    const claims = verifyAccessToken(authorization);
    if (!body.workedCallsign || !body.timestamp)
      throw new BadRequestException(
        'workedCallsign and timestamp are required',
      );
    const activation = await this.repository.get(activationId);
    this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    return this.repository.addQso(
      activationId,
      normalizeQso(body, activationId),
      key,
    );
  }

  async close(
    authorization: string | undefined,
    key: string | undefined,
    activationId: string,
    body: JsonRecord,
  ) {
    const claims = verifyAccessToken(authorization);
    const activation = await this.repository.get(activationId);
    this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    const endedAt = body.endedAt ?? new Date().toISOString();
    return this.repository.close(activationId, endedAt, key);
  }

  async enqueueQsoIngestion(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    const claims = verifyAccessToken(authorization);
    if (
      !body.activationId ||
      !Array.isArray(body.qsos) ||
      body.qsos.length === 0
    )
      throw new BadRequestException(
        'activationId and a non-empty qsos array are required',
      );
    const maximum = Number.parseInt(
      process.env.MYOTA_MAX_BATCH_QSOS ?? '5000',
      10,
    );
    if (body.qsos.length > maximum)
      throw new BadRequestException(
        'QSO ingestion exceeds the configured limit',
      );
    const sourceFormat = body.sourceFormat ?? 'JSON';
    if (!['JSON', 'CSV', 'ADIF'].includes(sourceFormat))
      throw new BadRequestException('sourceFormat must be JSON, CSV, or ADIF');
    const activation = await this.repository.get(body.activationId);
    this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    const payload = {
      activationId: body.activationId,
      records: body.qsos,
      sourceFormat,
    };
    const job = await this.repository.enqueueJob('QSO_INGESTION', payload, key);
    return { ingestionId: job.id, ...job };
  }

  async getJob(authorization: string | undefined, id: string) {
    const claims = verifyAccessToken(authorization);
    const job = await this.repository.getJob(id);
    const activationId = job.payload?.activationId;
    if (activationId) {
      const activation = await this.repository.get(activationId);
      this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    } else if (
      !claims.scp.some((scope) => ['*', 'activity.admin'].includes(scope))
    ) {
      throw new ForbiddenException('activity.admin scope is required');
    }
    return job;
  }

  private authorize(authorization: string | undefined, scopes: string[]) {
    const claims = verifyAccessToken(authorization);
    if (!claims.scp.some((scope) => scope === '*' || scopes.includes(scope)))
      throw new ForbiddenException('required activity scope is missing');
    return claims;
  }

  private authorizeOperator(
    subject: string,
    scopes: string[],
    operatorId: string,
  ) {
    if (
      subject !== operatorId &&
      !scopes.some((scope) => ['*', 'activity.admin'].includes(scope))
    )
      throw new ForbiddenException('activation belongs to another operator');
  }
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
