import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { integerSetting, verifyAccessToken } from '@app/platform';
import { parsePageInteger } from '@app/platform/pagination.js';
import { ActivityRepository } from './activity.repository.js';
import { parseQsoCsv } from './qso-csv.js';
import {
  normalizeActivation,
  normalizeQso,
  type JsonRecord,
} from './activity-domain.js';

@Injectable()
export class ActivityService {
  private storage?: S3Client;
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
    const page = parsePageInteger(query.page, 1);
    const pageSize = Math.min(100, parsePageInteger(query.pageSize, 50));
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

  async entityDeletionImpact(
    authorization: string | undefined,
    entityId: string,
  ) {
    this.authorize(authorization, ['activity.admin']);
    return this.repository.entityDeletionImpact(entityId);
  }

  async cascadeDeleteEntity(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    const claims = this.authorize(authorization, ['activity.admin']);
    const entityId = typeof body.entityId === 'string' ? body.entityId : '';
    if (!entityId) throw new BadRequestException('entityId is required');
    const deletedBy =
      claims.sub ||
      (typeof body.deletedBy === 'string' ? body.deletedBy : 'administrator');
    return this.repository.cascadeDeleteEntity(entityId, deletedBy, key);
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
    const maximum = integerSetting(process.env.MYOTA_MAX_BATCH_QSOS, 5000);
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

  async enqueueCsvQsoIngestion(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    const activationId =
      typeof body.activationId === 'string' ? body.activationId : '';
    const filename =
      typeof body.filename === 'string' ? body.filename.trim() : '';
    if (!activationId || !filename || typeof body.contentBase64 !== 'string')
      throw new BadRequestException(
        'activationId, filename, and contentBase64 are required',
      );
    if (
      filename.length > 255 ||
      /[\\/]/.test(filename) ||
      !/\.csv$/i.test(filename)
    )
      throw new BadRequestException(
        'filename must be a CSV filename of 255 characters or fewer',
      );
    const maxBytes = integerSetting(
      process.env.MYOTA_UPLOAD_MAX_BYTES,
      25 * 1024 * 1024,
    );
    const content = decodeBase64(body.contentBase64);
    if (content.length > maxBytes)
      throw new BadRequestException(
        'CSV upload exceeds the configured size limit',
      );
    await scanUpload(content, filename);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new BadRequestException('CSV file must use UTF-8 encoding');
    }
    const maximum = integerSetting(process.env.MYOTA_MAX_BATCH_QSOS, 5000);
    const qsos = parseQsoCsv(text, maximum);
    return this.enqueueQsoIngestion(authorization, key, {
      activationId,
      sourceFormat: 'CSV',
      qsos,
    });
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

  async redriveWorkJob(
    authorization: string | undefined,
    key: string | undefined,
    id: string,
    reason: unknown,
  ) {
    const claims = this.authorize(authorization, ['activity.admin']);
    return this.repository.redriveFailedWorkJob(id, claims.sub, reason, key);
  }

  async getAdifImport(authorization: string | undefined, id: string) {
    const claims = verifyAccessToken(authorization);
    const record = await this.repository.getAdifImport(id);
    const activation = await this.repository.get(record.activationId);
    this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    return record;
  }

  async createAdifImport(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    const claims = verifyAccessToken(authorization);
    const activationId =
      typeof body.activationId === 'string' ? body.activationId : '';
    const filename =
      typeof body.filename === 'string' ? body.filename.trim() : '';
    if (!activationId || !filename || typeof body.contentBase64 !== 'string')
      throw new BadRequestException(
        'activationId, filename, and contentBase64 are required',
      );
    if (filename.length > 255 || /[\\/]/.test(filename))
      throw new BadRequestException(
        'filename must be a simple filename of 255 characters or fewer',
      );
    const activation = await this.repository.get(activationId);
    this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    const content = decodeBase64(body.contentBase64);
    const maxBytes = integerSetting(
      process.env.MYOTA_UPLOAD_MAX_BYTES,
      25 * 1024 * 1024,
    );
    if (content.length > maxBytes)
      throw new BadRequestException(
        'ADIF upload exceeds the configured size limit',
      );
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    if (content.includes(eicar))
      throw new BadRequestException('malware scan rejected the upload');
    await scanUpload(content, filename);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const bucket = process.env.MYOTA_ADIF_BUCKET ?? 'myota-adif';
    const objectKey = `adif/${activationId}/${randomUUID()}-${filename}`;
    try {
      const client = this.s3();
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: content,
          ContentType: 'text/plain',
        }),
      );
    } catch {
      throw new ServiceUnavailableException(
        'ADIF object storage upload failed',
      );
    }
    let created: JsonRecord;
    try {
      created = await this.repository.createAdifImport(
        activationId,
        {
          filename,
          objectKey,
          bucket,
          sha256,
          contentSize: content.length,
          scan: { status: 'CLEAN', sha256, size: content.length },
        },
        key,
      );
    } catch (error) {
      await this.s3()
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
        .catch(() => undefined);
      throw error;
    }
    if (created.objectKey !== objectKey)
      await this.s3()
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
        .catch(() => undefined);
    return created;
  }

  private s3() {
    if (!this.storage)
      this.storage = new S3Client({
        endpoint:
          process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ?? 'http://seaweedfs:8333',
        region: process.env.MYOTA_OBJECT_STORAGE_REGION ?? 'us-east-1',
        forcePathStyle:
          (process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE ?? 'path') ===
          'path',
        credentials: {
          accessKeyId:
            process.env.MYOTA_OBJECT_STORAGE_ACCESS_KEY ?? 'myota-s3',
          secretAccessKey:
            process.env.MYOTA_OBJECT_STORAGE_SECRET_KEY ?? 'myota-s3-dev-only',
        },
      });
    return this.storage;
  }

  async publicHistory(programme?: string, page?: string, pageSize?: string) {
    const items = await this.repository.list(programme);
    const publicItems = items.map((item) => ({
      ...item,
      operatorCallsign: item.operatorCallsign
        ? maskCallsign(item.operatorCallsign)
        : null,
    }));
    const pageNumber = parsePageInteger(page, 1);
    const size = Math.min(100, parsePageInteger(pageSize, 50));
    const start = (pageNumber - 1) * size;
    return {
      items: publicItems.slice(start, start + size),
      page: pageNumber,
      pageSize: size,
      total: publicItems.length,
      nextPage: start + size < publicItems.length ? pageNumber + 1 : null,
    };
  }

  async leaderboard(programme: string, category = 'HUNTER') {
    if (!programme) throw new BadRequestException('programme is required');
    const normalizedCategory = category.toUpperCase();
    if (!['ACTIVATOR', 'HUNTER'].includes(normalizedCategory))
      throw new BadRequestException('category must be ACTIVATOR or HUNTER');
    return {
      programme,
      category: normalizedCategory,
      items: await this.repository.leaderboard(programme, normalizedCategory),
    };
  }

  async publicResults(programme?: string, format = 'json') {
    const selectedProgramme = programme || undefined;
    const items = await this.repository.list(selectedProgramme);
    const rows = items.map((item) => ({
      activationId: item.id,
      programme: item.programmeSlug,
      entityId: item.entityId,
      status: item.status,
      startedAt: item.startedAt,
      qsoCount: item.qsoCount,
    }));
    if (format.toLowerCase() === 'csv') {
      const fields = [
        'activationId',
        'programme',
        'entityId',
        'status',
        'startedAt',
        'qsoCount',
      ] as const;
      const content = [
        fields.join(','),
        ...rows.map((row) =>
          fields
            .map((field) => String(row[field]).replaceAll(',', ' '))
            .join(','),
        ),
      ].join('\n');
      return {
        format: 'csv',
        contentType: 'text/csv',
        content,
        downloadName: `myota-results-${selectedProgramme ?? 'all'}.csv`,
      };
    }
    return {
      format: 'json',
      items: rows,
      downloadName: `myota-results-${selectedProgramme ?? 'all'}.json`,
    };
  }

  async requestCorrection(
    authorization: string | undefined,
    key: string | undefined,
    qsoId: string,
    body: JsonRecord,
  ) {
    const claims = verifyAccessToken(authorization);
    if (
      !body.requestedBy ||
      !body.reason ||
      !body.proposedValues ||
      typeof body.proposedValues !== 'object' ||
      Array.isArray(body.proposedValues)
    )
      throw new BadRequestException(
        'requestedBy, reason, and proposedValues are required',
      );
    if (
      claims.sub !== body.requestedBy &&
      !claims.scp.some((scope) => ['*', 'activity.admin'].includes(scope))
    )
      throw new ForbiddenException(
        'the correction requester or activity.admin scope is required',
      );
    await this.repository.getQso(qsoId);
    return this.repository.createCorrection(qsoId, body, key);
  }

  async reviewCorrection(
    authorization: string | undefined,
    key: string | undefined,
    qsoId: string,
    correctionId: string,
    body: JsonRecord,
  ) {
    this.authorize(authorization, ['activity.admin']);
    if (!['APPLIED', 'REJECTED'].includes(body.decision) || !body.reviewedBy)
      throw new BadRequestException(
        'decision must be APPLIED or REJECTED and reviewedBy is required',
      );
    return this.repository.reviewCorrection(qsoId, correctionId, body, key);
  }

  async listStatistics(
    authorization: string | undefined,
    query: { programme?: string; page?: string; pageSize?: string },
  ) {
    this.authorize(authorization, ['activity.read', 'activity.admin']);
    const items = await this.repository.listStatistics(query.programme);
    const page = parsePageInteger(query.page, 1);
    const pageSize = Math.min(100, parsePageInteger(query.pageSize, 50));
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      page,
      pageSize,
      total: items.length,
      nextPage: start + pageSize < items.length ? page + 1 : null,
    };
  }

  async createStatisticsRebuild(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    this.authorize(authorization, ['activity.admin']);
    const programmeSlug = body.programmeSlug ?? null;
    const today = new Date().toISOString().slice(0, 10);
    const job = await this.repository.enqueueJob(
      'STATISTICS_REBUILD',
      { programmeSlug },
      key ?? `statistics:${programmeSlug ?? 'all'}:${today}`,
    );
    return { jobId: job.id, ...job };
  }

  async listNotifications(
    authorization: string | undefined,
    query: { recipientId?: string; page?: string; pageSize?: string } = {},
  ) {
    const claims = this.authorize(authorization, [
      'activity.read',
      'identity.me',
    ]);
    const recipient = query.recipientId ?? claims.sub;
    if (
      claims.sub !== recipient &&
      !claims.scp.some((scope) => ['*', 'activity.admin'].includes(scope))
    )
      throw new ForbiddenException(
        'activity.admin scope is required to read another recipient',
      );
    if (query.page === undefined && query.pageSize === undefined)
      return { items: await this.repository.listNotifications(recipient) };
    const page = parsePageInteger(query.page, 1);
    const pageSize = Math.min(100, parsePageInteger(query.pageSize, 50));
    return this.repository.listNotificationPage(recipient, page, pageSize);
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

function decodeBase64(value: string) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new BadRequestException('contentBase64 must be valid base64');
  const content = Buffer.from(value, 'base64');
  if (content.toString('base64') !== value)
    throw new BadRequestException('contentBase64 must be valid base64');
  return content;
}

async function scanUpload(content: Buffer, filename: string) {
  const endpoint = process.env.MYOTA_CLAMAV_URL?.trim();
  if (!endpoint) return;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-upload-name': filename,
      },
      body: new Uint8Array(content),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('malware scanner rejected the upload');
  } catch {
    throw new ServiceUnavailableException(
      'malware scanner is unavailable; upload was not stored',
    );
  }
}

function maskCallsign(value: string) {
  if (value.length <= 3) return '***';
  return `${value.slice(0, 2)}***${value.slice(-1)}`;
}
