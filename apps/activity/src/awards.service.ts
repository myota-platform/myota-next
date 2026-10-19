import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { ActivityRepository } from './activity.repository.js';
import { evaluateAward, validateAwardDraft } from './award-domain.js';
import type { JsonRecord } from './activity-domain.js';

@Injectable()
export class AwardsService {
  private s3Client: S3Client | undefined;

  constructor(private readonly repository: ActivityRepository) {}

  async list(
    authorization: string | undefined,
    query: {
      programme?: string;
      category?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    const claims = authorization ? verifyAccessToken(authorization) : null;
    if (claims) this.authorize(claims.scp, ['awards.read', 'awards.admin']);
    let items = await this.repository.listAwardDefinitions();
    if (!claims) items = items.filter((award) => award.status === 'PUBLISHED');
    if (query.programme)
      items = items.filter((award) => award.programmeSlug === query.programme);
    if (query.category)
      items = items.filter(
        (award) => award.category === query.category?.toUpperCase(),
      );
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

  async get(authorization: string | undefined, id: string) {
    const award = await this.repository.getAwardDefinition(id);
    const claims = authorization ? verifyAccessToken(authorization) : null;
    if (!claims && award.status !== 'PUBLISHED')
      throw new ForbiddenException('only published awards are public');
    if (claims) this.authorize(claims.scp, ['awards.read', 'awards.admin']);
    return award;
  }

  async save(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    let existing: JsonRecord | undefined;
    if (body.awardId) {
      try {
        existing = await this.repository.getAwardDefinition(body.awardId);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
      if (existing && !['DRAFT', 'CHANGES_REQUESTED'].includes(existing.status))
        throw new BadRequestException('only draft awards can be edited');
    }
    const record = validateAwardDraft(body, existing);
    if (record.signatureAssetId) {
      const asset = await this.repository.getAwardAsset(
        String(record.signatureAssetId),
      );
      if (asset.kind !== 'SIGNATURE')
        throw new BadRequestException('choose a registered signature asset');
    }
    return this.repository.saveAwardDefinition(
      record,
      key,
      'awards.definition.saved.v1',
    );
  }

  async patch(
    authorization: string | undefined,
    key: string | undefined,
    id: string,
    body: JsonRecord,
  ) {
    const status = body.status;
    const patch = { ...body };
    delete patch.status;
    if (status === 'UNDER_REVIEW') return this.submit(authorization, id, key);
    if (status === 'APPROVED' || status === 'CHANGES_REQUESTED')
      return this.review(
        authorization,
        id,
        { ...patch, decision: status },
        key,
      );
    if (status === 'PUBLISHED')
      return this.publish(authorization, id, patch, key);
    if (status === 'RETIRED') return this.retire(authorization, id, patch, key);
    const existing = await this.getAwardDefinitionOrThrow(id);
    return this.save(authorization, key, {
      ...existing,
      ...patch,
      awardId: id,
    });
  }

  async submit(authorization: string | undefined, id: string, key?: string) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(id);
    if (!['DRAFT', 'CHANGES_REQUESTED'].includes(award.status))
      throw new BadRequestException('only draft awards can be submitted');
    award.status = 'UNDER_REVIEW';
    award.submittedAt = new Date().toISOString();
    return this.repository.saveAwardDefinition(award, key);
  }

  async review(
    authorization: string | undefined,
    id: string,
    body: JsonRecord,
    key?: string,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(id);
    if (
      !body.reviewerId ||
      award.status !== 'UNDER_REVIEW' ||
      !['APPROVED', 'CHANGES_REQUESTED'].includes(body.decision)
    )
      throw new BadRequestException(
        'award must be under review and decision must be APPROVED or CHANGES_REQUESTED',
      );
    award.status = body.decision;
    award.review = {
      reviewerId: body.reviewerId,
      note: body.note,
      reviewedAt: new Date().toISOString(),
    };
    return this.repository.saveAwardDefinition(award, key);
  }

  async publish(
    authorization: string | undefined,
    id: string,
    body: JsonRecord,
    key?: string,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(id);
    if (!body.effectiveFrom || !body.publisherId)
      throw new BadRequestException(
        'effectiveFrom and publisherId are required',
      );
    if (award.status !== 'APPROVED')
      throw new BadRequestException('only approved awards can be published');
    if (!award.printReadiness?.printReady)
      throw new BadRequestException(
        'background image does not meet the selected A4/Letter print profile',
      );
    const effectiveFrom = new Date(body.effectiveFrom);
    if (!Number.isFinite(effectiveFrom.getTime()))
      throw new BadRequestException('effectiveFrom must be a valid timestamp');
    Object.assign(award, {
      status: 'PUBLISHED',
      effectiveFrom: effectiveFrom.toISOString(),
      publisherId: body.publisherId,
      publishedAt: new Date().toISOString(),
    });
    return this.repository.saveAwardDefinition(
      award,
      key,
      'awards.definition.published.v1',
    );
  }

  async retire(
    authorization: string | undefined,
    id: string,
    body: JsonRecord,
    key?: string,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(id);
    if (!body.retiredAt || !body.retiredBy)
      throw new BadRequestException('retiredAt and retiredBy are required');
    if (!['PUBLISHED', 'APPROVED'].includes(award.status))
      throw new BadRequestException(
        'only published or approved awards can be retired',
      );
    Object.assign(award, {
      status: 'RETIRED',
      retiredAt: body.retiredAt,
      retiredBy: body.retiredBy,
    });
    return this.repository.saveAwardDefinition(award, key);
  }

  async createEvaluationJob(
    authorization: string | undefined,
    key: string | undefined,
    body: JsonRecord,
  ) {
    const claims = verifyAccessToken(authorization);
    if (!body.awardId || !body.subjectId)
      throw new BadRequestException('awardId and subjectId are required');
    let facts = body.facts;
    if (claims.sub !== body.subjectId) {
      this.authorize(claims.scp, [
        'awards.read',
        'awards.request',
        'awards.admin',
      ]);
    } else {
      // Participant self-evaluations always read service-owned aggregates.
      facts = null;
    }
    const award = await this.getAwardDefinitionOrThrow(body.awardId);
    const payload = {
      awardId: award.id,
      subjectId: body.subjectId,
      facts: facts ?? null,
    };
    const job = await this.repository.enqueueJob(
      'AWARD_EVALUATION',
      payload,
      key,
    );
    return { evaluationId: job.id, ...job };
  }

  async getAwardJob(authorization: string | undefined, id: string) {
    const claims = verifyAccessToken(authorization);
    this.authorize(claims.scp, [
      'awards.read',
      'awards.request',
      'awards.admin',
    ]);
    const job = await this.repository.getJob(id);
    const subjectId = job.payload?.subjectId;
    if (subjectId && claims.sub !== subjectId)
      this.authorize(claims.scp, ['awards.read', 'awards.admin']);
    else if (
      !subjectId &&
      !claims.scp.some((scope) => ['*', 'awards.admin'].includes(scope))
    )
      throw new ForbiddenException('awards.admin scope is required');
    return job;
  }

  async progress(
    authorization: string | undefined,
    awardId: string,
    participantId: string,
  ) {
    const claims = verifyAccessToken(authorization);
    if (claims.sub !== participantId)
      this.authorize(claims.scp, ['awards.read', 'awards.admin']);
    else
      this.authorize(claims.scp, [
        'awards.read',
        'awards.request',
        'awards.admin',
        'identity.me',
      ]);
    if (!awardId || !participantId)
      throw new BadRequestException('awardId and participantId are required');
    const award = await this.getAwardDefinitionOrThrow(awardId);
    const facts = await this.repository.subjectFacts(
      award.programmeSlug,
      participantId,
      award.category ?? 'HUNTER',
    );
    const result = evaluateAward(award, participantId, facts);
    await this.repository.saveAwardProgress(
      award,
      participantId,
      facts,
      result,
    );
    return result;
  }

  async recalculate(
    authorization: string | undefined,
    key: string | undefined,
    awardId: string,
    body: JsonRecord,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const award = await this.getAwardDefinitionOrThrow(awardId);
    const subjects = body.subjectIds ?? [];
    if (!Array.isArray(subjects))
      throw new BadRequestException('subjectIds must be an array');
    const sorted = subjects.map(String).sort();
    const jobKey =
      key ??
      `award-recalculate:${award.id}:${award.version ?? 1}:${sorted.join(',')}`;
    const payload = {
      programmeSlug: award.programmeSlug,
      subjectIds: sorted,
      awardId: award.id,
      ruleVersion: award.version ?? 1,
    };
    const job = await this.repository.enqueueJob(
      'AWARD_RECALCULATE',
      payload,
      jobKey,
    );
    return {
      awardId: award.id,
      ruleVersion: award.version ?? 1,
      jobId: job.id,
      ...job,
    };
  }

  async listAssets(
    authorization: string | undefined,
    query: { page?: string; pageSize?: string },
  ) {
    this.authorizeHeader(authorization, ['awards.read', 'awards.admin']);
    const items = await this.repository.listAwardAssets();
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

  async registerAsset(authorization: string | undefined, body: JsonRecord) {
    this.authorizeHeader(authorization, ['awards.admin']);
    for (const field of [
      'kind',
      'name',
      'objectKey',
      'mediaType',
      'widthPx',
      'heightPx',
    ])
      if (
        body[field] === undefined ||
        body[field] === null ||
        body[field] === ''
      )
        throw new BadRequestException(`${field} is required`);
    if (
      !['BACKGROUND', 'SIGNATURE'].includes(body.kind) ||
      !String(body.mediaType).startsWith('image/')
    )
      throw new BadRequestException(
        'asset kind must be BACKGROUND or SIGNATURE and mediaType must be an image',
      );
    const widthPx = positiveInt(String(body.widthPx), 0);
    const heightPx = positiveInt(String(body.heightPx), 0);
    if (!widthPx || !heightPx)
      throw new BadRequestException(
        'asset dimensions must be positive integers',
      );
    const isBackground = body.kind === 'BACKGROUND';
    const asset = {
      id: body.assetId ?? randomUUID(),
      kind: body.kind,
      name: body.name,
      objectKey: body.objectKey,
      mediaType: body.mediaType,
      widthPx,
      heightPx,
      sha256: body.sha256,
      storage: 'S3',
      bucket:
        process.env[
          isBackground
            ? 'MYOTA_AWARD_ASSET_BUCKET'
            : 'MYOTA_AWARD_SIGNATURE_BUCKET'
        ] ?? (isBackground ? 'myota-award-assets' : 'myota-award-signatures'),
      objectStorageEndpoint:
        process.env.MYOTA_OBJECT_STORAGE_PUBLIC_ENDPOINT ??
        process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ??
        'http://seaweedfs:8333',
      contentStatus: 'MISSING',
      createdAt: new Date().toISOString(),
    };
    return this.repository.saveAwardAsset(asset);
  }

  async putAssetContent(
    authorization: string | undefined,
    id: string,
    declaredType: string | undefined,
    content: Buffer,
  ) {
    this.authorizeHeader(authorization, ['awards.admin']);
    const asset = await this.repository.getAwardAsset(id);
    const metadata = await imageMetadata(content);
    if (metadata.mediaType !== declaredType)
      throw new BadRequestException(
        'declared media type does not match image content',
      );
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    if (content.includes(eicar))
      throw new BadRequestException('malware scan rejected the upload');
    await scanWithClamav(content, asset.objectKey);
    const sha256 = createHash('sha256').update(content).digest('hex');
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: asset.bucket,
          Key: asset.objectKey,
          Body: content,
          ContentType: metadata.mediaType,
        }),
      );
    } catch {
      throw new ServiceUnavailableException('object storage upload failed');
    }
    Object.assign(asset, {
      ...metadata,
      contentStatus: 'STORED',
      contentSha256: sha256,
      contentSize: content.length,
      storedAt: new Date().toISOString(),
    });
    return this.repository.saveAwardAsset(asset);
  }

  async getAssetContent(authorization: string | undefined, id: string) {
    this.authorizeHeader(authorization, ['awards.read', 'awards.admin']);
    const asset = await this.repository.getAwardAsset(id);
    try {
      const response = await this.s3().send(
        new GetObjectCommand({ Bucket: asset.bucket, Key: asset.objectKey }),
      );
      if (!response.Body)
        throw new BadRequestException(
          'registered image has no uploaded content',
        );
      const content = Buffer.from(await response.Body.transformToByteArray());
      const metadata = await imageMetadata(content);
      return {
        asset,
        mediaType: metadata.mediaType,
        contentBase64: content.toString('base64'),
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('registered image has no uploaded content');
    }
  }

  private s3() {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
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
    }
    return this.s3Client;
  }

  private async getAwardDefinitionOrThrow(id: string) {
    return this.repository.getAwardDefinition(id);
  }

  private authorizeHeader(authorization: string | undefined, scopes: string[]) {
    const claims = verifyAccessToken(authorization);
    this.authorize(claims.scp, scopes);
  }

  private authorize(granted: string[], scopes: string[]) {
    if (!granted.some((scope) => scope === '*' || scopes.includes(scope)))
      throw new ForbiddenException('award scope is required');
  }
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function imageMetadata(content: Buffer) {
  const maxBytes = boundedEnv(
    'MYOTA_UPLOAD_MAX_BYTES',
    20 * 1024 * 1024,
    1,
    20 * 1024 * 1024,
  );
  if (content.length > maxBytes)
    throw new BadRequestException('image exceeds the configured upload limit');
  try {
    const metadata = await sharp(content, {
      limitInputPixels: 16_000_000,
      failOn: 'error',
    }).metadata();
    if (
      !['png', 'jpeg'].includes(metadata.format ?? '') ||
      !metadata.width ||
      !metadata.height
    )
      throw new BadRequestException(
        'only valid PNG and JPEG images are supported',
      );
    if (metadata.width * metadata.height > 16_000_000)
      throw new BadRequestException('image exceeds the configured pixel limit');
    return {
      mediaType: metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      widthPx: metadata.width,
      heightPx: metadata.height,
    };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('image content is invalid');
  }
}

function boundedEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

async function scanWithClamav(content: Buffer, filename: string) {
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
    if (!response.ok)
      throw new ServiceUnavailableException('malware scanner rejected upload');
  } catch {
    throw new ServiceUnavailableException(
      'malware scanner is unavailable; upload was not stored',
    );
  }
}
