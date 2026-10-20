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
import {
  integerSetting,
  pythonTruthy,
  trimPythonWhitespace,
  verifyAccessToken,
} from '@app/platform';
import { parsePageInteger } from '@app/platform/pagination.js';
import { ActivityRepository } from './activity.repository.js';
import { parseQsoCsv } from './qso-csv.js';
import {
  normalizeActivation,
  normalizeCallsign,
  normalizeQso,
  normalizeTimestamp,
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
    this.authorize(authorization, ['activity.read', 'activity.admin']);
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    return this.repository.listPage(
      query.programme,
      query.operatorId,
      page,
      pageSize,
    );
  }

  async create(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    const activation = normalizeActivation(body);
    const validityDays = Object.hasOwn(body, 'validityDays')
      ? body.validityDays
      : body.programmeRules?.activationValidityDays;
    const missing = [
      'programmeSlug',
      'entityId',
      'operatorId',
      'startedAt',
    ].filter((field) => !pythonTruthy(activation[field]));
    if (missing.length)
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    const claims = verifyAccessToken(authorization);
    if (
      claims.sub !== activation.operatorId &&
      !claims.scp.some((scope) => ['*', 'activity.admin'].includes(scope))
    )
      throw new ForbiddenException(
        'activation operator does not match the authenticated account',
      );
    return this.repository.create({ ...activation, validityDays }, key);
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
    const entityIdValue = body.entityId;
    if (!pythonTruthy(entityIdValue))
      throw new BadRequestException('entityId is required');
    const entityId =
      typeof entityIdValue === 'string' ? entityIdValue : String(entityIdValue);
    const claims = this.authorize(authorization, ['activity.admin']);
    const deletedBy =
      claims.sub ||
      (pythonTruthy(body.deletedBy) ? String(body.deletedBy) : 'administrator');
    return this.repository.cascadeDeleteEntity(entityId, deletedBy, key);
  }

  async addQso(
    authorization: string | undefined,
    key: string | undefined,
    activationId: string,
    body: JsonRecord,
  ) {
    if (!pythonTruthy(body.workedCallsign) || !pythonTruthy(body.timestamp))
      throw new BadRequestException(
        'workedCallsign and timestamp are required',
      );
    const activation = await this.repository.get(activationId);
    const claims = verifyAccessToken(authorization);
    this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    return this.repository.addQso(
      activationId,
      normalizeQso(body, activationId),
      key,
    );
  }

  async close(
    authorization: string | undefined,
    activationId: string,
    body: JsonRecord,
  ) {
    const activation = await this.repository.get(activationId);
    const claims = verifyAccessToken(authorization);
    this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    const endedAt = Object.hasOwn(body, 'endedAt')
      ? body.endedAt
      : normalizeTimestamp(new Date());
    return this.repository.close(activationId, endedAt);
  }

  async enqueueQsoIngestion(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    const missing = ['activationId', 'qsos'].filter(
      (field) => !pythonTruthy(body[field]),
    );
    if (missing.length)
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    const activation = await this.repository.get(body.activationId);
    const claims = verifyAccessToken(authorization);
    this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    if (!Array.isArray(body.qsos) || body.qsos.length === 0)
      throw new BadRequestException('qsos must be a non-empty array');
    const maximum = integerSetting(process.env.MYOTA_MAX_BATCH_QSOS, 5000);
    if (body.qsos.length > maximum)
      throw new BadRequestException(
        'QSO ingestion exceeds the configured limit',
      );
    const sourceFormat = Object.hasOwn(body, 'sourceFormat')
      ? body.sourceFormat
      : 'JSON';
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

  async createAdifImport(authorization: string | undefined, body: JsonRecord) {
    const missing = ['activationId', 'filename', 'contentBase64'].filter(
      (field) => !pythonTruthy(body[field]),
    );
    if (missing.length)
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    const activationId =
      typeof body.activationId === 'string' ? body.activationId : '';
    const filename = typeof body.filename === 'string' ? body.filename : '';
    if (typeof body.contentBase64 !== 'string')
      throw new BadRequestException('contentBase64 must be valid base64');
    const activation = await this.repository.get(activationId);
    const claims = verifyAccessToken(authorization);
    this.authorizeOperator(claims.sub, claims.scp, activation.operatorId);
    const content = decodeBase64(body.contentBase64);
    const maxBytes = integerSetting(
      process.env.MYOTA_UPLOAD_MAX_BYTES,
      25 * 1024 * 1024,
    );
    if (content.length > maxBytes)
      throw new BadRequestException(
        `${filename} exceeds the configured upload limit`,
      );
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    if (content.includes(eicar))
      throw new BadRequestException('malware scan rejected the upload');
    await scanUpload(content, filename);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const bucket = process.env.MYOTA_ADIF_BUCKET ?? 'myota-adif';
    const objectKey = `adif/${activationId}/${randomUUID()}-${filename.replaceAll('/', '_')}`;
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
      created = await this.repository.createAdifImport(activationId, {
        filename,
        objectKey,
        bucket,
        sha256,
        contentSize: content.length,
        scan: { status: 'CLEAN', sha256, size: content.length },
      });
    } catch (error) {
      await this.s3()
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
        .catch(() => undefined);
      throw error;
    }
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
    const pageNumber = parsePageInteger(page, 1);
    const size = parsePageInteger(pageSize, 50, 100);
    const result = await this.repository.listPage(
      programme,
      undefined,
      pageNumber,
      size,
    );
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        operatorCallsign: item.operatorCallsign
          ? maskCallsign(item.operatorCallsign)
          : null,
      })),
    };
  }

  async leaderboard(programme: string, category = 'HUNTER') {
    if (!programme) throw new BadRequestException('programme is required');
    const normalizedCategory = category.toUpperCase();
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
    qsoId: string,
    body: JsonRecord,
  ) {
    if (
      !pythonTruthy(body.requestedBy) ||
      !pythonTruthy(body.reason) ||
      !pythonTruthy(body.proposedValues)
    )
      throw new BadRequestException(
        'requestedBy, reason, and proposedValues are required',
      );
    const claims = verifyAccessToken(authorization);
    if (
      claims.sub !== body.requestedBy &&
      !claims.scp.some((scope) => ['*', 'activity.admin'].includes(scope))
    )
      throw new ForbiddenException(
        'the correction requester or activity.admin scope is required',
      );
    return this.repository.createCorrection(qsoId, body);
  }

  async reviewCorrection(
    authorization: string | undefined,
    qsoId: string,
    correctionId: string,
    body: JsonRecord,
  ) {
    if (!pythonTruthy(body.decision) || !pythonTruthy(body.reviewedBy))
      throw new BadRequestException(
        'missing required fields: decision, reviewedBy',
      );
    this.authorize(authorization, ['activity.admin']);
    if (body.decision !== 'APPLIED' && body.decision !== 'REJECTED')
      throw new BadRequestException('decision must be APPLIED or REJECTED');
    return this.repository.reviewCorrection(qsoId, correctionId, body);
  }

  async listStatistics(
    authorization: string | undefined,
    query: { programme?: string; page?: string; pageSize?: string },
  ) {
    this.authorize(authorization, ['activity.read', 'activity.admin']);
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    return this.repository.listStatisticsPage(query.programme, page, pageSize);
  }

  async createStatisticsRebuild(
    authorization: string | undefined,
    body: JsonRecord,
  ) {
    this.authorize(authorization, ['activity.admin']);
    const programmeSlug = body.programmeSlug ?? null;
    const today = new Date().toISOString().slice(0, 10);
    const job = await this.repository.enqueueJob(
      'STATISTICS_REBUILD',
      { programmeSlug },
      `statistics:${programmeSlug || 'all'}:${today}`,
    );
    return { jobId: job.id, ...job };
  }

  async listNotifications(
    authorization: string | undefined,
    query: { recipientId?: string } = {},
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
    return { items: await this.repository.listNotifications(recipient) };
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
  const endpoint = process.env.MYOTA_CLAMAV_URL
    ? trimPythonWhitespace(process.env.MYOTA_CLAMAV_URL)
    : undefined;
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
  const normalized = normalizeCallsign(value);
  if (normalized.length <= 3) return '***';
  return `${normalized.slice(0, 2)}***${normalized.slice(-1)}`;
}
